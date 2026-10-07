/**
 * The single place the UI talks to the bridge.
 *
 * Transport is plain fetch + EventSource-style SSE reading over fetch, so the same code
 * works under `vite dev` (proxy) and inside the Tauri webview (direct 127.0.0.1).
 */
import { ref, shallowRef, computed } from 'vue'
import type {
  BridgeEvent,
  BundledInventory,
  Catalog,
  Discovery,
  Health,
  SessionView,
  TranscriptListing,
  UpdateCheck,
  UpdateProgress,
  VetReport,
  VetStatus,
  ProviderBalance,
} from '../types'

/**
 * A stable fingerprint of every field the UI derives from a session.
 *
 * Used to decide whether a polled session is genuinely unchanged. Listing fields by hand is what
 * caused a real bug — `model` was left out, so a model switch within one provider was invisible — so
 * this covers the whole object rather than a subset, with the pending queues reduced to their lengths
 * (their contents are not rendered; their counts are).
 */
function sessionSignature(session: SessionView): string {
  return JSON.stringify([
    session.status,
    session.model,
    session.resolvedModel,
    session.permissionMode,
    session.cwd,
    session.baseUrl,
    session.endpoint,
    session.historyLength,
    session.claudeSessionId,
    session.pendingPermissions?.length ?? 0,
    session.pendingDialogs?.length ?? 0,
    session.capabilities?.dialogKinds ?? null,
    session.capabilities?.subagentText ?? null,
  ])
}

/** Base URL resolution: an injected shell value wins, then the dev proxy, then localhost. */
function resolveBaseUrl(): string {
  const injected = (globalThis as Record<string, unknown>).__CCCN_BRIDGE_URL__
  if (typeof injected === 'string' && injected.length > 0) return injected.replace(/\/$/, '')
  const param = new URLSearchParams(location.search).get('bridge')
  if (param) return param.replace(/\/$/, '')
  // vite dev proxies /api, so an empty base is correct there.
  return import.meta.env.DEV ? '' : 'http://127.0.0.1:43130'
}

export function useBridge() {
  const baseUrl = ref(resolveBaseUrl())
  const health = ref<Health | null>(null)
  const discovery = shallowRef<Discovery | null>(null)
  const sessions = ref<SessionView[]>([])
  const events = ref<BridgeEvent[]>([])
  const activeSessionId = ref<string | null>(null)
  const connected = ref(false)
  const lastError = ref<string | null>(null)

  let streamAbort: AbortController | null = null
  let retryTimer: number | null = null
  let pollTimer: number | null = null

  const activeSession = computed(() => sessions.value.find((s) => s.id === activeSessionId.value) ?? null)

  /** A turn is in flight: either running, or parked on an approval the user must answer. */
  const isBusy = computed(() => {
    const status = activeSession.value?.status
    return status === 'busy' || status === 'awaiting_approval'
  })

  /** Unanswered permission asks, so the UI can surface them even when scrolled away. */
  const pendingPermissions = computed(() => activeSession.value?.pendingPermissions ?? [])

  /** Unanswered host dialogs (`request_user_dialog`). */
  const pendingDialogs = computed(() => activeSession.value?.pendingDialogs ?? [])

  /**
   * The session catalog: skills, subagent types and models, from the CLI's initialize reply.
   * Not in the polled session summary because the descriptions make it large.
   */
  const catalog = shallowRef<Catalog | null>(null)

  /** The installer's component inventory; independent of any session. */
  const bundled = shallowRef<BundledInventory | null>(null)

  /**
   * What the CLI reported as loaded for the active session, from its `system/init` frame.
   *
   * Read from the timeline rather than the catalog endpoint because these are init-frame fields;
   * the inventory panel compares them against what the bundle contains.
   */
  const sessionInit = computed(() => events.value.find((event) => event.kind === 'init') ?? null)

  /** Subagent transcripts, keyed by the tool_use id that launched each agent. */
  const subagents = computed(() => {
    const map = new Map<string, BridgeEvent[]>()
    for (const event of events.value) {
      const parent = event.parentToolUseId
      if (!parent) continue
      const list = map.get(parent)
      if (list) list.push(event)
      else map.set(parent, [event])
    }
    return map
  })

  /**
   * Tool names that launch a subagent. `Task` is what the CLI advertises today; the others are
   * included so a rename does not silently drop the nesting.
   */
  const SUBAGENT_TOOLS = new Set(['Task', 'Agent', 'Workflow'])

  function isSubagentLauncher(event: BridgeEvent): boolean {
    return event.kind === 'tool_use' && SUBAGENT_TOOLS.has(event.name ?? '')
  }

  /** Convenience buckets so components do not re-scan the event list. */
  const toolCalls = computed(() => {
    const map = new Map<string, { use: BridgeEvent; result?: BridgeEvent }>()
    for (const event of events.value) {
      if (event.kind === 'tool_use' && event.id) map.set(event.id, { use: event })
      if (event.kind === 'tool_result' && event.toolUseId) {
        const entry = map.get(event.toolUseId)
        if (entry) entry.result = event
      }
    }
    return [...map.values()]
  })

  const totals = computed(() => {
    let input = 0
    let output = 0
    let cacheRead = 0
    for (const event of events.value) {
      if (event.kind !== 'result' || !event.usage) continue
      input += event.usage.inputTokens
      output += event.usage.outputTokens
      cacheRead += event.usage.cacheReadTokens
    }
    return { input, output, cacheRead }
  })


  async function api<T>(path: string, init?: RequestInit): Promise<T> {
    const response = await fetch(`${baseUrl.value}${path}`, {
      ...init,
      headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
    })
    if (!response.ok) {
      const text = await response.text().catch(() => '')
      throw new Error(`${response.status} ${response.statusText}${text ? ': ' + text.slice(0, 300) : ''}`)
    }
    return (await response.json()) as T
  }

  async function refreshHealth() {
    try {
      health.value = await api<Health>('/api/health')
      connected.value = true
      lastError.value = null
    } catch (error) {
      connected.value = false
      lastError.value = String((error as Error).message ?? error)
    }
  }

  async function refreshDiscovery() {
    try {
      discovery.value = await api<Discovery>('/api/discovery')
    } catch (error) {
      lastError.value = String((error as Error).message ?? error)
    }
  }

  async function refreshSessions() {
    try {
      const result = await api<{ sessions: SessionView[] }>('/api/sessions')
      /**
       * Keep the previous OBJECT when nothing the UI reads has changed, so `:key`ed rows and derived
       * state do not thrash on every poll.
       *
       * The comparison must cover EVERY field the UI derives from — this previously tested only
       * `status` and `historyLength`, and switching a model to another model of the SAME provider
       * changes neither: the CLI stays `ready` and the transcript does not move. The client then kept
       * a stale `model` forever, which showed up as "switching the model does not change the balance"
       * (the balance follows the session's provider) and as a stale model chip.
       *
       * A signature over all of it is used rather than a field list, because a field list is exactly
       * the thing that goes stale the next time a field is added.
       */
      const previous = new Map(sessions.value.map((session) => [session.id, session]))
      const signatures = new Map(sessions.value.map((session) => [session.id, sessionSignature(session)]))
      sessions.value = result.sessions.map((session) => {
        const before = previous.get(session.id)
        return before && signatures.get(session.id) === sessionSignature(session) ? before : session
      })
    } catch (error) {
      lastError.value = String((error as Error).message ?? error)
    }
  }

  /**
   * The session list is server-owned and can change without this client asking: a session
   * created over the bridge API, another window, or the CLI makes the bridge announce one.
   * Without polling, the sidebar would never learn about it.
   */
  function startSessionPolling(intervalMs = 2500) {
    stopSessionPolling()
    pollTimer = window.setInterval(() => void refreshSessions(), intervalMs)
  }

  function stopSessionPolling() {
    if (pollTimer !== null) {
      window.clearInterval(pollTimer)
      pollTimer = null
    }
  }

  /** Open the SSE stream for a session and append every normalized event. */
  function attach(sessionId: string) {
    streamAbort?.abort()
    const controller = new AbortController()
    streamAbort = controller
    // Resume cursor: survives a reconnect so the bridge replays only what we missed.
    let lastSeq = 0
    if (activeSessionId.value === sessionId) {
      lastSeq = events.value.reduce((max, event) => Math.max(max, event.seq ?? 0), 0)
    } else {
      events.value = []
    }

    void (async () => {
      try {
        const response = await fetch(`${baseUrl.value}/api/sessions/${sessionId}/events`, {
          signal: controller.signal,
          headers: {
            accept: 'text/event-stream',
            ...(lastSeq > 0 ? { 'last-event-id': String(lastSeq) } : {}),
          },
        })
        if (!response.ok || !response.body) throw new Error(`stream failed: ${response.status}`)

        const reader = response.body.getReader()
        const decoder = new TextDecoder()
        let buffer = ''

        for (;;) {
          const { value, done } = await reader.read()
          if (done) break
          buffer += decoder.decode(value, { stream: true })
          let index: number
          while ((index = buffer.indexOf('\n\n')) >= 0) {
            const frame = buffer.slice(0, index)
            buffer = buffer.slice(index + 1)
            const dataLine = frame.split('\n').find((line) => line.startsWith('data: '))
            if (!dataLine) continue
            try {
              const event = JSON.parse(dataLine.slice(6)) as BridgeEvent
              // Drop anything at or below the cursor: a resumed stream can overlap.
              if (event.seq !== undefined && event.seq <= lastSeq) continue
              if (event.seq !== undefined) lastSeq = event.seq

              /**
               * Fold high-frequency streaming frames into one growing entry.
               *
               * The child runs with `--include-partial-messages`, so a single answer arrives as
               * hundreds of token fragments. Pushing each one would grow `events` without bound and
               * re-run every transcript computed on every fragment — the exact cost a live view must
               * not add. Appending to the previous fragment of the same block keeps the array the
               * size of a block-level stream while the text still grows in place.
               *
               * Progress ticks are replaced rather than appended for the same reason: only the newest
               * estimate is ever displayed.
               */
              if (event.kind === 'thinking_delta' || event.kind === 'text_delta') {
                const previous = events.value[events.value.length - 1]
                if (
                  previous &&
                  previous.kind === event.kind &&
                  previous.index === event.index &&
                  previous.parentToolUseId === event.parentToolUseId
                ) {
                  previous.text = (previous.text ?? '') + (event.text ?? '')
                  previous.at = event.at
                  continue
                }
              } else if (event.kind === 'thinking_tokens') {
                const previous = events.value[events.value.length - 1]
                if (previous?.kind === 'thinking_tokens') {
                  events.value[events.value.length - 1] = event
                  continue
                }
              }

              events.value.push(event)
              // A closed session ends the stream server-side; reflect it in the list.
              if (event.kind === 'closed') void refreshSessions()
            } catch {
              /* ignore malformed frame */
            }
          }
        }
      } catch (error) {
        if (controller.signal.aborted) return
        lastError.value = String((error as Error).message ?? error)
        // One automatic reconnect: the bridge may have been restarting.
        retryTimer = window.setTimeout(() => {
          if (activeSessionId.value === sessionId) attach(sessionId)
        }, 1500)
      }
    })()
  }

  async function createSession(
    options: {
      cwd: string
      model?: string
      permissionMode?: string
      baseUrl?: string
      authToken?: string
      /**
       * Reopen an existing Claude Code conversation by its session id.
       *
       * Forwarded because the bridge route already accepts it: the CLI's `--resume` is what makes a
       * past conversation continuable, and dropping it here would silently start an empty session
       * that looks like context loss.
       */
      resumeSessionId?: string
      /**
       * Reasoning effort pinned to the chosen model.
       *
       * Travels to the CLI as a `--effort` argument at spawn, so it is read from the model's own
       * settings rather than chosen per turn. Absent leaves the CLI on its model default.
       */
      effort?: string
    } = { cwd: '' },
  ) {
    const session = await api<SessionView>('/api/sessions', {
      method: 'POST',
      body: JSON.stringify(options),
    })
    await refreshSessions()
    return session
  }

  async function openSession(sessionId: string) {
    activeSessionId.value = sessionId
    events.value = []
    attach(sessionId)
    // The catalog is per-session (the CLI reports it in its own initialize reply), so it
    // must be re-fetched whenever the active session changes. Not awaited: the reply can be
    // seconds away and opening a session must not block on the handshake.
    void refreshCatalogWhenReady(sessionId)
  }

  async function send(text: string) {
    if (!activeSessionId.value) throw new Error('no active session')
    await api(`/api/sessions/${activeSessionId.value}/messages`, {
      method: 'POST',
      body: JSON.stringify({ text }),
    })
  }

  /**
   * Remove a session from the list entirely.
   *
   * Distinct from `stopSession`, which leaves the entry in place: a workspace is only a grouping
   * of sessions, so removing its last session is what makes the workspace disappear.
   */
  async function removeSession(sessionId: string) {
    await api(`/api/sessions/${sessionId}?purge=1`, { method: 'DELETE' })
    if (activeSessionId.value === sessionId) {
      detach()
      activeSessionId.value = null
      events.value = []
      catalog.value = null
    }
    await refreshSessions()
  }

  /** Remove every session under one working directory. */
  async function removeWorkspace(cwd: string) {
    const victims = sessions.value.filter((session) => (session.cwd ?? '未指定目录') === cwd)
    for (const session of victims) {
      await api(`/api/sessions/${session.id}?purge=1`, { method: 'DELETE' }).catch(() => null)
    }
    if (victims.some((session) => session.id === activeSessionId.value)) {
      detach()
      activeSessionId.value = null
      events.value = []
      catalog.value = null
    }
    await refreshSessions()
  }

  async function stopSession(sessionId = activeSessionId.value) {
    if (!sessionId) return
    await api(`/api/sessions/${sessionId}`, { method: 'DELETE' })
    await refreshSessions()
  }

  /**
   * Switch the running session's model.
   *
   * `baseUrl`/`apiKey` are only sent when the chosen model belongs to a DIFFERENT provider:
   * a base URL is an environment variable of the CLI child and cannot be changed by a control
   * request, so the bridge restarts the process (resuming the conversation) in that case. Within
   * one provider the switch is a plain control request and nothing is restarted.
   *
   * An empty model resets to the session default, which is the control request's own semantics
   * for null/'default'.
   */
  async function setModel(
    model: string,
    options: { baseUrl?: string; apiKey?: string; effort?: string } = {},
    sessionId = activeSessionId.value,
  ) {
    if (!sessionId) throw new Error('no active session')
    const result = await api<{ ok: boolean; mode: 'in-session' | 'restarted' }>(
      `/api/sessions/${sessionId}/model`,
      {
        method: 'POST',
        body: JSON.stringify({ model, baseUrl: options.baseUrl, apiKey: options.apiKey, effort: options.effort }),
      },
    )
    // A restart replaces the child process, so the event stream has to be re-attached and the
    // catalog re-fetched; the in-session path only needs the catalog.
    // The bridge restarts for an effort change too — that is not a control request either.
    if (result.mode === 'restarted') {
      events.value = []
      attach(sessionId)
    }
    await refreshSessions()
    // A restart tears the child down and re-runs the initialize handshake, so the catalog has to
    // be waited for again rather than read from the reply of the process that just died.
    void refreshCatalogWhenReady(sessionId)
    return result
  }

  /**
   * Switch the running session's permission mode.
   *
   * Uses the CLI's set_permission_mode control request, so an escalation takes effect on the
   * live session instead of requiring a relaunch (which would drop the conversation).
   */
  async function setPermissionMode(mode: string, sessionId = activeSessionId.value) {
    if (!sessionId) throw new Error('no active session')
    await api(`/api/sessions/${sessionId}/permission-mode`, {
      method: 'POST',
      body: JSON.stringify({ mode }),
    })
    await refreshSessions()
  }

  /**
   * Answer a pending permission ask.
   *
   * `scope: 'session'` accepts the CLI's own suggestion (e.g. "always allow this tool for
   * this session") instead of a one-off approval.
   */
  async function respondPermission(
    requestId: string,
    behavior: 'allow' | 'deny',
    scope: 'once' | 'session' = 'once',
    sessionId = activeSessionId.value,
  ) {
    if (!sessionId) throw new Error('no active session')
    await api(`/api/sessions/${sessionId}/permissions`, {
      method: 'POST',
      body: JSON.stringify({ requestId, behavior, scope }),
    })
    await refreshSessions()
  }

  /** Pending asks, for a client that attaches after they were raised. */
  async function refreshPendingPermissions(sessionId = activeSessionId.value) {
    if (!sessionId) return []
    const result = await api<{ pending: Array<Record<string, unknown>> }>(
      `/api/sessions/${sessionId}/permissions`,
    )
    return result.pending ?? []
  }

  /**
   * What the installer shipped, and whether each file is actually present.
   *
   * Distinct from the session catalog: that reports what the CLI LOADED for a session, this
   * reports what the bundle CONTAINS. A component can be present but not loaded, and that gap is
   * exactly what an inventory exists to show.
   */
  async function refreshBundled() {
    try {
      bundled.value = await api<BundledInventory>('/api/bundled')
      return bundled.value
    } catch (error) {
      lastError.value = String((error as Error).message ?? error)
      return null
    }
  }

  /**
   * Existing Claude Code conversations on disk, newest first.
   *
   * Not cached in a ref: the listing is read on demand and can be large, and the panel that shows
   * it owns the query state.
   */
  async function listTranscripts(query = ''): Promise<TranscriptListing> {
    const suffix = query.trim() ? `?q=${encodeURIComponent(query.trim())}` : ''
    return api<TranscriptListing>(`/api/transcripts${suffix}`)
  }

  /** Markdown for one transcript. Read-only: the transcript itself is never rewritten. */
  async function exportTranscript(sessionId: string): Promise<{ markdown: string }> {
    return api<{ markdown: string }>('/api/transcripts/export', {
      method: 'POST',
      body: JSON.stringify({ sessionId }),
    })
  }

  /**
   * Store attached files and get back the paths to put in the prompt.
   *
   * The bytes go to the bridge because a webview cannot write to disk: `<input type="file">` yields
   * a File object with no usable path in a browser. Doing it this way keeps `vite dev` and the Tauri
   * webview identical, the same rule the directory picker follows.
   */
  async function saveAttachments(
    files: Array<{ name: string; dataUrl: string }>,
  ): Promise<{
    ok: boolean
    root?: string
    error?: string
    results: Array<{ ok: boolean; name: string; path?: string; bytes?: number; error?: string }>
  }> {
    return api('/api/attachments', {
      method: 'POST',
      body: JSON.stringify({ files }),
    })
  }

  /**
   * Test one endpoint + key + model combination with a real (tiny) Messages call.
   *
   * Routed through the bridge for the same reason as the balance: the page cannot reach a vendor that
   * sends no permissive CORS headers. A failed test comes back as DATA, not an exception, because the
   * caller is a form that must show the reason.
   */
  async function testConnection(provider: {
    baseUrl: string
    apiKey: string
    model: string
  }): Promise<{ ok: boolean; status: number | null; latencyMs: number; message: string; model: string }> {
    return api('/api/test-connection', {
      method: 'POST',
      body: JSON.stringify(provider),
    })
  }

  /** Whether the vendored audit engine is present, and why not when it is missing. */
  async function vetStatus(): Promise<VetStatus> {
    return api<VetStatus>('/api/vet/status')
  }

  /**
   * Ask whether a newer release exists.
   *
   * Resolves even when nothing was reachable — the bridge reports that as `ok: false` rather than an
   * error, because for this app an unreachable github.com is an ordinary condition and startup must
   * not depend on it.
   */
  async function checkUpdate(): Promise<UpdateCheck> {
    return api<UpdateCheck>('/api/update')
  }

  /** Start downloading the installer the last check found; progress is polled separately. */
  async function startUpdateDownload(): Promise<{ started?: boolean; error?: string; progress?: UpdateProgress }> {
    return api('/api/update/download', { method: 'POST', body: JSON.stringify({}) })
  }

  /** Poll the download's progress. One long response is easier to poll than to stream. */
  async function updateStatus(): Promise<UpdateProgress> {
    return api<UpdateProgress>('/api/update/status')
  }

  /** Launch the downloaded installer. The window must then close so it can replace the app's files. */
  async function installUpdate(): Promise<{ started?: boolean; error?: string }> {
    return api('/api/update/install', { method: 'POST', body: JSON.stringify({}) })
  }

  /**
   * Ask the provider for the account balance.
   *
   * Routed through the bridge rather than fetched from the page: the bridge is not subject to CORS,
   * so a provider that sends no permissive headers still works. A failure comes back as DATA
   * (`available: false` plus a reason) instead of throwing, because the sidebar must render
   * something honest rather than disappear.
   */
  async function fetchBalance(provider: {
    baseUrl: string
    apiKey: string
    balanceUrl?: string
    balancePath?: string
    currency?: string
  }): Promise<ProviderBalance> {
    return api<ProviderBalance>('/api/balance', {
      method: 'POST',
      body: JSON.stringify(provider),
    })
  }

  /**
   * Audit a directory.
   *
   * The bridge answers 200 with `ok: false` for an audit that could not run, so the caller must
   * check `ok` rather than the HTTP status — "could not audit" is not an HTTP error, and treating it
   * as one would hide the reason behind a generic fetch failure.
   */
  async function vetScan(
    path: string,
    options: { scanBasis?: 'git' | 'npm'; osv?: boolean } = {},
  ): Promise<{ ok: boolean; error?: string; report?: VetReport; meta?: Record<string, unknown> }> {
    return api('/api/vet/scan', {
      method: 'POST',
      body: JSON.stringify({ path, ...options }),
    })
  }

  /** Load the skill / subagent / model catalog for the active session. */
  async function refreshCatalog(sessionId = activeSessionId.value) {
    if (!sessionId) {
      catalog.value = null
      return null
    }
    try {
      const result = await api<Catalog>(`/api/sessions/${sessionId}/catalog`)
      // A slow reply can land after the user switched sessions; it must not overwrite the
      // catalog of the session now on screen.
      if (activeSessionId.value === sessionId) catalog.value = result
      return result
    } catch (error) {
      lastError.value = String((error as Error).message ?? error)
      return null
    }
  }

  /**
   * Fetch the catalog, waiting for the CLI's `initialize` reply if it has not landed yet.
   *
   * The catalog CANNOT exist at session-creation time: it is reported in the CLI's reply to our
   * `initialize` control request, and that reply only arrives once the child has booted and
   * probed its endpoint. A single fetch at attach time therefore races the handshake — and when
   * it loses, `ready` stays false and every count stays 0 with the panel parked on
   * "等待 CLI 的 initialize 握手返回目录…" forever. That is exactly what happened against a real
   * endpoint, where the reply lands seconds later; the development machine was fast enough to win
   * the race, which made a frontend bug look like a packaging problem.
   *
   * Bounded, not indefinite: a session whose CLI died must not poll for the rest of the day. Also
   * abandons the loop as soon as the user moves to another session.
   */
  async function refreshCatalogWhenReady(sessionId = activeSessionId.value, budgetMs = 45000) {
    const deadline = Date.now() + budgetMs
    let delay = 400
    for (;;) {
      const result = await refreshCatalog(sessionId)
      if (result?.ready) return result
      if (!sessionId || activeSessionId.value !== sessionId) return result
      if (Date.now() >= deadline) return result
      await new Promise((resolve) => window.setTimeout(resolve, delay))
      // Back off, so a session that never answers costs a few dozen requests rather than hundreds.
      delay = Math.min(delay * 1.5, 3000)
    }
  }

  /**
   * Answer a host dialog.
   *
   * `result` is dialog-kind specific and the protocol transports it opaquely; `cancelled`
   * makes the CLI apply that dialog's default behaviour.
   */
  async function respondDialog(
    requestId: string,
    behavior: 'completed' | 'cancelled',
    result?: unknown,
    sessionId = activeSessionId.value,
  ) {
    if (!sessionId) throw new Error('no active session')
    await api(`/api/sessions/${sessionId}/dialogs`, {
      method: 'POST',
      body: JSON.stringify({ requestId, behavior, result }),
    })
    await refreshSessions()
  }

  function detach() {
    streamAbort?.abort()
    streamAbort = null
    if (retryTimer !== null) window.clearTimeout(retryTimer)
    stopSessionPolling()
  }

  return {
    baseUrl,
    health,
    discovery,
    sessions,
    events,
    activeSessionId,
    activeSession,
    connected,
    lastError,
    isBusy,
    pendingPermissions,
    pendingDialogs,
    catalog,
    bundled,
    sessionInit,
    refreshBundled,
    subagents,
    isSubagentLauncher,
    toolCalls,
    totals,
    refreshHealth,
    refreshDiscovery,
    refreshSessions,
    startSessionPolling,
    stopSessionPolling,
    createSession,
    openSession,
    send,
    stopSession,
    removeSession,
    removeWorkspace,
    respondPermission,
    refreshPendingPermissions,
    refreshCatalog,
    refreshCatalogWhenReady,
    listTranscripts,
    exportTranscript,
    vetStatus,
    checkUpdate,
    startUpdateDownload,
    updateStatus,
    installUpdate,
    vetScan,
    fetchBalance,
    saveAttachments,
    testConnection,
    respondDialog,
    setPermissionMode,
    setModel,
    detach,
    setBaseUrl(next: string) {
      baseUrl.value = next.replace(/\/$/, '')
    },
  }
}

export type Bridge = ReturnType<typeof useBridge>

/** Human-readable byte/compact formatting helpers shared by the views. */
export function formatNumber(value: number): string {
  return new Intl.NumberFormat('zh-CN').format(value)
}

export function formatDuration(ms?: number): string {
  if (!ms || ms < 0) return '—'
  if (ms < 1000) return `${ms} ms`
  return `${(ms / 1000).toFixed(ms < 10000 ? 1 : 0)} s`
}

export function formatTime(at: number): string {
  return new Date(at).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' })
}
