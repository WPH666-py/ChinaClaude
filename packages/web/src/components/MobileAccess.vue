<script setup lang="ts">
/**
 * 移动访问：一个窗口完成「开开关 → 出二维码 → 手机扫」。
 *
 * 和设置里的「手机访问」不是重复功能：设置里是配置项（开/关、地址、配对码），这里是把配置的
 * 结果直接变成一个可以扫的东西。手机扫码后 URL 自带配对码，GET /pair?code=… 直接种 cookie，
 * 手机上不需要再输入六位数字。
 */
import { computed, onMounted, ref } from 'vue'

/**
 * 桥的地址：桌面端由 __CCCN_BRIDGE_URL__ 注入。
 *
 * 必须用绝对地址：相对路径会被 webview 解析到它自己的 asset 源，回来的是 index.html，
 * 于是 JSON.parse 报 “Unexpected token '<'”，看起来像「保存失败」。
 */
function resolveBaseUrl(): string {
  const injected = (globalThis as Record<string, unknown>).__CCCN_BRIDGE_URL__
  if (typeof injected === 'string' && injected.length > 0) return injected.replace(/\/$/, '')
  const param = new URLSearchParams(location.search).get('bridge')
  if (param) return param.replace(/\/$/, '')
  return import.meta.env.DEV ? '' : 'http://127.0.0.1:43130'
}

const baseUrl = resolveBaseUrl()

const emit = defineEmits<{ (e: 'close'): void; (e: 'open-settings'): void }>()

interface RemoteStatus {
  enabled?: boolean
  active?: boolean
  loopback?: boolean
  urls?: string[]
  url?: string
}

const status = ref<RemoteStatus>({})
const enabled = ref(false)
const active = ref(false)
const loading = ref(false)
const busy = ref(false)
const error = ref('')
const note = ref('')

const code = ref('')
const link = ref('')
const svg = ref('')
const expiresAt = ref<number | null>(null)
const copied = ref(false)

const canScan = computed(() => enabled.value && active.value)
const qrSrc = computed(() => (svg.value ? `data:image/svg+xml;utf8,${encodeURIComponent(svg.value)}` : ''))

async function refresh() {
  loading.value = true
  error.value = ''
  try {
    const response = await fetch(`${baseUrl}/api/remote`)
    const data = (await response.json()) as RemoteStatus
    status.value = data
    enabled.value = data.enabled === true
    active.value = data.active === true
    if (canScan.value && link.value === '') await regenerate()
  } catch (cause) {
    error.value = `读取手机访问状态失败：${(cause as Error).message}`
  } finally {
    loading.value = false
  }
}

async function toggle(next: boolean) {
  busy.value = true
  error.value = ''
  try {
    const response = await fetch(`${baseUrl}/api/remote`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ enabled: next }),
    })
    const data = (await response.json()) as { error?: string; enabled?: boolean; restartRequired?: boolean }
    if (!response.ok) throw new Error(data.error ?? `HTTP ${response.status}`)
    enabled.value = data.enabled === true
    note.value = data.restartRequired ? '开关已保存，重启应用后生效。' : ''
    if (!enabled.value) {
      link.value = ''
      svg.value = ''
      code.value = ''
    }
  } catch (cause) {
    error.value = `保存失败：${(cause as Error).message}`
  } finally {
    busy.value = false
  }
}

async function regenerate() {
  busy.value = true
  error.value = ''
  try {
    const response = await fetch(`${baseUrl}/api/remote/scan`, { method: 'POST' })
    const data = (await response.json()) as {
      error?: string
      svg?: string
      link?: string
      code?: string
      expiresAt?: number | null
    }
    if (!response.ok || !data.svg) throw new Error(data.error ?? `HTTP ${response.status}`)
    svg.value = data.svg
    link.value = data.link ?? ''
    code.value = data.code ?? ''
    expiresAt.value = data.expiresAt ?? null
  } catch (cause) {
    error.value = `生成二维码失败：${(cause as Error).message}`
  } finally {
    busy.value = false
  }
}

async function copy() {
  if (!link.value) return
  try {
    await navigator.clipboard.writeText(link.value)
    copied.value = true
    window.setTimeout(() => {
      copied.value = false
    }, 1500)
  } catch {
    error.value = '复制失败：浏览器不允许写剪贴板，可以手动选中链接复制。'
  }
}

onMounted(refresh)
</script>

<template>
  <div class="ma">
    <header class="ma__head">
      <h1 class="ma__title">移动访问</h1>
      <p class="ma__sub">同一个 Wi-Fi 下，用手机扫下面的二维码即可打开并继续这台电脑上的会话。</p>
      <button class="ma__close" type="button" @click="emit('close')">关闭</button>
    </header>

    <p v-if="error" class="ma__error">{{ error }}</p>
    <p v-if="note" class="ma__note">{{ note }}</p>

    <section class="ma__card">
      <label class="ma__toggle">
        <input type="checkbox" :checked="enabled" :disabled="busy" @change="toggle(($event.target as HTMLInputElement).checked)" />
        <span>局域网访问</span>
      </label>
      <span class="ma__state">{{ enabled ? (active ? '已开启' : '已保存，重启后生效') : '未开启' }}</span>
    </section>

    <section v-if="enabled" class="ma__card ma__card--qr">
      <img v-if="qrSrc" class="ma__qr" :src="qrSrc" alt="手机访问二维码" width="260" height="260" />
      <p v-else class="ma__hint">{{ loading ? '正在读取状态…' : '点「生成二维码」获得一个可以扫的入口。' }}</p>

      <p v-if="code" class="ma__hint">配对码 {{ code }} · 5 分钟内有效、只能用一次</p>

      <div class="ma__linkRow">
        <input class="ma__link" :value="link" readonly />
        <button class="ma__btn" type="button" :disabled="!link" @click="copy">{{ copied ? '已复制' : '复制链接' }}</button>
      </div>

      <button class="ma__btn ma__btn--primary" type="button" :disabled="busy || !active" @click="regenerate">
        {{ link ? '重新生成链接' : '生成二维码' }}
      </button>
      <p v-if="!active" class="ma__hint">局域网监听还没起来：打开开关后重启一次应用。</p>
    </section>

    <p class="ma__foot">关掉这个窗口不影响手机已经建立的连接；要断开全部设备，去「设置 → 手机访问」点「解除全部配对」。</p>
  </div>
</template>

<style scoped>
.ma {
  position: fixed;
  inset: 0;
  z-index: 60;
  overflow: auto;
  padding: 28px 32px 48px;
  background: rgb(24, 25, 28);
  color: #e8e8ea;
}
.ma__head {
  display: flex;
  align-items: baseline;
  gap: 12px;
  margin-bottom: 18px;
}
.ma__title {
  margin: 0;
  font-size: 22px;
}
.ma__sub {
  margin: 0;
  color: #a9a9b3;
  font-size: 13px;
  flex: 1;
}
.ma__close {
  padding: 6px 12px;
  border-radius: 8px;
  border: 1px solid #3a3a41;
  background: transparent;
  color: #e8e8ea;
  cursor: pointer;
}
.ma__card {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-bottom: 14px;
  padding: 16px 18px;
  border-radius: 12px;
  background: rgb(34, 35, 39);
  border: 1px solid #33343a;
}
.ma__card--qr {
  flex-direction: column;
  align-items: center;
}
.ma__toggle {
  display: flex;
  align-items: center;
  gap: 10px;
  font-size: 15px;
  cursor: pointer;
}
.ma__state {
  margin-left: auto;
  color: #a9a9b3;
  font-size: 13px;
}
.ma__qr {
  width: 260px;
  height: 260px;
  border-radius: 8px;
  background: #fff;
  padding: 4px;
}
.ma__hint {
  margin: 6px 0;
  color: #a9a9b3;
  font-size: 13px;
}
.ma__linkRow {
  display: flex;
  gap: 8px;
  width: min(680px, 100%);
  margin-top: 6px;
}
.ma__link {
  flex: 1;
  padding: 8px 10px;
  border-radius: 8px;
  border: 1px solid #3a3a41;
  background: rgb(24, 25, 28);
  color: #e8e8ea;
  font-size: 13px;
}
.ma__btn {
  padding: 8px 14px;
  border-radius: 8px;
  border: 1px solid #4a4a52;
  background: rgb(44, 45, 50);
  color: #e8e8ea;
  cursor: pointer;
}
.ma__btn--primary {
  margin-top: 12px;
  background: #d97757;
  border-color: #d97757;
  color: #1a1a1c;
  font-weight: 600;
}
.ma__btn:disabled {
  opacity: 0.55;
  cursor: default;
}
.ma__error {
  margin: 0 0 12px;
  color: #f08a7a;
  font-size: 13px;
}
.ma__note {
  margin: 0 0 12px;
  color: #f0c07a;
  font-size: 13px;
}
.ma__foot {
  margin-top: 18px;
  color: #8b8b95;
  font-size: 12px;
}
</style>
