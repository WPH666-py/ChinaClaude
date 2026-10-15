<script setup lang="ts">
/**
 * 手机访问：让同一局域网里的手机浏览器驱动这台电脑上的桥接进程。
 *
 * WHAT THIS PANEL HAS TO GET ACROSS, because the feature is genuinely dangerous if misunderstood:
 * the bridge can run tools with `bypassPermissions`, so a reachable port is remote code execution for
 * anyone who can reach it. Two facts therefore drive every line of copy here:
 *
 *   1. The port is CLOSED until the user opens it. Default-off is the safety property, so "关闭"
 *      must always look like the resting state, not like a thing that failed.
 *   2. Turning it on does nothing until restart, because the listen address is fixed when the socket
 *      opens. A toggle that silently appears to work is worse than one that says "restart", so the
 *      pending-restart state is shown explicitly rather than hidden behind the switch.
 *
 * A pairing code is deliberately shown as a READABLE 6-digit number rather than a URL with a token:
 * it has to be typed on a phone keyboard, and a code the user reads off their own screen is
 * something they can verify. The bridge only mints it for a loopback caller, so a phone cannot issue
 * its own way in.
 */
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import type { Bridge } from '../composables/useBridge'
import type { RemoteStatus, WechatStatus } from '../types'

const props = defineProps<{ bridge: Bridge }>()

const status = ref<RemoteStatus | null>(null)
const busy = ref(false)
const error = ref<string | null>(null)
const note = ref<string | null>(null)

/** The live pairing code, if one is outstanding. Never persisted anywhere. */
const pair = ref<{ code: string; expiresAt: number; url: string | null } | null>(null)
const now = ref(Date.now())
let ticker: ReturnType<typeof setInterval> | null = null

/**
 * 微信通知（企业微信群机器人）: a SEPARATE concern from LAN exposure, but it lives here because it is
 * the other half of "reach me when I am away from the machine". The webhook is a credential, so the
 * bridge only ever sends back its MASKED form; the input below holds a fresh URL the user is pasting
 * in, never the stored one.
 */
const wechat = ref<WechatStatus | null>(null)
const webhookDraft = ref('')
const wechatBusy = ref(false)
const wechatError = ref<string | null>(null)
const wechatNote = ref<string | null>(null)

/** Seconds left on the current code, 0 when there is none or it has expired. */
const remaining = computed(() => (pair.value ? Math.max(0, Math.ceil((pair.value.expiresAt - now.value) / 1000)) : 0))

/**
 * `enabled` is the saved intent, `active` is whether the socket is actually on the network yet.
 * They differ only across a restart boundary — which is exactly when the user needs to be told.
 */
const needsRestart = computed(() => Boolean(status.value && status.value.enabled !== status.value.active))

/**
 * A code is only worth minting once the socket is really reachable. Before the restart it would be a
 * number the user types into a phone that cannot connect, and it would not survive the restart that
 * made it usable.
 */
const canPair = computed(() => Boolean(status.value?.enabled && status.value?.active))

/** The port the bridge is on, read back off the reported URL so both stay in agreement. */
const port = computed(() => {
  const url = status.value?.url
  if (!url) return null
  const match = /:(\d+)$/.exec(url)
  return match ? match[1] : null
})

/** Every address a phone could point at, with its adapter name. */
const addresses = computed(() =>
  (status.value?.addresses ?? []).map((entry) => ({
    ...entry,
    url: port.value ? `http://${entry.address}:${port.value}` : null,
  })),
)

// The countdown is the only thing here that changes on its own, so the interval exists only while a
// code is outstanding — a settings page left open should not tick a timer forever.
function startTicker() {
  if (ticker) return
  ticker = setInterval(() => {
    now.value = Date.now()
    if (!pair.value || remaining.value <= 0) stopTicker()
  }, 1000)
}

function stopTicker() {
  if (!ticker) return
  clearInterval(ticker)
  ticker = null
}

async function load() {
  error.value = null
  try {
    status.value = await props.bridge.remoteStatus()
  } catch (cause) {
    error.value = String((cause as Error).message ?? cause)
  }
  try {
    wechat.value = await props.bridge.wechatStatus()
  } catch (cause) {
    wechatError.value = String((cause as Error).message ?? cause)
  }
}

onMounted(load)
onBeforeUnmount(stopTicker)

async function toggle(next: boolean) {
  busy.value = true
  error.value = null
  note.value = null
  try {
    const result = await props.bridge.setRemoteEnabled(next)
    status.value = { ...result }
    // Closing the door drops every paired device; saying so avoids the "why is my phone suddenly
    // logged out" question, and an open pairing code is invalidated with them.
    if (!next) {
      pair.value = null
      stopTicker()
      note.value = '局域网访问已关闭，已配对的手机会立即失效。'
    } else {
      note.value = '已保存。请重启应用后手机才能连上。'
    }
  } catch (cause) {
    error.value = String((cause as Error).message ?? cause)
  } finally {
    busy.value = false
  }
}

async function generate() {
  busy.value = true
  error.value = null
  try {
    const issued = await props.bridge.issuePairCode()
    pair.value = { code: issued.code, expiresAt: issued.expiresAt, url: issued.url }
    now.value = Date.now()
    startTicker()
  } catch (cause) {
    error.value = String((cause as Error).message ?? cause)
  } finally {
    busy.value = false
  }
}

async function revoke() {
  busy.value = true
  error.value = null
  try {
    status.value = await props.bridge.revokePairedDevices()
    pair.value = null
    stopTicker()
    note.value = '已解除全部配对设备，之前发出去的凭据全部失效。'
  } catch (cause) {
    error.value = String((cause as Error).message ?? cause)
  } finally {
    busy.value = false
  }
}

/**
 * Shared plumbing for the three 微信 actions below: they are all best-effort form submissions whose
 * failure is shown inline rather than thrown, so they can reuse one busy/error/note discipline.
 */
async function runWechat(action: () => Promise<WechatStatus>, successNote: string) {
  wechatBusy.value = true
  wechatError.value = null
  wechatNote.value = null
  try {
    const result = await action()
    if (result.ok === false) {
      wechatError.value = result.error ?? '操作失败'
      return
    }
    wechat.value = result
    wechatNote.value = successNote
  } catch (cause) {
    wechatError.value = String((cause as Error).message ?? cause)
  } finally {
    wechatBusy.value = false
  }
}

/** Save a freshly pasted webhook URL. The draft is cleared on success so the secret does not linger. */
function saveWebhook() {
  return runWechat(async () => {
    const result = await props.bridge.configureWechat({ webhookUrl: webhookDraft.value })
    if (result.ok !== false) webhookDraft.value = ''
    return result
  }, '已保存机器人地址。')
}

function toggleWechat(next: boolean) {
  return runWechat(() => props.bridge.configureWechat({ enabled: next }), next ? '微信通知已开启。' : '微信通知已关闭。')
}

function toggleNotify(next: boolean) {
  return runWechat(() => props.bridge.configureWechat({ notifyOnFinish: next }), '已更新推送时机。')
}

/**
 * Send a test message. A draft URL, if present, is tried AND saved on success, so the user does not
 * have to save a possibly-wrong credential just to find out whether it works.
 */
async function testSend() {
  const draft = webhookDraft.value
  wechatBusy.value = true
  wechatError.value = null
  wechatNote.value = null
  try {
    const result = await props.bridge.testWechat(draft || undefined)
    if (!result.ok) {
      wechatError.value = result.error ?? '测试消息发送失败'
      return
    }
    wechatNote.value = '测试消息已发送，请查看企业微信群。'
    // A successful test also stored and enabled the draft, so reflect that.
    if (draft) webhookDraft.value = ''
    wechat.value = await props.bridge.wechatStatus()
  } catch (cause) {
    wechatError.value = String((cause as Error).message ?? cause)
  } finally {
    wechatBusy.value = false
  }
}

/** Best-effort copy; a failure here is not worth an error banner, the text is selectable anyway. */
async function copy(text: string) {
  try {
    await navigator.clipboard.writeText(text)
    note.value = '已复制。'
  } catch {
    note.value = '复制失败，请手动选择文本。'
  }
}
</script>

<template>
  <h3 class="st__h">手机访问</h3>
  <p class="st__sub">
    在同一 Wi-Fi 下用手机浏览器打开本机地址，即可用现有界面查看和继续会话。微信内置浏览器同样可用。
  </p>

  <p v-if="error" class="st__hint st__hint--error">{{ error }}</p>
  <p v-else-if="note" class="st__hint st__hint--ok">{{ note }}</p>

  <!-- ------------------------------------------------------------ switch -- -->
  <div class="st__field st__field--boxed">
    <label class="rp__check">
      <input
        type="checkbox"
        :checked="Boolean(status?.enabled)"
        :disabled="busy || !status"
        @change="toggle(($event.target as HTMLInputElement).checked)"
      />
      <span>开启局域网访问</span>
    </label>
    <p class="st__hint" style="margin-top: 8px">
      默认关闭。开启后本机会在该网络上监听一个端口，任何能访问该端口的设备都必须先用配对码换取凭据，否则一律拒绝。
    </p>

    <p v-if="needsRestart" class="st__hint rp__warn">
      监听地址在启动时确定，因此设置要到<strong>重启应用</strong>后才生效。当前实际状态：{{ status?.active ? '已在局域网监听' : '仅本机可访问' }}。
    </p>
    <p v-else-if="status?.enabled && status?.active" class="st__hint st__hint--ok">
      正在局域网监听。手机可直接访问下面的地址。
    </p>
  </div>

  <!-- ----------------------------------------------------------- address -- -->
  <div class="st__field">
    <label class="st__label">手机访问地址</label>

    <template v-if="addresses.length">
      <ul class="rp__list">
        <li v-for="entry in addresses" :key="entry.address" class="rp__addr">
          <div class="rp__addrMain">
            <code class="rp__url">{{ entry.url ?? entry.address }}</code>
            <span class="rp__addrName">
              {{ entry.name }}
              <em v-if="entry.virtual" class="rp__tag">虚拟网卡</em>
            </span>
          </div>
          <button v-if="entry.url" class="tinyButton tinyButton--text" type="button" @click="copy(entry.url)">复制</button>
        </li>
      </ul>
      <p class="st__hint">
        本机有多个网卡时会有多个地址，手机与电脑连着同一个 Wi-Fi 时，通常是最上面的那个。标为「虚拟网卡」的
        一般是虚拟机或 VPN 的地址，手机连不上。
      </p>
    </template>
    <p v-else class="st__hint" style="margin-top: 0">未检测到局域网地址，请确认电脑已连上 Wi-Fi 或有线网络。</p>
  </div>

  <!-- -------------------------------------------------------- pair code -- -->
  <div class="st__field st__field--boxed">
    <label class="st__label">配对码</label>

    <div v-if="pair && remaining > 0" class="rp__codeWrap">
      <span class="rp__code">{{ pair.code }}</span>
      <span class="rp__countdown">剩余 {{ remaining }} 秒</span>
    </div>
    <p v-else class="st__hint" style="margin-top: 0">
      生成一个 6 位配对码，在手机上打开上面的地址后输入它，即可让这台手机获得访问权。配对码 5 分钟内有效、只能用一次。
    </p>

    <div class="rp__row">
      <button class="tinyButton tinyButton--primary" type="button" :disabled="busy || !canPair" @click="generate">
        {{ pair && remaining > 0 ? '重新生成' : '生成配对码' }}
      </button>
      <span v-if="!canPair" class="st__hint" style="margin: 0">
        {{ status?.enabled ? '重启应用后可用' : '请先开启局域网访问' }}
      </span>
    </div>
  </div>

  <!-- -------------------------------------------------------- paired set -- -->
  <div class="st__field">
    <label class="st__label">已配对设备</label>
    <p class="st__hint" style="margin-top: 0">当前有 {{ status?.pairedDevices ?? 0 }} 台设备持有有效凭据（最多保留 5 台）。</p>
    <div class="rp__row">
      <button class="tinyButton tinyButton--text" type="button" :disabled="busy || !status?.pairedDevices" @click="revoke">
        解除全部配对
      </button>
    </div>
    <p class="st__hint">手机丢失或借给别人后，用它一次性让所有配对失效；之后需要重新输入配对码。</p>
  </div>

  <!-- ------------------------------------------------------ wechat push -- -->
  <div class="st__field st__field--boxed">
    <label class="st__label">微信通知（企业微信群机器人）</label>
    <p class="st__hint" style="margin-top: 0">
      在群里加一个「群机器人」，把它的 Webhook 地址粘到这里，会话结束时本机会往群里推一条消息。机器人由本机主动出站发送，
      不需要手机在线，也不需要公网或域名。群里的显示名可在企业微信里自行设置（本项目建议叫 ChinaClaude-Mobot）。
    </p>

    <p v-if="wechatError" class="st__hint st__hint--error">{{ wechatError }}</p>
    <p v-else-if="wechatNote" class="st__hint st__hint--ok">{{ wechatNote }}</p>

    <p v-if="wechat?.configured" class="st__hint">
      当前机器人：<code class="rp__url">{{ wechat.webhookMasked }}</code>
    </p>

    <label class="rp__check" style="margin-top: 8px">
      <input
        type="checkbox"
        :checked="Boolean(wechat?.enabled)"
        :disabled="wechatBusy || !wechat?.configured"
        @change="toggleWechat(($event.target as HTMLInputElement).checked)"
      />
      <span>开启微信通知</span>
    </label>
    <p v-if="!wechat?.configured" class="st__hint" style="margin-top: 4px">请先粘贴并保存机器人地址。</p>

    <label class="rp__check" style="margin-top: 8px">
      <input
        type="checkbox"
        :checked="Boolean(wechat?.notifyOnFinish)"
        :disabled="wechatBusy || !wechat?.configured"
        @change="toggleNotify(($event.target as HTMLInputElement).checked)"
      />
      <span>会话结束时推送</span>
    </label>

    <div class="st__field" style="margin-top: 12px">
      <label class="st__label">机器人 Webhook 地址</label>
      <input
        v-model="webhookDraft"
        class="rp__input"
        type="password"
        autocomplete="off"
        spellcheck="false"
        placeholder="https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=…"
        :disabled="wechatBusy"
      />
      <div class="rp__row">
        <button class="tinyButton tinyButton--primary" type="button" :disabled="wechatBusy || !webhookDraft.trim()" @click="saveWebhook">
          保存地址
        </button>
        <button class="tinyButton tinyButton--text" type="button" :disabled="wechatBusy || (!webhookDraft.trim() && !wechat?.configured)" @click="testSend">
          发送测试消息
        </button>
      </div>
      <p class="st__hint">
        地址里含密钥，等同于群里的发言权限，因此只保存在这台电脑上，界面上只回显打码后的样子。测试消息会顺带把地址保存并开启推送。
      </p>
    </div>
  </div>

  <!-- ----------------------------------------------------------- warning -- -->
  <div class="st__field">
    <label class="st__label">安全说明</label>
    <p class="st__hint" style="margin-top: 0">
      这里走的是明文 HTTP，同一网络内有人抓包就可能拿到凭据。因此请只在可信的家庭或办公网络下开启，不要在咖啡厅、酒店等公共网络上使用。
      本机自身的访问不需要配对，配对码也只在电脑端生成。
    </p>
  </div>
</template>

<style scoped>
/* The checkbox and the action row are local, matching the other child panels: settings primitives
   that are shared live in styles.css, while anything used by one panel stays in it. */
.rp__check {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  color: var(--dsw-alias-label-secondary);
  font-size: 13px;
  line-height: 20px;
  cursor: pointer;
}

.rp__check input {
  margin-top: 2px;
}

.rp__row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  margin-top: 8px;
}

/* Mirrors the shared `.st__input` styling, kept local because that class is scoped to SettingsPanel. */
.rp__input {
  width: 100%;
  min-width: 0;
  padding: 7px 11px;
  border: 0.5px solid var(--dsw-alias-border-l2);
  border-radius: 8px;
  background: var(--dsw-static-neutral-bluish-900);
  outline: none;
  color: var(--dsw-alias-label-primary);
  font-size: 12.5px;
  font-family: var(--dsw-font-family-code);
}

.rp__input:focus {
  border-color: var(--dsw-alias-state-business-primary);
}

.rp__warn {
  color: var(--dsw-alias-state-warn-primary);
}

.rp__list {
  margin: 0;
  padding: 0;
  list-style: none;
  border: 0.5px solid var(--dsw-alias-border-l1);
  border-radius: 10px;
  overflow: hidden;
}

.rp__addr {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 9px 12px;
  background: var(--dsw-alias-bg-layer-1);
}

.rp__addr + .rp__addr {
  border-top: 0.5px solid var(--dsw-alias-border-l1);
}

.rp__addrMain {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
  flex: 1 1 auto;
}

.rp__url {
  font-family: var(--dsw-font-family-code);
  font-size: 13px;
  color: var(--dsw-alias-label-primary);
  word-break: break-all;
}

.rp__addrName {
  color: var(--dsw-alias-label-caption);
  font-size: 11.5px;
}

.rp__tag {
  margin-left: 6px;
  padding: 1px 6px;
  border-radius: 5px;
  background: var(--dsw-alias-bg-layer-2);
  font-style: normal;
  font-size: 10.5px;
}

.rp__codeWrap {
  display: flex;
  align-items: baseline;
  gap: 12px;
  margin: 2px 0 4px;
}

.rp__code {
  font-family: var(--dsw-font-family-code);
  font-size: 30px;
  font-weight: 600;
  letter-spacing: 0.24em;
  color: var(--dsw-alias-label-primary);
}

.rp__countdown {
  color: var(--dsw-alias-label-caption);
  font-size: 12px;
}
</style>
