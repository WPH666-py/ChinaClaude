<script setup lang="ts">
/**
 * Application shell: the frame grid (sidebar column + centre column) and the two states it
 * can be in — the first-run setup form, or a live conversation.
 *
 * Credentials are never persisted: they travel with the one request that creates a session,
 * and are held by the bridge's child process for its lifetime only.
 */
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useBridge } from './composables/useBridge'
import Sidebar from './components/Sidebar.vue'
import Transcript from './components/Transcript.vue'
import Composer from './components/Composer.vue'
import DirectoryPicker from './components/DirectoryPicker.vue'
import CatalogPanel from './components/CatalogPanel.vue'
import SettingsPanel from './components/SettingsPanel.vue'
import { useSettings, parseModelRef } from './composables/useSettings'
import type { ProviderBalance, TranscriptSummary } from './types'
import { priceEvents, isPeak } from '../../bridge/src/pricing.mjs'

const bridge = useBridge()
const store = useSettings()

const workspace = ref('')
const model = ref('')
/**
 * Permission preset chosen for the session about to be created.
 *
 * Held as a preset ID, not a raw CLI mode string: the four choices ARE the product decision, and
 * which CLI mode each maps to is an implementation detail the user should not have to spell
 * correctly. The previous free-text field accepted any string, including typos the CLI would
 * silently fall back from.
 */
const newSessionPresetId = ref(store.settings.value.permissionPreset)
const newSessionPreset = computed(() => store.presetById(newSessionPresetId.value))
const token = ref('')
const baseUrl = ref('')
const setupOpen = ref(true)
const starting = ref(false)
const startError = ref<string | null>(null)
const showCredential = ref(false)
const pickerOpen = ref(false)
const catalogOpen = ref(false)
const settingsOpen = ref(false)
const sidebarCollapsed = ref(false)
/** Model chosen in the setup form, as "providerId::model"; empty follows the provider default. */
const newSessionModelRef = ref('')
const tab = ref<'chat' | 'trace'>('chat')
/** Set when the user explicitly asks for a new session, so polling never overrides it. */
const setupPinnedByUser = ref(false)

const binaryPath = computed(() => bridge.discovery.value?.binary?.path ?? null)
const binaryMissing = computed(() => bridge.discovery.value !== null && binaryPath.value === null)

/** Projects the CLI already knows about, as one-click workspace shortcuts. */
const recentProjects = computed(() => (bridge.discovery.value?.projects ?? []).slice(0, 6))

/** Directory the picker should open on: a real project if we know one, else home. */
const pickerStart = computed(() => recentProjects.value[0]?.path ?? workspace.value)

/** Providers configured in settings; when there are none the form falls back to manual entry. */
const configuredProviders = computed(() => store.settings.value.providers)
const hasProviders = computed(() => configuredProviders.value.length > 0)

/**
 * Session cost, priced from the event stream with the user's rate tables.
 *
 * Priced locally rather than fetched from `/api/sessions/:id/cost` for two reasons: the number then
 * moves with the transcript as turns land instead of lagging a poll behind, and only the client
 * knows the user's own rates for vendors the built-in table does not cover.
 */
const sessionCost = computed(() => {
  const results = bridge.events.value.filter((event) => event.kind === 'result')
  return priceEvents(
    results.map((event) => ({ kind: 'result', usage: event.usage, model: event.model, at: event.at })),
    bridge.activeSession.value?.model ?? null,
    undefined,
    { tables: store.settings.value.priceTables },
  )
})

/**
 * Which rate basis is in force, or null when the rate does not vary by time of day.
 *
 * Reported from the PRICING result rather than from the clock: a flat-rate vendor priced during
 * Chinese business hours must not be labelled "高峰时段价", which would be a false statement about
 * why the number is what it is.
 */
const costBasis = computed(() => (sessionCost.value.usesTimeOfDay ? (isPeak() ? 'peak' : 'offPeak') : null))

/**
 * The provider the active session is actually billing against.
 *
 * Resolved from the session's model when it names one, else from the provider that model belongs to,
 * else the default provider — the same precedence session creation uses, so the balance shown is the
 * balance of the account that is being spent.
 */
const billingProvider = computed(() => {
  const session = bridge.activeSession.value
  if (!session) return null
  const chosen = store.resolveOption(session.model ?? '')
  if (chosen) return store.providerById(chosen.providerId)
  return store.defaultProvider()
})

const balance = ref<ProviderBalance | null>(null)
const balanceLoading = ref(false)

/**
 * Which model and which provider this session is actually pointed at.
 *
 * Shown INDEPENDENTLY of cost. It used to hang off the cost row, which only appears once a turn has
 * been priced — so on a fresh session (or one that has not run a turn yet) the user saw a balance
 * with no indication of whose it was, even though the provider was already known: it is the provider
 * the balance was read from.
 *
 * Reported even when the model is not in any configured provider, because that case is exactly when
 * the user most needs to see where the request is really going; `modelUnmapped` marks it the same way
 * the composer's chip does.
 */
const modelContext = computed(() => {
  const session = bridge.activeSession.value
  if (!session) return null
  const provider = billingProvider.value
  const requested = session.model ?? session.resolvedModel ?? ''
  const chosen = store.resolveOption(requested)
  return {
    model: requested || '端点默认模型',
    /**
     * Name the provider, or say WHY there is none.
     *
     * "未配置服务商" was wrong for a session that is demonstrably working: it describes the local
     * catalog while reading as a statement about capability. A session keeps the endpoint and key it
     * was started with, so with credentials it stays callable whether or not the list knows about it;
     * without them a call will really fail, and only then is "无凭据" the honest word.
     */
    provider: provider?.name ?? (session.hasCredential ? '未登记的端点' : '无凭据'),
    unmapped: Boolean(requested) && !chosen,
  }
})

/**
 * Read the balance.
 *
 * On demand rather than on a timer: it is a real network call to the vendor on every refresh, and a
 * balance that updates every few seconds would suggest a precision the figure does not have.
 */
async function refreshBalance() {
  const provider = billingProvider.value
  if (!provider) {
    balance.value = null
    return
  }
  balanceLoading.value = true
  try {
    balance.value = await bridge.fetchBalance({
      baseUrl: provider.baseUrl,
      apiKey: provider.apiKey,
      balanceUrl: provider.balanceUrl,
      balancePath: provider.balancePath,
      currency: provider.currency,
    })
  } catch (error) {
    balance.value = { available: false, currency: null, total: null, granted: null, toppedUp: null, detail: null, error: String((error as Error).message ?? error) }
  } finally {
    balanceLoading.value = false
  }
}

// A provider switch changes whose balance matters, so re-read it. Keyed on the provider id so an
// unrelated settings edit does not trigger a network call.
watch(
  () => billingProvider.value?.id ?? null,
  () => void refreshBalance(),
)

const balanceText = computed(() => {
  const reading = balance.value
  if (!reading?.available || reading.total === null) return null
  const symbol = reading.currency === 'CNY' ? '¥' : reading.currency === 'USD' ? '$' : ''
  const amount = Math.abs(reading.total) >= 100 ? reading.total.toFixed(2) : reading.total.toFixed(2)
  return `${symbol}${amount}${symbol ? '' : ' ' + (reading.currency ?? '')}`.trim()
})

const balanceError = computed(() => (balance.value && !balance.value.available ? (balance.value.error ?? '不可用') : null))

/** Models offered in the setup form, as (provider, model) pairs. */
const setupModelOptions = computed(() => store.modelOptions())

/** The provider the chosen model belongs to, for the "which endpoint" line. */
const setupEndpoint = computed(() => {
  const chosen = store.resolveOption(newSessionModelRef.value || store.settings.value.defaultModelRef)
  const provider = chosen ? store.providerById(chosen.providerId) : store.defaultProvider()
  return provider ? { name: provider.name, baseUrl: provider.baseUrl, hasKey: Boolean(provider.apiKey) } : null
})

/** Last path segment, which is what identifies a project in a narrow chip. */
function shortPath(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean)
  return parts[parts.length - 1] ?? path
}

function onPickDirectory(path: string) {
  workspace.value = path
  pickerOpen.value = false
}

/**
 * Open the skill/subagent panel, re-asking for the catalog if it never arrived.
 *
 * The wait for the CLI's `initialize` reply is bounded on purpose, so a session whose CLI never
 * answered gives up instead of polling forever — and that would otherwise park the panel on
 * "等待 CLI 的 initialize 握手返回目录…" with no way to retry short of reopening the session.
 */
function openCatalog() {
  catalogOpen.value = true
  if (!bridge.catalog.value?.ready) void bridge.refreshCatalogWhenReady()
}

/** Answer a pending tool-permission ask; the CLI is blocked until this lands. */
async function onPermissionDecision(payload: {
  requestId: string
  behavior: 'allow' | 'deny'
  scope?: 'once' | 'session'
}) {
  try {
    await bridge.respondPermission(payload.requestId, payload.behavior, payload.scope ?? 'once')
  } catch (error) {
    startError.value = String((error as Error).message ?? error)
  }
}

/** Answer a host dialog. `cancelled` makes the CLI apply that dialog's own default. */
async function onDialogAnswer(payload: {
  requestId: string
  behavior: 'completed' | 'cancelled'
  result?: unknown
}) {
  try {
    await bridge.respondDialog(payload.requestId, payload.behavior, payload.result)
  } catch (error) {
    startError.value = String((error as Error).message ?? error)
  }
}

/** Switch the running session's permission mode through the control channel. */
async function onChangeMode(mode: string) {
  try {
    await bridge.setPermissionMode(mode)
    store.settings.value.permissionPreset =
      store.PERMISSION_PRESETS.find((preset) => preset.mode === mode)?.id ?? store.settings.value.permissionPreset
  } catch (error) {
    startError.value = String((error as Error).message ?? error)
  }
}

/**
 * Switching the model from the composer.
 *
 * The event carries a "providerId::model" reference because a model name alone does not identify
 * an endpoint. Same provider -> in-session control request. Different provider -> the bridge
 * restarts the child against the new endpoint and resumes the conversation.
 */
async function onChangeModel(ref: string) {
  try {
    if (!ref) {
      await bridge.setModel('')
      return
    }
    const option = store.resolveOption(ref)
    if (!option) {
      await bridge.setModel(parseModelRef(ref).model)
      return
    }
    await bridge.setModel(option.model, {
      baseUrl: option.baseUrl,
      apiKey: option.apiKey,
      // The level is pinned to the model, so switching models switches effort with it. The bridge
      // only relaunches when the level actually differs from the running child's.
      effort: option.effort,
    })
  } catch (error) {
    startError.value = String((error as Error).message ?? error)
  }
}

onMounted(async () => {
  await bridge.refreshHealth()
  await bridge.refreshDiscovery()
  await bridge.refreshSessions()

  const discovered = bridge.discovery.value
  if (discovered) {
    baseUrl.value = discovered.baseUrl ?? 'https://api.deepseek.com/anthropic'
    workspace.value = discovered.projects[0]?.path ?? discovered.claude.home
  }
  setupOpen.value = bridge.sessions.value.length === 0

  // Development affordances: `?picker=1` / `?catalog=1` open those overlays directly, which
  // makes them reachable in a headless screenshot without simulating a click.
  const params = new URLSearchParams(location.search)
  if (params.get('picker') === '1') {
    setupOpen.value = true
    setupPinnedByUser.value = true
    pickerOpen.value = true
  }
  if (params.get('catalog') === '1') {
    setupOpen.value = true
    setupPinnedByUser.value = true
    catalogOpen.value = true
  }
  // Any non-empty value opens the panel, so `?settings=permission` can target a section.
  if (params.get('settings')) {
    settingsOpen.value = true
  }
  // `?session=<id>` (or `?session=newest`) attaches to an EXISTING session on load. Without it a
  // session that already existed when the page opened is never adopted: the watcher below only
  // fires when the session count CHANGES, so a headless screenshot of an established session —
  // including its usage and cost — was unreachable.
  const requestedSession = params.get('session')
  if (requestedSession) {
    setupPinnedByUser.value = true
    const target =
      requestedSession === 'newest' ? bridge.sessions.value[0]?.id : requestedSession
    if (target) {
      setupOpen.value = false
      void bridge.openSession(target)
    }
  }

  // Sessions are server-owned: keep the sidebar in step with anything created elsewhere.
  bridge.startSessionPolling()
})

/**
 * Adopt a session that appeared while we were showing the setup form (created over the API,
 * in another window, or by the CLI). Skipped once the user deliberately opens the form.
 */
watch(
  () => bridge.sessions.value.length,
  (count) => {
    if (count === 0) return
    if (setupPinnedByUser.value) return
    if (bridge.activeSessionId.value) return
    const newest = bridge.sessions.value[0]
    if (newest) void openExisting(newest.id)
  },
)

onBeforeUnmount(() => bridge.detach())

/**
 * Start a session on the endpoint the user's model choice implies.
 *
 * Precedence matters: an explicit provider+model selection wins, then the provider's own
 * settings, then the manual fallback fields (used only before any provider is configured).
 */
async function startSession() {
  starting.value = true
  startError.value = null
  try {
    const chosen = store.resolveOption(newSessionModelRef.value || store.settings.value.defaultModelRef)
    const provider = chosen ? store.providerById(chosen.providerId) : store.defaultProvider()

    const session = await bridge.createSession({
      cwd: workspace.value.trim(),
      model: chosen?.model || model.value.trim() || undefined,
      permissionMode: newSessionPreset.value.mode,
      // A provider owns its endpoint and key; the manual fields only apply when none exists.
      baseUrl: provider?.baseUrl || baseUrl.value.trim() || undefined,
      authToken: provider ? provider.apiKey : token.value.trim() || undefined,
      // Empty means "model default" and is dropped by the bridge rather than sent as a level.
      effort: chosen?.effort || undefined,
    })
    await bridge.openSession(session.id)
    setupOpen.value = false
    setupPinnedByUser.value = false
  } catch (error) {
    startError.value = String((error as Error).message ?? error)
  } finally {
    starting.value = false
  }
}

async function openExisting(id: string) {
  setupOpen.value = false
  setupPinnedByUser.value = false
  await bridge.openSession(id)
}

/**
 * Reopen a conversation that Claude Code already wrote to disk.
 *
 * The transcript is used in place: the session id goes to the CLI as `--resume` and the working
 * directory comes from the transcript's own records, so the resumed conversation finds the same
 * context the user left. Credentials and model follow the same precedence as a new session, because
 * a resumed conversation still needs an endpoint to continue on.
 */
async function onOpenTranscript(transcript: TranscriptSummary) {
  if (transcript.oversized) {
    startError.value = '这个会话文件过大，无法直接继续：请先导出 Markdown 查看内容。'
    return
  }
  startError.value = null
  try {
    const chosen = store.resolveOption(newSessionModelRef.value || store.settings.value.defaultModelRef)
    const provider = chosen ? store.providerById(chosen.providerId) : store.defaultProvider()

    const session = await bridge.createSession({
      // The transcript's own cwd, not the setup form's: resuming against a different directory would
      // leave the CLI unable to find the conversation it was asked to resume.
      cwd: transcript.cwd || workspace.value.trim(),
      resumeSessionId: transcript.sessionId,
      model: chosen?.model || model.value.trim() || undefined,
      permissionMode: newSessionPreset.value.mode,
      baseUrl: provider?.baseUrl || baseUrl.value.trim() || undefined,
      authToken: provider ? provider.apiKey : token.value.trim() || undefined,
      effort: chosen?.effort || undefined,
    })
    await bridge.openSession(session.id)
    settingsOpen.value = false
    setupOpen.value = false
    setupPinnedByUser.value = false
  } catch (error) {
    startError.value = `继续该会话失败：${String((error as Error).message ?? error)}`
  }
}

function newSession() {
  setupOpen.value = true
  setupPinnedByUser.value = true
  startError.value = null
}

/**
 * Leave the setup form without creating a workspace.
 *
 * Where the user lands depends on whether anything is open, and all three cases have to be
 * deliberate:
 *   - a session is already active  -> return to it, so cancelling is never destructive;
 *   - sessions exist but none active -> fall back to the newest one, so the app is not left on a
 *     blank screen with no obvious way forward;
 *   - no sessions at all (first run) -> show the empty state, where 新建会话 is still the obvious
 *     next action.
 *
 * `setupPinnedByUser` is cleared only in the last case: with no session to fall back to, leaving it
 * set would block the adoption watcher from picking up a session created elsewhere.
 */
function cancelSetup() {
  startError.value = null
  setupOpen.value = false
  if (bridge.activeSessionId.value) {
    setupPinnedByUser.value = false
    return
  }
  const newest = bridge.sessions.value[0]
  if (newest) {
    void openExisting(newest.id)
    return
  }
  setupPinnedByUser.value = false
}
</script>

<template>
  <div class="frame" :class="{ 'frame--rail': sidebarCollapsed }">
    <div class="sidebarCol">
      <Sidebar
        :sessions="bridge.sessions.value"
        :active-id="bridge.activeSessionId.value"
        :connected="bridge.connected.value"
        :binary-path="binaryPath"
        :totals="bridge.totals.value"
        :cost="sessionCost"
        :cost-basis="costBasis"
        :model-context="modelContext"
        :balance-text="balanceText"
        :balance-error="balanceError"
        :balance-loading="balanceLoading"
        @refresh-balance="refreshBalance"
        @new="newSession"
        @open="openExisting"
        @settings="settingsOpen = true"
        @toggle-collapse="sidebarCollapsed = !sidebarCollapsed"
        @remove-session="(id: string) => bridge.removeSession(id)"
        @remove-workspace="(cwd: string) => bridge.removeWorkspace(cwd)"
      />
    </div>

    <div class="centerCol">
      <!-- ------------------------------------------------------ setup screen -- -->
      <div v-if="setupOpen" class="setup">
        <div class="setup__panel">
          <!--
            Cancel sits at the TOP, away from 开始会话 at the bottom: creating a workspace is a
            commitment, so the way out is where the eye lands first rather than next to the
            confirming button where it would be easy to hit by accident.
          -->
          <button class="setup__cancel" type="button" title="取消新建工作区" @click="cancelSetup">
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" />
            </svg>
            取消
          </button>
          <div class="setup__intro">
            <span class="setup__eyebrow">首次启动</span>
            <h1 class="setup__title">新建会话</h1>
            <p class="setup__sub">
              Claude Code 以本机进程运行，模型走 Anthropic 兼容端点；凭据只随本次请求传给本地桥。
            </p>

            <div v-if="!bridge.connected.value" class="banner banner--error">
              未连接到本地桥接服务。{{ bridge.lastError.value }}
            </div>

            <div v-if="binaryMissing" class="banner banner--error">
              未找到 claude.exe。请用 npmmirror 安装
              <code>npm i -g @anthropic-ai/claude-code</code>，或用
              <code>CCCN_CLAUDE_BINARY</code> 指定路径。
            </div>

            <div v-if="bridge.discovery.value" class="kv">
              <span class="kv__k">claude.exe</span>
              <span class="kv__v" :title="binaryPath ?? ''">{{ binaryPath ?? '未找到' }}</span>
              <span class="kv__k">桥接地址</span>
              <span class="kv__v">{{ bridge.baseUrl.value }}</span>
              <span class="kv__k">运行时</span>
              <span class="kv__v">Node {{ bridge.discovery.value.runtime.node }}</span>
              <span class="kv__k">平台</span>
              <span class="kv__v">
                {{ bridge.discovery.value.runtime.platform }}-{{ bridge.discovery.value.runtime.arch }}
              </span>
              <span class="kv__k">Claude 配置</span>
              <span class="kv__v">{{ bridge.discovery.value.claude.configPath ?? '无' }}</span>
            </div>
          </div>

          <div class="setup__form">
            <div class="field">
              <label class="field__label" for="ws">工作目录</label>
              <div class="field__row">
                <input
                  id="ws"
                  :value="workspace"
                  class="field__input"
                  spellcheck="false"
                  readonly
                  placeholder="点击右侧按钮选择目录"
                />
                <button class="btnGhost btnGhost--icon" type="button" title="浏览…" @click="pickerOpen = true">
                  <svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                    <path d="M2 5.5A1.5 1.5 0 013.5 4h2.2l1.2 1.4h5.6A1.5 1.5 0 0114 6.9v4.6A1.5 1.5 0 0112.5 13h-9A1.5 1.5 0 012 11.5v-6z" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round" />
                  </svg>
                  浏览…
                </button>
              </div>

              <div v-if="recentProjects.length > 0" class="recent">
                <span class="recent__label">最近使用</span>
                <button
                  v-for="project in recentProjects"
                  :key="project.path"
                  class="recent__item"
                  type="button"
                  :title="project.path"
                  @click="workspace = project.path"
                >
                  {{ shortPath(project.path) }}
                </button>
              </div>

              <div class="field__hint">Agent 的读写与命令执行都以此为根目录。</div>
            </div>

            <!-- Provider-backed setup: the model choice implies the endpoint and credential. -->
            <template v-if="hasProviders">
              <div class="field">
                <label class="field__label" for="setupModel">模型</label>
                <select id="setupModel" v-model="newSessionModelRef" class="field__input">
                  <option value="">跟随默认服务商（不指定模型）</option>
                  <option v-for="option in setupModelOptions" :key="option.ref" :value="option.ref">
                    {{ option.label }} — {{ option.providerName }}
                  </option>
                </select>
                <div class="field__hint">
                  会话将使用该模型所属服务商的 Base URL 与 API-KEY。
                </div>
              </div>

              <div v-if="setupEndpoint" class="endpointLine">
                <span class="endpointLine__name">{{ setupEndpoint.name }}</span>
                <code class="endpointLine__url">{{ setupEndpoint.baseUrl }}</code>
                <span v-if="setupEndpoint.hasKey" class="endpointLine__ok">已配置 Key</span>
                <span v-else class="endpointLine__warn">缺少 API-KEY</span>
              </div>

              <div v-if="setupEndpoint && !setupEndpoint.hasKey" class="banner banner--error">
                该服务商还没有 API-KEY。请到「设置 → 模型」补上，否则会话会因鉴权失败而无法使用。
              </div>

              <div class="field">
                <label class="field__label" for="model">模型名覆盖（可选）</label>
                <input
                  id="model"
                  v-model="model"
                  class="field__input"
                  spellcheck="false"
                  placeholder="留空则用上面的选择"
                />
              </div>
            </template>

            <!-- No provider yet: manual entry, exactly as before. -->
            <template v-else>
              <div class="banner banner--info">
                还没配置服务商：先去「设置 → 模型」添加，或在此手动填写端点与 Key。
              </div>

              <div class="field">
                <label class="field__label" for="base">端点 Base URL</label>
                <input id="base" v-model="baseUrl" class="field__input" spellcheck="false" />
                <div class="field__hint">默认 {{ store.DEFAULT_BASE_URL }}</div>
              </div>

              <div class="field">
                <label class="field__label" for="token">API Key</label>
                <div class="field__row">
                  <input
                    id="token"
                    v-model="token"
                    class="field__input"
                    :type="showCredential ? 'text' : 'password'"
                    spellcheck="false"
                    placeholder="sk-..."
                  />
                  <button class="btnGhost" type="button" @click="showCredential = !showCredential">
                    {{ showCredential ? '隐藏' : '显示' }}
                  </button>
                </div>
                <div class="field__hint">只随本次请求传给本地桥，不写入任何存储。</div>
              </div>

              <div class="field">
                <label class="field__label" for="model">模型</label>
                <input id="model" v-model="model" class="field__input" spellcheck="false" placeholder="留空由端点决定" />
              </div>
            </template>

            <!-- One control for both branches: the choice is identical either way. -->
            <div class="field">
              <label class="field__label">权限模式</label>
              <div class="permGrid">
                <button
                  v-for="preset in store.PERMISSION_PRESETS"
                  :key="preset.id"
                  class="permCard"
                  :class="{
                    'permCard--on': newSessionPresetId === preset.id,
                    'permCard--danger': preset.dangerous,
                  }"
                  type="button"
                  @click="newSessionPresetId = preset.id"
                >
                  <span class="permCard__top">
                    <span class="permCard__label">{{ preset.label }}</span>
                    <code class="permCard__mode">{{ preset.mode }}</code>
                  </span>
                  <span class="permCard__desc">{{ preset.description }}</span>
                </button>
              </div>
              <div class="field__hint">
                新建的会话以该模式启动；会话开始后仍可在输入框里或「设置 → 权限」随时切换。
              </div>
            </div>

            <div v-if="startError" class="banner banner--error">{{ startError }}</div>

            <button class="btnPrimary" type="button" :disabled="starting || !bridge.connected.value" @click="startSession">
              <span v-if="starting" class="spinner" />
              {{ starting ? '正在启动 claude.exe…' : '开始会话' }}
            </button>
          </div>
        </div>
      </div>

      <!-- --------------------------------------------------------- conversation -- -->
      <template v-else>
        <header class="topBar">
          <!-- The collapse toggle lives inside the sidebar, so a rail needs its own way back. -->
          <button
            v-if="sidebarCollapsed"
            class="iconButton"
            type="button"
            title="展开侧栏"
            @click="sidebarCollapsed = false"
          >
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <rect x="2" y="3" width="12" height="10" rx="2" stroke="currentColor" stroke-width="1.4" />
              <path d="M6.5 3v10" stroke="currentColor" stroke-width="1.4" />
            </svg>
          </button>
          <span class="topBar__title">{{ bridge.activeSession.value?.cwd ?? '未选择工作目录' }}</span>
          <span class="topBar__spacer" />
          <div class="tabs">
            <button class="tab" :class="{ 'tab--active': tab === 'chat' }" type="button" @click="tab = 'chat'">
              对话
            </button>
            <button class="tab" :class="{ 'tab--active': tab === 'trace' }" type="button" @click="tab = 'trace'">
              轨迹
            </button>
          </div>
          <span class="topBar__spacer" />
          <span v-if="bridge.pendingPermissions.value.length > 0" class="chip chip--attention">
            <span class="dot dot--starting" />
            等待授权 · {{ bridge.pendingPermissions.value.length }}
          </span>
          <span v-if="bridge.pendingDialogs.value.length > 0" class="chip chip--attention">
            <span class="dot dot--starting" />
            等待选择 · {{ bridge.pendingDialogs.value.length }}
          </span>
          <button class="chip" type="button" title="技能与子代理" @click="openCatalog">
            <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <path d="M8 1.8l1.7 3.6 3.9.5-2.9 2.7.8 3.9L8 10.6l-3.5 1.9.8-3.9L2.4 5.9l3.9-.5z" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round" />
            </svg>
            技能
            <span v-if="bridge.catalog.value?.ready" class="chip__count">{{ bridge.catalog.value.commands.length }}</span>
          </button>
          <span class="chip chip--static">
            <span class="dot" :class="`dot--${bridge.activeSession.value?.status ?? 'closed'}`" />
            {{ bridge.activeSession.value?.status ?? '—' }}
          </span>
        </header>

        <Transcript
          :events="bridge.events.value"
          :busy="bridge.isBusy.value"
          :mode="tab"
          :subagents="bridge.subagents.value"
          :is-subagent-launcher="bridge.isSubagentLauncher"
          @decide="onPermissionDecision"
          @answer="onDialogAnswer"
        />

        <Composer
          :disabled="!bridge.activeSessionId.value"
          :busy="bridge.isBusy.value"
          :awaiting-approval="bridge.pendingPermissions.value.length > 0"
          :awaiting-dialog="bridge.pendingDialogs.value.length > 0"
          :model="bridge.activeSession.value?.model ?? ''"
          :permission-mode="bridge.activeSession.value?.permissionMode ?? ''"
          :catalog-models="bridge.catalog.value?.models ?? []"
          :resolved-model="bridge.catalog.value?.resolvedModel ?? null"
          :has-credentials="bridge.activeSession.value?.hasCredential === true"
          @send="(text: string) => bridge.send(text)"
          @stop="bridge.stopSession()"
          @change-mode="onChangeMode"
          @change-model="onChangeModel"
          @open-settings="settingsOpen = true"
        />
      </template>
    </div>

    <DirectoryPicker
      v-if="pickerOpen"
      :initial-path="pickerStart"
      @select="onPickDirectory"
      @close="pickerOpen = false"
    />

    <CatalogPanel
      v-if="catalogOpen"
      :catalog="bridge.catalog.value"
      :active-model="bridge.activeSession.value?.model ?? null"
      :has-session="Boolean(bridge.activeSessionId.value)"
      @close="catalogOpen = false"
    />

    <SettingsPanel
      v-if="settingsOpen"
      :bridge="bridge"
      :catalog="bridge.catalog.value"
      :active-model="bridge.activeSession.value?.model ?? null"
      :session-permission-mode="bridge.activeSession.value?.permissionMode ?? null"
      :session-count="bridge.sessions.value.length"
      :loaded-skills="bridge.sessionInit.value?.skills ?? []"
      :loaded-plugins="(bridge.sessionInit.value?.plugins ?? []).map((p) => p.name)"
      :loaded-mcp-servers="bridge.sessionInit.value?.mcpServers ?? []"
      :audit-suggested-path="bridge.activeSession.value?.cwd ?? null"
      @close="settingsOpen = false"
      @apply-mode="onChangeMode"
      @new-session="settingsOpen = false; newSession()"
      @open-transcript="onOpenTranscript"
    />
  </div>
</template>
