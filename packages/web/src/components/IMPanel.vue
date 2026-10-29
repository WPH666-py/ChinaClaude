<script setup lang="ts">
/**
 * 消息通道 — 把进展推到 IM 群。
 *
 * WHY ONLY THREE CHANNELS AND WHY THEY ARE WEBHOOKS: the upstream plugin runs official bots with
 * long-lived connections and per-chat session binding; that is a separate product. An incoming webhook is
 * the part a team can use on day one, and it is the only part that needs no SDK at all.
 *
 * WHY THE SAVED ENDPOINT IS SHOWN MASKED: a webhook URL is a bearer credential. The panel only needs to
 * recognise WHICH group, so it shows the host and a digest — the token never comes back from the bridge.
 */
import { onMounted, ref } from 'vue'
import ShellDialog from './ShellDialog.vue'

interface ImChannel {
  id: string
  name: string
  host: string
  pathHint: string
  docs: string
  hint: string
  configured: boolean
  masked: string | null
  hasSecret: boolean
}

interface ImRow extends ImChannel {
  unsupported?: { name: string; reason: string }[]
}

const emit = defineEmits<{ (e: 'close'): void }>()

function resolveBaseUrl(): string {
  const injected = (globalThis as Record<string, unknown>).__CCCN_BRIDGE_URL__
  if (typeof injected === 'string' && injected.length > 0) return injected.replace(/\/$/, '')
  const param = new URLSearchParams(location.search).get('bridge')
  if (param) return param.replace(/\/$/, '')
  return import.meta.env.DEV ? '' : 'http://127.0.0.1:43130'
}

const baseUrl = resolveBaseUrl()
const channels = ref<ImChannel[]>([])
const unsupported = ref<{ name: string; reason: string }[]>([])
const loading = ref(true)

const drafts = ref<Record<string, { webhook: string; secret: string }>>({})
const notices = ref<Record<string, { kind: 'ok' | 'error'; text: string } | null>>({})
const busy = ref<Record<string, boolean>>({})

/** 机器人（长轮询 / sync）：与 webhook 不同的接入方式，因此单独一块。 */
interface BotRow {
  id: string
  channel: string
  label: string
  homeserver: string | null
  tokenMask: string
  allowedChats: string[]
  sessionId: string | null
  running: boolean
  lastError: string | null
}
const bots = ref<BotRow[]>([])
const botChannels = ref<{ id: string; name: string }[]>([])
const botUnsupported = ref<{ name: string; reason: string }[]>([])
const botDraft = ref({ channel: 'telegram', token: '', homeserver: '', label: '' })
const botNotice = ref<{ kind: 'ok' | 'error'; text: string } | null>(null)
const botBusy = ref(false)

async function call(path: string, body?: unknown) {
  const response = body === undefined
    ? await fetch(`${baseUrl}${path}`)
    : await fetch(`${baseUrl}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  return (await response.json()) as {
    ok: boolean
    error?: string
    channels?: ImChannel[]
    unsupported?: { name: string; reason: string }[]
    bots?: BotRow[]
  }
}

function say(id: string, kind: 'ok' | 'error', text: string) {
  notices.value = { ...notices.value, [id]: { kind, text } }
}

async function load() {
  loading.value = true
  const answer = await call('/api/im')
  channels.value = answer.channels ?? []
  unsupported.value = answer.unsupported ?? []
  const botAnswer = (await call('/api/im/bots')) as { channels?: { id: string; name: string }[]; bots?: BotRow[]; unsupported?: { name: string; reason: string }[] }
  botChannels.value = botAnswer.channels ?? []
  bots.value = botAnswer.bots ?? []
  botUnsupported.value = botAnswer.unsupported ?? []
  loading.value = false
}

async function botAction(body: Record<string, unknown>, okText: string) {
  botBusy.value = true
  const answer = await call('/api/im/bots', body)
  botBusy.value = false
  botNotice.value = { kind: answer.ok ? 'ok' : 'error', text: answer.ok ? okText : answer.error ?? '操作失败' }
  await load()
}

async function saveBot() {
  await botAction(
    { action: 'save', channel: botDraft.value.channel, token: botDraft.value.token, homeserver: botDraft.value.homeserver, label: botDraft.value.label },
    '机器人已保存（Token 只存本机，界面只显示掩码）',
  )
  botDraft.value.token = ''
}

function draftFor(id: string) {
  return drafts.value[id] ?? { webhook: '', secret: '' }
}

function setDraft(id: string, patch: Partial<{ webhook: string; secret: string }>) {
  drafts.value = { ...drafts.value, [id]: { ...draftFor(id), ...patch } }
}

async function save(channel: ImChannel) {
  busy.value = { ...busy.value, [channel.id]: true }
  const draft = draftFor(channel.id)
  const answer = await call('/api/im', { action: 'save', id: channel.id, webhook: draft.webhook, secret: draft.secret })
  busy.value = { ...busy.value, [channel.id]: false }
  if (!answer.ok) {
    say(channel.id, 'error', answer.error ?? '保存失败')
    return
  }
  setDraft(channel.id, { webhook: '' })
  say(channel.id, 'ok', '已保存（地址只存本机，界面只显示掩码）')
  await load()
}

async function test(channel: ImChannel) {
  busy.value = { ...busy.value, [channel.id]: true }
  const answer = await call('/api/im', { action: 'test', id: channel.id })
  busy.value = { ...busy.value, [channel.id]: false }
  say(channel.id, answer.ok ? 'ok' : 'error', answer.ok ? '测试消息已发出，去群里看一眼' : answer.error ?? '发送失败')
}

onMounted(load)
</script>

<template>
  <ShellDialog title="消息通道" meta="Webhook 推送 · 企微 / 飞书 / 钉钉 / Slack / Discord" :width="820" @close="emit('close')">
    <p v-if="loading" class="im__muted">读取中…</p>

    <section v-for="channel in channels" :key="channel.id" class="im__card">
      <header class="im__head">
        <strong class="im__name">{{ channel.name }}</strong>
        <span class="im__state" :class="channel.configured ? 'im__state--on' : ''">
          {{ channel.configured ? '已配置' : '未配置' }}
        </span>
        <a class="im__docs" :href="channel.docs" target="_blank" rel="noreferrer">接入文档</a>
      </header>

      <p class="im__hint">{{ channel.hint }}<template v-if="channel.configured"> 当前：<code>{{ channel.masked }}</code></template></p>

      <div class="im__form">
        <input
          class="im__input"
          :placeholder="`Webhook（https://${channel.host}${channel.pathHint}）`"
          :value="draftFor(channel.id).webhook"
          spellcheck="false"
          autocomplete="off"
          @input="setDraft(channel.id, { webhook: ($event.target as HTMLInputElement).value })"
        />
        <input
          v-if="channel.id === 'dingtalk'"
          class="im__input im__input--short"
          placeholder="加签密钥（可选）"
          :value="draftFor(channel.id).secret"
          spellcheck="false"
          autocomplete="off"
          @input="setDraft(channel.id, { secret: ($event.target as HTMLInputElement).value })"
        />
        <button class="im__btn im__btn--primary" type="button" :disabled="busy[channel.id]" @click="save(channel)">保存</button>
        <button class="im__btn" type="button" :disabled="busy[channel.id] || !channel.configured" @click="test(channel)">发测试消息</button>
      </div>

      <p v-if="notices[channel.id]" class="im__notice" :class="`im__notice--${notices[channel.id]?.kind}`">
        {{ notices[channel.id]?.text }}
      </p>
    </section>

    <p v-if="unsupported.length > 0" class="im__muted">
      本版未接入：{{ unsupported.map((item) => item.name).join('、') }} —— {{ unsupported[0]?.reason }}。
    </p>

    <!-- 机器人：Telegram 长轮询 / Matrix sync -->
    <section class="im__card">
      <header class="im__head">
        <strong class="im__name">机器人（长连接）</strong>
        <span class="im__state">Telegram / Matrix</span>
      </header>
      <p class="im__hint">
        桌面应用没有公网地址，所以机器人不用 webhook，而是 Telegram 的 getUpdates 长轮询与 Matrix 的 /sync。
        每条消息会转给该聊天绑定的会话；没有绑定时会明确回复「还没绑定」，不会猜一个会话。
      </p>

      <div v-for="bot in bots" :key="bot.id" class="im__form">
        <span class="im__name">{{ bot.label }}</span>
        <code class="im__hint">{{ bot.channel }} · {{ bot.tokenMask }}</code>
        <span class="im__state" :class="bot.running ? 'im__state--on' : ''">{{ bot.running ? '运行中' : '已停止' }}</span>
        <span class="im__hint">{{ bot.sessionId ? `绑定会话 ${bot.sessionId}` : '未绑定会话' }}</span>
        <button class="im__btn" type="button" :disabled="botBusy" @click="botAction({ action: bot.running ? 'stop' : 'start', id: bot.id }, bot.running ? '已停止' : '已启动')">
          {{ bot.running ? '停止' : '启动' }}
        </button>
        <button class="im__btn" type="button" :disabled="botBusy" @click="botAction({ action: 'remove', id: bot.id }, '已移除')">移除</button>
        <span v-if="bot.lastError" class="im__notice im__notice--error">{{ bot.lastError }}</span>
      </div>

      <div class="im__form">
        <select v-model="botDraft.channel" class="im__input im__input--short" :disabled="botBusy">
          <option v-for="channel in botChannels" :key="channel.id" :value="channel.id">{{ channel.name }}</option>
        </select>
        <input v-model="botDraft.label" class="im__input im__input--short" placeholder="备注名（可选）" spellcheck="false" />
        <input
          v-if="botDraft.channel === 'matrix'"
          v-model="botDraft.homeserver"
          class="im__input"
          placeholder="https://matrix.example.org"
          spellcheck="false"
        />
        <input v-model="botDraft.token" class="im__input" placeholder="Bot Token / 访问令牌" spellcheck="false" autocomplete="off" />
        <button class="im__btn im__btn--primary" type="button" :disabled="botBusy" @click="saveBot">保存机器人</button>
      </div>

      <p v-if="botNotice" class="im__notice" :class="`im__notice--${botNotice.kind}`">{{ botNotice.text }}</p>
      <p v-if="botUnsupported.length > 0" class="im__muted">
        未接入：{{ botUnsupported.map((item) => item.name).join('、') }} —— {{ botUnsupported[0]?.reason }}。
      </p>
    </section>
  </ShellDialog>
</template>

<style scoped>
.im__card {
  margin-bottom: 10px;
  padding: 10px 12px;
  border: 0.5px solid var(--dsw-alias-border-l1);
  border-radius: 10px;
  background: var(--dsw-alias-bg-layer-1);
}

.im__head {
  display: flex;
  align-items: center;
  gap: 8px;
}

.im__name {
  color: var(--dsw-alias-label-primary);
  font-size: 13px;
}

.im__state {
  padding: 1px 7px;
  border-radius: 999px;
  background: var(--dsw-alias-interactive-bg-hover);
  color: var(--dsw-alias-label-tertiary);
  font-size: 11px;
}

.im__state--on {
  color: var(--dsw-alias-label-primary);
}

.im__docs {
  margin-left: auto;
  color: var(--dsw-alias-label-tertiary);
  font-size: 11px;
  text-decoration: none;
}

.im__hint {
  margin: 6px 0;
  color: var(--dsw-alias-label-tertiary);
  font-size: 11.5px;
  line-height: 1.6;
}

.im__hint code {
  font-family: var(--dsw-font-family-code);
}

.im__form {
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
}

.im__input {
  flex: 1;
  min-width: 220px;
  padding: 5px 8px;
  border: 0.5px solid var(--dsw-alias-border-l1);
  border-radius: 7px;
  background: var(--dsw-alias-bg-layer-2);
  color: var(--dsw-alias-label-primary);
  font-family: var(--dsw-font-family-code);
  font-size: 11.5px;
}

.im__input--short {
  flex: 0 0 180px;
}

.im__btn {
  padding: 4px 10px;
  border: 0.5px solid var(--dsw-alias-border-l1);
  border-radius: 7px;
  color: var(--dsw-alias-label-secondary);
  font-size: 12px;
}

.im__btn:hover:not(:disabled) {
  background: var(--dsw-alias-interactive-bg-hover);
  color: var(--dsw-alias-label-primary);
}

.im__btn:disabled {
  opacity: 0.5;
}

.im__btn--primary {
  background: var(--dsw-alias-interactive-bg-hover);
  color: var(--dsw-alias-label-primary);
}

.im__notice {
  margin: 8px 0 0;
  font-size: 12px;
}

.im__notice--ok {
  color: var(--dsw-alias-label-secondary);
}

.im__notice--error {
  color: var(--dsw-alias-state-error-primary);
}

.im__muted {
  color: var(--dsw-alias-label-tertiary);
  font-size: 11.5px;
  line-height: 1.6;
}
</style>
