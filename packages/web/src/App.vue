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
import SplashScreen from './components/SplashScreen.vue'
import UpdateDialog from './components/UpdateDialog.vue'
import { useSettings, parseModelRef } from './composables/useSettings'
import type { ProviderBalance, TranscriptSummary, UpdateCheck } from './types'
import { priceEvents, isPeak } from '../../bridge/src/pricing.mjs'

const bridge = useBridge()
const store = useSettings()

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
const setupOpen = ref(true)
const starting = ref(false)
const startError = ref<string | null>(null)
const pickerOpen = ref(false)
const catalogOpen = ref(false)
const settingsOpen = ref(false)
const sidebarCollapsed = ref(false)
const tab = ref<'chat' | 'trace'>('chat')
/** Set when the user explicitly asks for a new session, so polling never overrides it. */
const setupPinnedByUser = ref(false)

/**
 * How long the launch splash stays up.
 *
 * A PRODUCT choice, not a technical one. The app is normally ready in well under a second, so almost
 * all of this is the animation playing — it is a fixed cost paid on EVERY launch, forever. Named here
 * rather than buried in the component so it is one edit to change; set it to 0 to skip the splash.
 */
const SPLASH_MS = 7000
const splashOpen = ref(true)

/**
 * The available update, if any.
 *
 * Checked only AFTER the app is usable, and never awaited on the startup path: the request goes to
 * github.com / gitee.com, which for this app's users is frequently unreachable, and launching must
 * not wait on — or fail because of — a host that has nothing to do with running a session.
 */
const updateCheck = ref<UpdateCheck | null>(null)
const updateOpen = ref(false)

async function checkForUpdates() {
  try {
    const result = await bridge.checkUpdate()
    // Surfaced only when there is something to INSTALL. A source can report a version without being
    // able to serve the file — Gitee caps attachments at 100 MB and the installer is ~230 MB — and
    // raising a dialog whose only button then fails would be worse than saying nothing.
    if (result.ok && result.available && result.installable && result.asset) {
      updateCheck.value = result
      updateOpen.value = true
    }
  } catch {
    // Unreachable is an ordinary outcome here: the app simply has no update to offer.
  }
}

/**
 * Reasoning effort of the running session; '' means the model's own default.
 *
 * Mirrored into a ref rather than read straight off the session object: an effort change relaunches
 * the child, so the level the user just picked leads the session by a moment, and the picker must not
 * snap back to the old one while the restart is in flight.
 */
const sessionEffort = ref('')

watch(
  () => bridge.activeSession.value?.effort ?? '',
  (value) => {
    sessionEffort.value = value ?? ''
  },
  { immediate: true },
)

const binaryPath = computed(() => bridge.discovery.value?.binary?.path ?? null)
const binaryMissing = computed(() => bridge.discovery.value !== null && binaryPath.value === null)

/** Projects the CLI already knows about, as one-click workspace shortcuts. */
const recentProjects = computed(() => (bridge.discovery.value?.projects ?? []).slice(0, 6))

/**
 * The user's home directory, read once from the bridge.
 *
 * Needed because a session has to run somewhere and a first run has no project history to fall back
 * on — the bridge resolves `~` itself, but the shell has to name a starting folder.
 */
const homeDir = ref('')

/**
 * Where a new session runs, without asking.
 *
 * Most recent project first, else home. "New session" used to open a form whose first required field
 * was a directory, so the common case — the same project as last time — cost a click and a decision
 * every single time. The picker stays reachable from the top bar for when it is genuinely elsewhere.
 */
const defaultWorkspace = computed(() => recentProjects.value[0]?.path ?? homeDir.value)

/** Directory the picker should open on: a real project if we know one, else home. */
const pickerStart = computed(() => recentProjects.value[0]?.path ?? homeDir.value)

/** Providers configured in settings. */
const configuredProviders = computed(() => store.settings.value.providers)
const hasProviders = computed(() => configuredProviders.value.length > 0)

/**
 * The (provider, model) pair a new session starts on: the default provider's first model.
 *
 * There is no longer a separate "default model" setting. Two controls for one decision is what let a
 * stale model reference keep selecting a model its provider no longer served.
 */
const boundModel = computed(() => store.defaultModelOption())

/** Whether anything is bound at all. The one condition that gates starting a session. */
const hasBoundModel = computed(() => boundModel.value !== null)

/**
 * Bound, but its provider holds no credential.
 *
 * Reported separately from "not bound" because it fails in a completely different place: the session
 * starts fine and then every request 401s, which reads as a broken app rather than as missing setup.
 */
const boundModelMissingKey = computed(() => {
  const chosen = boundModel.value
  return chosen !== null && !chosen.apiKey
})

/** The endpoint the placeholder screen names, so "which account is this about to use" is answered. */
const boundEndpoint = computed(() => {
  const chosen = boundModel.value
  if (!chosen) return null
  return { name: chosen.providerName, baseUrl: chosen.baseUrl, model: chosen.model }
})

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

/** Last path segment, which is what identifies a project in a narrow chip. */
function shortPath(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean)
  return parts[parts.length - 1] ?? path
}

/**
 * Picking a directory STARTS a session there.
 *
 * The picker used to fill a field in a form that was submitted later. With the form gone, choosing a
 * folder is the whole instruction — there is nothing left to submit it to.
 */
function onPickDirectory(path: string) {
  pickerOpen.value = false
  void createSessionIn(path)
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
 *
 * `effort` is deliberately NOT sent: it is a session-level choice the user makes in the composer, so
 * a model switch must carry it across rather than reset it. The bridge leaves it untouched when the
 * field is absent — and it used to be sent as the model's own pinned level, which since effort moved
 * out of settings is always empty, meaning every model switch silently cleared it.
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
    })
  } catch (error) {
    startError.value = String((error as Error).message ?? error)
  }
}

/**
 * Switching the running session's reasoning effort.
 *
 * No endpoint or credential is sent: an effort change must not move the session to a different
 * provider, and the bridge leaves both alone when they are absent. What it does do is relaunch the
 * child, because `--effort` is a spawn argument with no control request behind it — the conversation
 * is resumed rather than lost, and the composer says so next to the choices.
 *
 * The value is set optimistically because the relaunch takes a moment, and the watch on the session
 * reconciles it if the bridge reports something else.
 */
async function onChangeEffort(level: string) {
  const session = bridge.activeSession.value
  if (!session) return
  const previous = sessionEffort.value
  sessionEffort.value = level
  try {
    await bridge.setModel(session.model ?? '', { effort: level })
  } catch (error) {
    sessionEffort.value = previous
    startError.value = String((error as Error).message ?? error)
  }
}

onMounted(async () => {
  await bridge.refreshHealth()
  await bridge.refreshDiscovery()
  await bridge.refreshSessions()

  const discovered = bridge.discovery.value
  if (discovered) {
    // The home directory, for a first run that has no project history to fall back on.
    try {
      const result = await fetch(`${bridge.baseUrl.value}/api/directories/roots`).then((r) => r.json())
      const roots: Array<{ label: string; path: string }> = result.roots ?? []
      homeDir.value = roots.find((root) => root.label === '主目录')?.path ?? roots[0]?.path ?? ''
    } catch {
      // Left empty on failure; the bridge falls back to its own working directory.
    }
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

  /**
   * Auto-start on first open.
   *
   * A bound model means the app already knows the endpoint, the credential, the model and the folder,
   * so there is nothing left to ask — which is the entire point of removing the form. Skipped when a
   * dev affordance or an explicit `?session=` is driving the view, so those stay reproducible, and
   * skipped when nothing is bound, where the placeholder screen takes over instead.
   */
  const pinnedByUrl = Boolean(requestedSession) || params.get('picker') === '1' || params.get('catalog') === '1'
  if (setupOpen.value && !pinnedByUrl && hasBoundModel.value) {
    void createSessionIn(defaultWorkspace.value)
  }

  // Deliberately NOT awaited: the update check must never delay or block the app coming up.
  void checkForUpdates()
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
 * Start a session in `cwd` on the bound model.
 *
 * Everything the old setup form asked for is now RESOLVED rather than requested: the endpoint and key
 * come from the provider that owns the model, the model from that provider's own list, and the
 * permission mode from the saved default. Each stays changeable afterwards — model and mode from the
 * composer, directory from the picker — so none of them needs to be a precondition for starting.
 */
async function createSessionIn(cwd: string) {
  const chosen = boundModel.value
  if (!chosen) {
    // Nothing is bound: show the placeholder rather than create a session that cannot answer.
    setupOpen.value = true
    setupPinnedByUser.value = true
    startError.value = null
    return
  }

  starting.value = true
  startError.value = null
  /**
   * Pin while the session is being created.
   *
   * The adoption watcher fires when the session count changes, and `bridge.createSession` changes it —
   * so without this it would race this function and attach to the session we are already attaching to.
   * The pin stays on failure as well: an error screen is what the user is looking at, and having a
   * session appear under it would hide the reason it failed.
   */
  setupPinnedByUser.value = true
  try {
    const session = await bridge.createSession({
      cwd: cwd.trim(),
      model: chosen.model || undefined,
      permissionMode: newSessionPreset.value.mode,
      baseUrl: chosen.baseUrl || undefined,
      authToken: chosen.apiKey || undefined,
      // Empty means "model default" and is dropped by the bridge rather than sent as a level.
      effort: chosen.effort || undefined,
    })
    await bridge.openSession(session.id)
    setupOpen.value = false
    setupPinnedByUser.value = false
  } catch (error) {
    startError.value = String((error as Error).message ?? error)
    setupOpen.value = true
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
  const chosen = boundModel.value
  if (!chosen) {
    // Resuming still needs an endpoint: the conversation continues through this app, not around it.
    startError.value = '还没有绑定模型：请先到「设置 → 模型」添加服务商与模型，再继续会话。'
    settingsOpen.value = true
    return
  }
  try {
    const session = await bridge.createSession({
      // The transcript's own cwd, not the default workspace's: resuming against a different directory
      // would leave the CLI unable to find the conversation it was asked to resume.
      cwd: transcript.cwd || defaultWorkspace.value,
      resumeSessionId: transcript.sessionId,
      model: chosen.model || undefined,
      permissionMode: newSessionPreset.value.mode,
      baseUrl: chosen.baseUrl || undefined,
      authToken: chosen.apiKey || undefined,
      effort: chosen.effort || undefined,
    })
    await bridge.openSession(session.id)
    settingsOpen.value = false
    setupOpen.value = false
    setupPinnedByUser.value = false
  } catch (error) {
    startError.value = `继续该会话失败：${String((error as Error).message ?? error)}`
  }
}

/**
 * New session: create one, do not open a form.
 *
 * A request that opens a questionnaire is a request the user must finish before they can do the thing
 * they asked for. With nothing bound there is genuinely nothing to start, so that case points at where
 * to bind a model instead of showing a form that could not succeed.
 */
function newSession() {
  startError.value = null
  if (!hasBoundModel.value) {
    setupOpen.value = true
    setupPinnedByUser.value = true
    return
  }
  void createSessionIn(defaultWorkspace.value)
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
      <!--
        Placeholder screen. Reached only when a session cannot simply be started: nothing is bound
        yet, or an auto-start failed. It is deliberately NOT a form — everything the old form asked
        for (directory, model, endpoint, key, permission mode) is already stored in settings, so
        asking again would be asking the user to type back what they already told us.
      -->
      <div v-if="setupOpen" class="setup">
        <div class="setup__panel">
          <div class="setup__intro">
            <span class="setup__eyebrow">首次启动</span>
            <h1 class="setup__title">{{ hasBoundModel ? '正在新建会话…' : '您还未绑定模型' }}</h1>
            <p class="setup__sub">
              <template v-if="hasBoundModel">
                Claude Code 以本机进程运行，模型走 Anthropic 兼容端点；凭据只随本次请求传给本地桥。
              </template>
              <template v-else>
                请到「设置 → 模型」绑定服务商与模型。绑定后新建会话会直接开始，不需要再填任何信息。
              </template>
            </p>

            <div v-if="!bridge.connected.value" class="banner banner--error">
              未连接到本地桥接服务。{{ bridge.lastError.value }}
            </div>

            <div v-if="binaryMissing" class="banner banner--error">
              未找到 claude.exe。请用 npmmirror 安装
              <code>npm i -g @anthropic-ai/claude-code</code>，或用
              <code>CCCN_CLAUDE_BINARY</code> 指定路径。
            </div>

            <!-- Which endpoint and model are about to be used, stated before they are used. -->
            <div v-if="boundEndpoint" class="endpointLine">
              <span class="endpointLine__name">{{ boundEndpoint.name }} · {{ boundEndpoint.model }}</span>
              <code class="endpointLine__url">{{ boundEndpoint.baseUrl }}</code>
              <span v-if="!boundModelMissingKey" class="endpointLine__ok">已配置 Key</span>
              <span v-else class="endpointLine__warn">缺少 API-KEY</span>
            </div>

            <div v-if="boundModelMissingKey" class="banner banner--error">
              「{{ boundEndpoint?.name }}」还没有 API-KEY。请到「设置 → 模型」补上，否则会话会因鉴权失败而无法使用。
            </div>

            <div v-if="startError" class="banner banner--error">{{ startError }}</div>

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
              <label class="field__label">工作目录</label>
              <div class="field__row">
                <input :value="defaultWorkspace" class="field__input" spellcheck="false" readonly />
                <button class="btnGhost" type="button" @click="pickerOpen = true">浏览…</button>
              </div>
              <div class="field__hint">
                新会话直接在这里开始，不再让你每次重填。
                <template v-if="recentProjects.length > 0">默认取最近使用的项目。</template>
                <template v-else>目前没有历史项目，默认取主目录。</template>
              </div>
            </div>

            <div v-if="recentProjects.length > 1" class="recent">
              <span class="recent__label">换个项目开始</span>
              <button
                v-for="project in recentProjects"
                :key="project.path"
                class="recent__item"
                type="button"
                :title="project.path"
                @click="createSessionIn(project.path)"
              >
                {{ shortPath(project.path) }}
              </button>
            </div>

            <div class="setup__actions">
              <button
                v-if="!hasBoundModel || boundModelMissingKey"
                class="btnPrimary"
                type="button"
                @click="settingsOpen = true"
              >
                打开设置 · 绑定模型
              </button>
              <button
                v-else
                class="btnPrimary"
                type="button"
                :disabled="starting || !bridge.connected.value"
                @click="createSessionIn(defaultWorkspace)"
              >
                <span v-if="starting" class="spinner" />
                {{ starting ? '正在启动 claude.exe…' : '开始会话' }}
              </button>
            </div>

            <div class="field__hint">
              模型用默认服务商的第一个模型，权限模式用「设置 → 权限」里的默认值；
              会话开始后两者都可以随时切换。
            </div>
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
          <!--
            The working directory is a button, not a label. With the setup form gone this is the only
            place left to say "run the next session somewhere else" — and losing that would be a worse
            trade than the form it replaced.
          -->
          <button
            class="topBar__title topBar__title--action"
            type="button"
            title="切换工作目录（会在该目录下新建会话）"
            @click="pickerOpen = true"
          >
            {{ bridge.activeSession.value?.cwd ?? '未选择工作目录' }}
          </button>
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
          :effort="sessionEffort"
          :catalog-models="bridge.catalog.value?.models ?? []"
          :resolved-model="bridge.catalog.value?.resolvedModel ?? null"
          :has-credentials="bridge.activeSession.value?.hasCredential === true"
          @send="(text: string) => bridge.send(text)"
          @stop="bridge.stopSession()"
          @change-mode="onChangeMode"
          @change-model="onChangeModel"
          @change-effort="onChangeEffort"
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

    <!--
      Update prompt. Rendered above everything else because it is the one thing that can end the
      session: accepting it launches the installer and closes the window.
    -->
    <UpdateDialog
      v-if="updateOpen && updateCheck"
      :check="updateCheck"
      :bridge="bridge"
      @close="updateOpen = false"
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

    <!--
      Launch splash, last in the DOM so it covers everything. It is an overlay, NOT a replacement
      for the app: the shell mounts and initialises underneath it, so the main screen is already
      ready when this lifts.
    -->
    <SplashScreen v-if="splashOpen" :duration-ms="SPLASH_MS" @done="splashOpen = false" />
  </div>
</template>
