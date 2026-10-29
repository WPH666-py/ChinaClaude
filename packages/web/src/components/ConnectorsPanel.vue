<script setup lang="ts">
/**
 * 连接器 — 把上游插件提供的模型服务商接进本应用。
 *
 * WHY THIS WINDOW EXISTS INSTEAD OF A PRESET BUTTON IN 设置 → 模型: a connector is not a base URL.
 * It has a live catalog, a quota readout, and — for two of the three — a hard truth to tell ("this
 * one cannot be routed to claude.exe at all"). A button that just pasted a URL would hide all three.
 *
 * WHY THE KEY IS ONLY SENT TO THE LOCAL BRIDGE: the bridge talks to the gateway; the page never does.
 * That keeps the credential off any page-visible storage, and it is also the only way the phone
 * (which has no key) can be served by the same code path.
 */
import { computed, onMounted, ref } from 'vue'
import ShellDialog from './ShellDialog.vue'

interface ConnectorField {
  id: string
  label: string
  type: string
  placeholder: string
}

interface ConnectorRow {
  id: string
  name: string
  version: string
  title: string
  summary: string
  detail: string
  docs: string
  keyHint: string
  fields: ConnectorField[]
  supportsChat: boolean
  state: 'ready' | 'detected' | 'absent'
  evidence: string[]
}

interface CatalogModel {
  id: string
  name: string
  contextWindow: number | null
}

const props = defineProps<{ cwd?: string | null }>()
const emit = defineEmits<{ (e: 'close'): void }>()
void props

/** Same three-step resolution every panel uses (shell injection → ?bridge= → dev proxy). */
function resolveBaseUrl(): string {
  const injected = (globalThis as Record<string, unknown>).__CCCN_BRIDGE_URL__
  if (typeof injected === 'string' && injected.length > 0) return injected.replace(/\/$/, '')
  const param = new URLSearchParams(location.search).get('bridge')
  if (param) return param.replace(/\/$/, '')
  return import.meta.env.DEV ? '' : 'http://127.0.0.1:43130'
}

const baseUrl = resolveBaseUrl()

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${baseUrl}${path}`, init)
  return (await response.json()) as T
}

const rows = ref<ConnectorRow[]>([])
const loading = ref(true)
const loadError = ref('')

/** Per-connector transient state, keyed by id: one card must never overwrite another's message. */
const keys = ref<Record<string, string>>({})
const busy = ref<Record<string, boolean>>({})
const notices = ref<Record<string, { kind: 'ok' | 'error'; text: string } | null>>({})
/** 凭据探测结果，按连接器分开存：一段诊断不能覆盖另一张卡片的说明。 */
const diagnoses = ref<Record<string, string>>({})
/** WorkBuddy 的 CLI 路由状态：可用性与一次手动测试的结果。 */
const cliStatus = ref<{ available: boolean; cli: string | null; hint: string; lastTest?: { at: number; ok: boolean; code: string | null } | null } | null>(null)
const cliResult = ref<{ kind: 'ok' | 'error'; text: string } | null>(null)
const cliBusy = ref(false)
/** WorkBuddy 个人令牌：不弹终端，粘贴后可立即验证。 */
const wbToken = ref('')
const wbTokenBusy = ref(false)
const wbTokenNotice = ref<{ kind: 'ok' | 'error'; text: string } | null>(null)

async function saveWbToken() {
  wbTokenBusy.value = true
  wbTokenNotice.value = null
  try {
    const response = await fetch(`${baseUrl}/api/connectors/cli/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: wbToken.value.trim() }),
    })
    const answer = (await response.json()) as { ok: boolean; hint?: string; error?: string; text?: string }
    wbTokenNotice.value = { kind: answer.ok ? 'ok' : 'error', text: answer.ok ? answer.hint ?? '令牌有效' : answer.error ?? '令牌无效' }
    if (answer.ok) wbToken.value = ''
    await loadTraeCli()
  } catch (problem) {
    wbTokenNotice.value = { kind: 'error', text: problem instanceof Error ? problem.message : String(problem) }
  } finally {
    wbTokenBusy.value = false
  }
}
/** Trae 的 MCP 接入信息：设置文件、开关状态与可粘贴的片段。 */
const traeInfo = ref<{
  ok: boolean
  settingsPath: string | null
  workspaceMcpEnabled: boolean | null
  steps: string[]
  snippet: unknown
  limits: string
} | null>(null)

/** TRAE CLI（官方无头 CLI）：这是模型路由的可复制路径，和 MCP 反向接入并列展示。 */
const traeCli = ref<{ available: boolean; loggedIn: boolean; cli: string | null; hint: string; installCommand?: string } | null>(null)
/** 桌面端登录态（解密 storage.json 得到，端口自 dsh-connect-trae）。 */
const traeAuth = ref<{ loggedIn: boolean; account?: string | null; expiresAt?: string | null; expired?: boolean; reason?: string } | null>(null)
const traeCliResult = ref<{ kind: 'ok' | 'error'; text: string } | null>(null)
const traeCliBusy = ref(false)

async function loadTraeCli() {
  try {
    traeAuth.value = (await (await fetch(`${baseUrl}/api/connectors/trae/auth`)).json()) as typeof traeAuth.value
  } catch {
    traeAuth.value = null
  }
  try {
    traeCli.value = (await (await fetch(`${baseUrl}/api/connectors/trae/cli`)).json()) as typeof traeCli.value
  } catch {
    traeCli.value = null
  }
}

async function traeCliAction(path: string) {
  traeCliBusy.value = true
  traeCliResult.value = null
  try {
    const answer = (await (await fetch(`${baseUrl}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).json()) as {
      ok: boolean
      text?: string
      hint?: string
      error?: string
    }
    traeCliResult.value = {
      kind: answer.ok ? 'ok' : 'error',
      text: answer.ok ? answer.text ?? answer.hint ?? '完成' : answer.error ?? '操作失败',
    }
    await loadTraeCli()
  } catch (problem) {
    traeCliResult.value = { kind: 'error', text: problem instanceof Error ? problem.message : String(problem) }
  } finally {
    traeCliBusy.value = false
  }
}

async function loadTrae() {
  try {
    traeInfo.value = (await (await fetch(`${baseUrl}/api/connectors/trae/integration`)).json()) as typeof traeInfo.value
  } catch {
    traeInfo.value = null
  }
}
const catalogs = ref<Record<string, CatalogModel[]>>({})
const usage = ref<Record<string, unknown>>({})

const STATE_LABEL: Record<string, string> = {
  ready: '可用',
  detected: '已检测到 App（不可路由）',
  absent: '未安装',
}

const readyCount = computed(() => rows.value.filter((row) => row.state === 'ready').length)

function say(id: string, kind: 'ok' | 'error', text: string) {
  notices.value = { ...notices.value, [id]: { kind, text } }
}

function mark(id: string, value: boolean) {
  busy.value = { ...busy.value, [id]: value }
}

async function load() {
  loading.value = true
  loadError.value = ''
  try {
    const answer = await call<{ ok: boolean; connectors?: ConnectorRow[]; error?: string }>('/api/connectors')
    if (!answer.ok) {
      loadError.value = answer.error ?? '无法读取连接器列表'
      return
    }
    rows.value = answer.connectors ?? []
  } catch (problem) {
    loadError.value = problem instanceof Error ? problem.message : String(problem)
  } finally {
    loading.value = false
  }
}

function keyFor(id: string): string {
  return keys.value[id] ?? ''
}

function setKey(id: string, value: string) {
  keys.value = { ...keys.value, [id]: value }
}

/**
 * 凭据探测：本机有没有这两个 App 的登录态、能不能读到 token。
 *
 * Read-only on purpose — it answers "would a translation proxy even be possible here" without copying a
 * credential anywhere, which is the only claim this build can honestly make for these two connectors.
 */
async function diagnose(row: ConnectorRow) {
  mark(row.id, true)
  try {
    const answer = await call<{ ok: boolean; diagnosis?: string; error?: string }>('/api/connectors', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'diagnose', id: row.id }),
    })
    // 代理骨架的状态也要一起看：诊断说"有没有凭据"，骨架说"就算有，协议实现了没有"。
    const proxy = await fetch(`${baseUrl}/api/connectors/proxy?id=${encodeURIComponent(row.id)}`).then((response) => response.json())
    const proxyLine = proxy?.ok ? `代理骨架：${proxy.state} —— ${proxy.reason}` : ''
    diagnoses.value = {
      ...diagnoses.value,
      [row.id]: [answer.ok ? answer.diagnosis ?? '' : answer.error ?? '探测失败', proxyLine].filter(Boolean).join('\n'),
    }
  } catch (problem) {
    diagnoses.value = { ...diagnoses.value, [row.id]: problem instanceof Error ? problem.message : String(problem) }
  } finally {
    mark(row.id, false)
  }
}

/** Fetch the live catalog; a connector without an Anthropic route answers with a sentence. */
async function refreshCatalog(row: ConnectorRow) {
  mark(row.id, true)
  say(row.id, 'ok', '正在读取模型目录…')
  try {
    const answer = await call<{ ok: boolean; models?: CatalogModel[]; error?: string; unsupported?: boolean }>(
      '/api/connectors',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'catalog', id: row.id, apiKey: keyFor(row.id) }),
      },
    )
    if (!answer.ok) {
      say(row.id, 'error', answer.error ?? '读取失败')
      return
    }
    catalogs.value = { ...catalogs.value, [row.id]: answer.models ?? [] }
    say(row.id, 'ok', `目录里有 ${answer.models?.length ?? 0} 个模型`)
  } catch (problem) {
    say(row.id, 'error', problem instanceof Error ? problem.message : String(problem))
  } finally {
    mark(row.id, false)
  }
}

/** Write every catalog model into the model list as its own provider row. */
async function apply(row: ConnectorRow) {
  const models = catalogs.value[row.id] ?? []
  if (models.length === 0) {
    say(row.id, 'error', '先刷新一次模型目录')
    return
  }
  mark(row.id, true)
  try {
    const answer = await call<{ ok: boolean; providers?: unknown[]; error?: string }>('/api/connectors', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'apply', id: row.id, apiKey: keyFor(row.id), models }),
    })
    say(
      row.id,
      answer.ok ? 'ok' : 'error',
      answer.ok ? `已加入模型列表：${answer.providers?.length ?? models.length} 个（去「设置 → 模型」即可选用）` : answer.error ?? '应用失败',
    )
  } catch (problem) {
    say(row.id, 'error', problem instanceof Error ? problem.message : String(problem))
  } finally {
    mark(row.id, false)
  }
}

async function refreshUsage(row: ConnectorRow) {
  mark(row.id, true)
  try {
    const answer = await call<{ ok: boolean; usage?: unknown; error?: string }>('/api/connectors', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'usage', id: row.id, apiKey: keyFor(row.id) }),
    })
    if (!answer.ok) {
      say(row.id, 'error', answer.error ?? '读取额度失败')
      return
    }
    usage.value = { ...usage.value, [row.id]: answer.usage }
    say(row.id, 'ok', '额度已读取')
  } catch (problem) {
    say(row.id, 'error', problem instanceof Error ? problem.message : String(problem))
  } finally {
    mark(row.id, false)
  }
}

onMounted(async () => {
  await load()
  await loadTraeCli()
  // WorkBuddy 的 CLI 状态随窗口打开读一次；测试必须手动点，自动探测会白花一次模型调用。
  try {
    cliStatus.value = (await (await fetch(`${baseUrl}/api/connectors/cli`)).json()) as typeof cliStatus.value
  } catch {
    cliStatus.value = null
  }
})

/** 手动测试 CLI：真正跑一次 `codebuddy -p`，因此能区分「已登录」与「未登录」。 */
async function testCliRoute() {
  cliBusy.value = true
  cliResult.value = null
  try {
    const answer = (await (
      await fetch(`${baseUrl}/api/connectors/cli/test`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
    ).json()) as { ok: boolean; text?: string; error?: string; baseUrlHint?: string }
    cliResult.value = answer.ok
      ? { kind: 'ok', text: `CLI 已登录，回答：${String(answer.text ?? '').slice(0, 60)}` }
      : { kind: 'error', text: answer.error ?? '测试失败' }
  } catch (problem) {
    cliResult.value = { kind: 'error', text: problem instanceof Error ? problem.message : String(problem) }
  } finally {
    cliBusy.value = false
  }
}
</script>

<template>
  <ShellDialog title="连接器" :meta="`${readyCount} / ${rows.length} 个可直接使用`" :width="900" @close="emit('close')">
    <div class="cn">
      <p v-if="loading" class="cn__muted">正在读取连接器…</p>
      <p v-else-if="loadError" class="cn__error">{{ loadError }}</p>

      <section v-for="row in rows" :key="row.id" class="cn__card">
        <header class="cn__head">
          <div class="cn__titleLine">
            <strong class="cn__title">{{ row.title }}</strong>
            <code class="cn__pkg">{{ row.name }}@{{ row.version }}</code>
            <span class="cn__state" :class="`cn__state--${row.state}`">{{ STATE_LABEL[row.state] ?? row.state }}</span>
          </div>
          <a class="cn__docs" :href="row.docs" target="_blank" rel="noreferrer">上游仓库</a>
        </header>

        <p class="cn__summary">{{ row.summary }}</p>
        <p class="cn__detail">{{ row.detail }}</p>

        <ul v-if="row.evidence.length > 0" class="cn__evidence">
          <li v-for="path in row.evidence" :key="path"><code>{{ path }}</code></li>
        </ul>

        <div v-if="row.supportsChat" class="cn__form">
          <label v-for="field in row.fields" :key="field.id" class="cn__field">
            <span class="cn__label">{{ field.label }}</span>
            <input
              class="cn__input"
              :type="field.type"
              :placeholder="field.placeholder"
              :value="keyFor(row.id)"
              spellcheck="false"
              autocomplete="off"
              @input="setKey(row.id, ($event.target as HTMLInputElement).value)"
            />
          </label>

          <div class="cn__actions">
            <button class="cn__btn" type="button" :disabled="busy[row.id]" @click="refreshCatalog(row)">
              刷新模型目录
            </button>
            <button class="cn__btn cn__btn--primary" type="button" :disabled="busy[row.id]" @click="apply(row)">
              加入模型列表
            </button>
            <button class="cn__btn" type="button" :disabled="busy[row.id]" @click="refreshUsage(row)">
              查额度
            </button>
            <span v-if="row.keyHint" class="cn__hint">也可用环境变量 {{ row.keyHint }}</span>
          </div>

          <div v-if="(catalogs[row.id] ?? []).length > 0" class="cn__models">
            <span class="cn__modelsHead">目录（{{ (catalogs[row.id] ?? []).length }}）</span>
            <div class="cn__chips">
              <span v-for="model in catalogs[row.id]" :key="model.id" class="cn__chip" :title="model.id">
                {{ model.name || model.id }}
              </span>
            </div>
          </div>

          <pre v-if="usage[row.id]" class="cn__usage">{{ JSON.stringify(usage[row.id], null, 2) }}</pre>
        </div>

        <div v-else class="cn__blocked">
          <template v-if="row.id === 'workbuddy'">
            <p>
              <strong>CLI 路由可用（需先登录一次）</strong>：桥把请求翻译成 WorkBuddy 自带 CodeBuddy CLI 的
              <code>-p</code> 调用，答案再包回 Anthropic 格式。把服务商 Base URL 设为
              <code>http://127.0.0.1:43130/proxy/workbuddy</code> 即可使用。
            </p>
            <p v-if="cliStatus?.lastTest" class="cn__hint">上次测试：{{ cliStatus.lastTest.ok ? '已登录' : '未登录' }} · {{ new Date(cliStatus.lastTest.at).toLocaleString() }}</p>
            <p v-if="cliStatus" class="cn__hint">
              {{ cliStatus.available ? `CLI：${cliStatus.cli}` : cliStatus.hint }}
            </p>
            <div class="cn__actions">
              <button class="cn__btn" type="button" :disabled="cliBusy || !cliStatus?.available" @click="testCliRoute">
                {{ cliBusy ? '测试中…' : '测试 CLI 连接' }}
              </button>
              <button class="cn__btn" type="button" :disabled="busy[row.id]" @click="diagnose(row)">探测本机凭据</button>
            </div>
            <div class="cn__actions">
              <input v-model="wbToken" class="cn__input" placeholder="粘贴 WorkBuddy 个人令牌（可免 /login）" spellcheck="false" />
              <button class="cn__btn" type="button" :disabled="wbTokenBusy" @click="saveWbToken">
                {{ wbTokenBusy ? '验证中…' : '保存令牌并测试' }}
              </button>
            </div>
            <p v-if="wbTokenNotice" class="cn__detail">{{ wbTokenNotice.text }}</p>
            <p v-if="cliResult" class="cn__detail">{{ cliResult.text }}</p>
          </template>
          <template v-else-if="row.id === 'trae'">
            <!-- TRAE CLI：模型路由的可复制路径 -->
            <p>
              <strong>TRAE CLI 路由</strong>：Trae 提供官方 CLI 2.0（`traecli`），无头模式可当模型后端。
              把 Base URL 设为 <code>http://127.0.0.1:43130/proxy/trae</code>；首次需登录一次。
            </p>
            <p v-if="traeAuth?.loggedIn" class="cn__hint">
              已登录：{{ traeAuth.account ?? '本机 Trae 账户' }} · 到期 {{ traeAuth.expiresAt ?? '未知' }}（读取自本机 Trae 登录态，无需登录页）
            </p>
            <p v-else-if="traeAuth && !traeAuth.loggedIn" class="cn__hint">未登录或令牌已过期：{{ traeAuth.reason ?? '请在本机 Trae 客户端登录一次' }}</p>
            <p v-if="traeCli" class="cn__hint">
              {{ traeCli.available ? `CLI：${traeCli.cli} · 登录：${traeCli.loggedIn ? '已登录' : '未登录'}` : traeCli.hint }}
            </p>
            <p v-if="traeCli && !traeCli.available" class="cn__hint">
              安装命令：<code>{{ traeCli.installCommand }}</code>
            </p>
            <div class="cn__actions">
              <button v-if="!traeAuth?.loggedIn" class="cn__btn" type="button" :disabled="traeCliBusy || !traeCli?.available" @click="traeCliAction('/api/connectors/trae/cli/login')">
                打开 TRAE CLI 登录窗口
              </button>
              <button class="cn__btn" type="button" :disabled="traeCliBusy || !traeCli?.available" @click="traeCliAction('/api/connectors/trae/cli/test')">
                {{ traeCliBusy ? '测试中…' : '测试 TRAE CLI 连接' }}
              </button>
            </div>
            <p v-if="traeCliResult" class="cn__detail">{{ traeCliResult.text }}</p>

            <hr class="cn__hr" />
            <p>
              <strong>反向接入（MCP）</strong>：Trae 支持 MCP，可让 <em>Trae 调用本应用的工具</em>；
              下面是要粘贴的 stdio 服务器片段。
            </p>
            <p v-if="traeInfo" class="cn__hint">
              设置文件：{{ traeInfo.settingsPath ?? '未找到' }} · 工作区 MCP 开关：{{ traeInfo.workspaceMcpEnabled === null ? '未读到' : (traeInfo.workspaceMcpEnabled ? '已开启' : '已关闭') }}
            </p>
            <ol v-if="traeInfo" class="cn__steps">
              <li v-for="(step, index) in traeInfo.steps" :key="index">{{ step }}</li>
            </ol>
            <pre v-if="traeInfo?.snippet" class="cn__snippet">{{ JSON.stringify(traeInfo.snippet, null, 2) }}</pre>
            <p v-if="traeInfo" class="cn__muted">{{ traeInfo.limits }}</p>
            <div class="cn__actions">
              <button class="cn__btn" type="button" :disabled="busy[row.id]" @click="loadTrae">读取 MCP 接入信息</button>
              <button class="cn__btn" type="button" :disabled="busy[row.id]" @click="diagnose(row)">探测本机凭据</button>
            </div>
          </template>
          <template v-else>
            <p>暂不可路由：{{ row.state === 'detected' ? '本机检测到该 App 的登录文件，' : '' }}上游不是 Anthropic 协议，且没有可用的命令行入口。</p>
            <button class="cn__btn" type="button" :disabled="busy[row.id]" @click="diagnose(row)">探测本机凭据</button>
          </template>
          <p v-if="diagnoses[row.id]" class="cn__detail">{{ diagnoses[row.id] }}</p>
        </div>

        <p v-if="notices[row.id]" class="cn__notice" :class="`cn__notice--${notices[row.id]?.kind}`">
          {{ notices[row.id]?.text }}
        </p>
      </section>
    </div>
  </ShellDialog>
</template>

<style scoped>
.cn {
  display: flex;
  flex-direction: column;
  gap: 12px;
  max-height: 68vh;
  overflow: auto;
  padding: 2px;
}

.cn__muted {
  color: var(--dsw-alias-label-tertiary);
  font-size: 12.5px;
}

.cn__error {
  color: var(--dsw-alias-state-error-primary);
  font-size: 12.5px;
}

.cn__card {
  padding: 12px 14px;
  border: 0.5px solid var(--dsw-alias-border-l1);
  border-radius: 10px;
  background: var(--dsw-alias-bg-layer-1);
}

.cn__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.cn__titleLine {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}

.cn__title {
  color: var(--dsw-alias-label-primary);
  font-size: 13.5px;
}

.cn__pkg {
  color: var(--dsw-alias-label-tertiary);
  font-family: var(--dsw-font-family-code);
  font-size: 11px;
}

.cn__state {
  padding: 1px 7px;
  border-radius: 999px;
  background: var(--dsw-alias-interactive-bg-hover);
  color: var(--dsw-alias-label-secondary);
  font-size: 11px;
  white-space: nowrap;
}

.cn__state--ready {
  color: var(--dsw-alias-state-success-primary, var(--dsw-alias-label-primary));
}

.cn__docs {
  flex: none;
  color: var(--dsw-alias-label-tertiary);
  font-size: 11.5px;
  text-decoration: none;
}

.cn__docs:hover {
  color: var(--dsw-alias-label-primary);
}

.cn__summary {
  margin: 6px 0 4px;
  color: var(--dsw-alias-label-secondary);
  font-size: 12.5px;
}

.cn__detail {
  margin: 0;
  color: var(--dsw-alias-label-tertiary);
  font-size: 12px;
  line-height: 1.6;
}

.cn__evidence {
  margin: 6px 0 0;
  padding-left: 18px;
  color: var(--dsw-alias-label-tertiary);
  font-size: 11.5px;
}

.cn__form {
  margin-top: 10px;
}

.cn__field {
  display: flex;
  align-items: center;
  gap: 8px;
}

.cn__label {
  flex: none;
  width: 64px;
  color: var(--dsw-alias-label-secondary);
  font-size: 12px;
}

.cn__input {
  flex: 1;
  min-width: 0;
  padding: 5px 8px;
  border: 0.5px solid var(--dsw-alias-border-l1);
  border-radius: 7px;
  background: var(--dsw-alias-bg-layer-2);
  color: var(--dsw-alias-label-primary);
  font-family: var(--dsw-font-family-code);
  font-size: 12px;
}

.cn__actions {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 8px;
}

.cn__btn {
  padding: 4px 10px;
  border: 0.5px solid var(--dsw-alias-border-l1);
  border-radius: 7px;
  color: var(--dsw-alias-label-secondary);
  font-size: 12px;
}

.cn__btn:hover:not(:disabled) {
  background: var(--dsw-alias-interactive-bg-hover);
  color: var(--dsw-alias-label-primary);
}

.cn__btn:disabled {
  opacity: 0.5;
}

.cn__btn--primary {
  border-color: transparent;
  background: var(--dsw-alias-interactive-bg-hover);
  color: var(--dsw-alias-label-primary);
}

.cn__hint {
  color: var(--dsw-alias-label-tertiary);
  font-size: 11px;
}

.cn__models {
  margin-top: 10px;
}

.cn__modelsHead {
  color: var(--dsw-alias-label-tertiary);
  font-size: 11.5px;
}

.cn__chips {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-top: 4px;
}

.cn__chip {
  max-width: 100%;
  overflow: hidden;
  padding: 2px 8px;
  border-radius: 6px;
  background: var(--dsw-alias-interactive-bg-hover);
  color: var(--dsw-alias-label-secondary);
  font-family: var(--dsw-font-family-code);
  font-size: 11px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.cn__usage {
  max-height: 180px;
  margin: 8px 0 0;
  overflow: auto;
  padding: 8px 10px;
  border-radius: 8px;
  background: var(--dsw-alias-bg-layer-2);
  color: var(--dsw-alias-label-secondary);
  font-family: var(--dsw-font-family-code);
  font-size: 11px;
}

.cn__blocked {
  margin: 10px 0 0;
  padding: 8px 10px;
  border-radius: 8px;
  background: var(--dsw-alias-bg-layer-2);
  color: var(--dsw-alias-label-tertiary);
  font-size: 11.5px;
  line-height: 1.6;
}

.cn__notice {
  margin: 8px 0 0;
  font-size: 12px;
}

.cn__notice--ok {
  color: var(--dsw-alias-label-secondary);
}

.cn__notice--error {
  color: var(--dsw-alias-state-error-primary);
}
</style>
