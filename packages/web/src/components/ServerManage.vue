<script setup lang="ts">
/**
 * 服务器管理 — a full page, not a status dialog.
 *
 * WHY THIS SHAPE: the reference app's page lists the machines you can develop on and offers two ways
 * to add one (a short pairing code, or SSH). A read-only table of bridge internals answered a
 * different question and left nothing to act on.
 *
 * HONESTY RULE: only SSH is implemented end to end here. The pairing-code tab explains where the
 * real pairing flow lives (设置 → 手机访问, which mints codes and binds phones) instead of pretending
 * to pair a machine this app cannot reach yet.
 */
import { computed, onMounted, ref } from 'vue'

const emit = defineEmits<{
  (e: 'close'): void
  (e: 'open-settings', section: string): void
}>()

function resolveBaseUrl(): string {
  const injected = (globalThis as Record<string, unknown>).__CCCN_BRIDGE_URL__
  if (typeof injected === 'string' && injected.length > 0) return injected.replace(/\/$/, '')
  const param = new URLSearchParams(location.search).get('bridge')
  if (param) return param.replace(/\/$/, '')
  return import.meta.env.DEV ? '' : 'http://127.0.0.1:43130'
}

const baseUrl = resolveBaseUrl()

interface Host {
  id: string
  name: string
  host: string
  port: number
  user: string
  keyPath?: string
  trusted?: boolean
}

const hosts = ref<Host[]>([])
const loading = ref(true)
const errorText = ref('')
const notice = ref('')

const mode = ref<'code' | 'ssh'>('code')

const form = ref({ name: '', host: '', port: 22, user: '', keyPath: '' })
const pending = ref<{ host: string; port: number; line?: string; fingerprint?: string } | null>(null)

async function call(method: 'GET' | 'POST', query = '', body?: unknown) {
  const response = await fetch(`${baseUrl}/api/ssh${query}`, {
    method,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  })
  return (await response.json()) as { ok: boolean; hosts?: Host[]; error?: string; line?: string; fingerprint?: string; hint?: string }
}

async function load() {
  loading.value = true
  errorText.value = ''
  try {
    const answer = await call('GET')
    if (!answer.ok) {
      errorText.value = answer.error ?? '读不到主机清单'
      return
    }
    hosts.value = answer.hosts ?? []
  } catch (problem) {
    errorText.value = problem instanceof Error ? problem.message : String(problem)
  } finally {
    loading.value = false
  }
}

async function addHost() {
  notice.value = ''
  errorText.value = ''
  try {
    const answer = await call('POST', '', {
      action: 'add',
      name: form.value.name || `${form.value.user}@${form.value.host}`,
      host: form.value.host,
      port: Number(form.value.port) || 22,
      user: form.value.user,
      keyPath: form.value.keyPath,
    })
    if (!answer.ok) {
      errorText.value = answer.error ?? '添加失败'
      return
    }
    notice.value = '已添加。首次连接会探测主机指纹，确认一次即可。'
    form.value = { name: '', host: '', port: 22, user: '', keyPath: '' }
    await load()
  } catch (problem) {
    errorText.value = problem instanceof Error ? problem.message : String(problem)
  }
}

async function probe() {
  notice.value = ''
  errorText.value = ''
  try {
    const answer = await call('POST', '', { action: 'probe', host: form.value.host, port: Number(form.value.port) || 22 })
    if (!answer.ok) {
      errorText.value = answer.error ?? '探测失败'
      return
    }
    pending.value = { host: form.value.host, port: Number(form.value.port) || 22, line: answer.line, fingerprint: answer.fingerprint }
  } catch (problem) {
    errorText.value = problem instanceof Error ? problem.message : String(problem)
  }
}

async function remove(host: Host) {
  errorText.value = ''
  try {
    const answer = await call('POST', '', { action: 'remove', id: host.id })
    if (!answer.ok) {
      errorText.value = answer.error ?? '删除失败'
      return
    }
    await load()
  } catch (problem) {
    errorText.value = problem instanceof Error ? problem.message : String(problem)
  }
}

const canAdd = computed(() => form.value.host.trim() !== '' && form.value.user.trim() !== '')

onMounted(load)
</script>

<template>
  <div class="srv">
    <header class="srv__head">
      <h1 class="srv__title">服务器管理</h1>
      <span class="srv__meta">这里列出已添加的远程开发主机</span>
      <span class="srv__spacer" />
      <button class="srv__ghost" type="button" @click="load">刷新</button>
      <button class="srv__ghost" type="button" @click="emit('close')">关闭</button>
    </header>

    <div class="srv__body">
      <section class="srv__card">
        <h2 class="srv__cardTitle">已添加</h2>
        <p v-if="loading" class="srv__hint">正在读取主机清单…</p>
        <p v-else-if="hosts.length === 0" class="srv__hint">
          还没有添加任何服务器。用下面的表单添加一台，之后对话就能在这台机器上读写文件、执行命令。
        </p>
        <ul v-else class="srv__list">
          <li v-for="host in hosts" :key="host.id" class="srv__row">
            <span class="srv__dot" :class="{ 'srv__dot--on': host.trusted }" />
            <span class="srv__hostName">{{ host.name }}</span>
            <code class="srv__addr">{{ host.user }}@{{ host.host }}:{{ host.port }}</code>
            <span class="srv__spacer" />
            <button class="srv__ghost" type="button" @click="remove(host)">删除</button>
          </li>
        </ul>
      </section>

      <section class="srv__card">
        <div class="srv__cardHead">
          <h2 class="srv__cardTitle">添加服务器</h2>
          <span class="srv__spacer" />
          <div class="srv__tabs">
            <button class="srv__tab" :class="{ 'srv__tab--on': mode === 'code' }" type="button" @click="mode = 'code'">配对码</button>
            <button class="srv__tab" :class="{ 'srv__tab--on': mode === 'ssh' }" type="button" @click="mode = 'ssh'">SSH</button>
          </div>
        </div>

        <!-- 配对码：本应用目前通过「手机访问」生成配对码并绑定设备。 -->
        <div v-if="mode === 'code'" class="srv__pane">
          <p class="srv__hint">
            配对码用在本机与手机之间：在本机生成一个六位码，手机打开地址后输入即可获得访问权。
            这个流程在「设置 → 手机访问」里，它会显示局域网地址、生成配对码，并列出已配对的设备。
          </p>
          <button class="srv__primary" type="button" @click="emit('open-settings', 'remote')">打开手机访问设置</button>
        </div>

        <div v-else class="srv__pane">
          <div class="srv__grid">
            <label class="srv__field">
              <span class="srv__label">地址</span>
              <input v-model="form.host" class="srv__input" placeholder="192.168.1.20" />
            </label>
            <label class="srv__field srv__field--narrow">
              <span class="srv__label">端口</span>
              <input v-model.number="form.port" class="srv__input" type="number" placeholder="22" />
            </label>
            <label class="srv__field">
              <span class="srv__label">用户名</span>
              <input v-model="form.user" class="srv__input" placeholder="root" />
            </label>
            <label class="srv__field">
              <span class="srv__label">私钥路径（可选）</span>
              <input v-model="form.keyPath" class="srv__input" placeholder="~/.ssh/id_ed25519" />
            </label>
            <label class="srv__field">
              <span class="srv__label">备注名</span>
              <input v-model="form.name" class="srv__input" placeholder="可选" />
            </label>
          </div>

          <div class="srv__actions">
            <button class="srv__primary" type="button" :disabled="!canAdd" @click="addHost">添加</button>
            <button class="srv__ghost" type="button" :disabled="form.host.trim() === ''" @click="probe">探测指纹</button>
          </div>

          <p v-if="pending" class="srv__hint">
            主机指纹：<code>{{ pending.fingerprint }}</code>
            <br />
            首次连接请与服务器管理员核对后再信任。
          </p>
        </div>

        <p v-if="errorText" class="srv__error">{{ errorText }}</p>
        <p v-else-if="notice" class="srv__ok">{{ notice }}</p>
        <p class="srv__hint">认证只用密钥或本机 ssh-agent；密码登录刻意不支持，避免把密码存进应用。</p>
      </section>
    </div>
  </div>
</template>

<style scoped>
.srv {
  position: fixed;
  inset: 0;
  z-index: 60;
  display: flex;
  flex-direction: column;
  background: var(--dsw-specific-menu);
  color: var(--dsw-alias-label-primary);
}

.srv__head {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 16px 22px;
  border-bottom: 0.5px solid var(--dsw-alias-border-l1);
}

.srv__title {
  margin: 0;
  font-size: 17px;
  font-weight: 600;
}

.srv__meta,
.srv__hint {
  color: var(--dsw-alias-label-tertiary);
  font-size: 12.5px;
  line-height: 1.7;
}

.srv__spacer {
  flex: 1;
}

.srv__body {
  flex: 1;
  overflow-y: auto;
  padding: 22px;
  display: grid;
  gap: 16px;
  align-content: start;
  max-width: 980px;
  width: 100%;
  margin: 0 auto;
}

.srv__card {
  padding: 16px 18px;
  border: 0.5px solid var(--dsw-alias-border-l1);
  border-radius: 12px;
  background: var(--dsw-alias-bg-l1);
}

.srv__cardHead {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 10px;
}

.srv__cardTitle {
  margin: 0 0 8px;
  font-size: 14px;
  font-weight: 600;
}

.srv__list {
  margin: 0;
  padding: 0;
  list-style: none;
}

.srv__row {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 0;
  border-bottom: 0.5px solid var(--dsw-alias-border-l1);
}

.srv__dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--dsw-alias-label-caption);
}

.srv__dot--on {
  background: #3ecf8e;
}

.srv__hostName {
  font-size: 13px;
  font-weight: 500;
}

.srv__addr {
  color: var(--dsw-alias-label-tertiary);
  font-family: var(--dsw-font-family-code);
  font-size: 11.5px;
}

.srv__tabs {
  display: flex;
  gap: 6px;
}

.srv__tab,
.srv__ghost,
.srv__primary {
  padding: 6px 14px;
  border-radius: 8px;
  font-size: 12.5px;
  cursor: pointer;
}

.srv__tab,
.srv__ghost {
  border: 0.5px solid var(--dsw-alias-border-l2);
  background: transparent;
  color: var(--dsw-alias-label-secondary);
}

.srv__tab--on {
  border-color: #ee8f3d;
  color: #ffc38a;
  background: rgba(238, 143, 61, 0.14);
}

.srv__primary {
  border: 0;
  background: #ee8f3d;
  color: #2b1602;
  font-weight: 600;
}

.srv__primary:disabled {
  opacity: 0.5;
  cursor: default;
}

.srv__pane {
  display: grid;
  gap: 10px;
}

.srv__grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 10px;
}

.srv__field {
  display: grid;
  gap: 4px;
}

.srv__field--narrow {
  max-width: 120px;
}

.srv__label {
  font-size: 11.5px;
  color: var(--dsw-alias-label-secondary);
}

.srv__input {
  padding: 7px 10px;
  border: 0.5px solid var(--dsw-alias-border-l2);
  border-radius: 8px;
  background: var(--dsw-alias-bg-l2);
  color: var(--dsw-alias-label-primary);
  font-size: 12.5px;
}

.srv__actions {
  display: flex;
  gap: 8px;
}

.srv__error {
  color: var(--dsw-alias-state-error-primary);
  font-size: 12.5px;
}

.srv__ok {
  color: #3ecf8e;
  font-size: 12.5px;
}
</style>
