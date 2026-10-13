/**
 * The bridge client behind the top menu bar.
 *
 * WHY THIS IS SEPARATE FROM `useBridge`: that composable owns the SESSION — the SSE timeline, the
 * active session, permissions, dialogs. Everything behind the menu bar is the opposite: shell state
 * that exists with no session at all (logs, the plugin list, the author card). Folding them together
 * would make every menu window depend on session wiring it does not use.
 *
 * Base-URL resolution is intentionally identical to `useBridge`'s, character for character: two
 * resolvers that disagree would send half the app to a different port than the other half, which is
 * exactly the class of bug that only shows up on someone else's machine.
 */

/** The bridge origin, without a trailing slash. Empty in `vite dev`, where the dev server proxies. */
export function shellBaseUrl(): string {
  const injected = (globalThis as Record<string, unknown>).__CCCN_BRIDGE_URL__
  if (typeof injected === 'string' && injected.length > 0) return injected.replace(/\/$/, '')
  const param = new URLSearchParams(location.search).get('bridge')
  if (param) return param.replace(/\/$/, '')
  return import.meta.env.DEV ? '' : 'http://127.0.0.1:43130'
}

/** An HTTP status the bridge answered with, carrying its own Chinese sentence. */
export class ShellApiError extends Error {
  readonly status: number

  constructor(message: string, status: number) {
    super(message)
    this.name = 'ShellApiError'
    this.status = status
  }
}

/**
 * One request, decoded.
 *
 * A non-2xx answer is turned into an error carrying the bridge's `error` sentence, because those
 * sentences are written for the user ("这不是一个 git 仓库") and re-deriving them here would lose that.
 */
export async function shellRequest<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${shellBaseUrl()}${path}`, {
    ...init,
    headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
  })
  if (!response.ok) {
    let message = `HTTP ${response.status}`
    try {
      const body = (await response.json()) as { error?: unknown }
      if (typeof body?.error === 'string' && body.error !== '') message = body.error
    } catch {
      // A body that is not JSON keeps the status-derived message.
    }
    throw new ShellApiError(message, response.status)
  }
  return (await response.json()) as T
}

/** GET with query parameters; `undefined` values are dropped rather than serialised as "undefined". */
export function shellGet<T>(path: string, params: Record<string, string | number | boolean | undefined> = {}): Promise<T> {
  const query = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== '') query.set(key, String(value))
  }
  const suffix = query.toString() === '' ? '' : `?${query.toString()}`
  return shellRequest<T>(`${path}${suffix}`)
}

/** POST a JSON body. */
export function shellPost<T>(path: string, body: unknown = {}): Promise<T> {
  return shellRequest<T>(path, { method: 'POST', body: JSON.stringify(body) })
}

/**
 * Call a command defined in the Tauri shell (restart / quit / devtools).
 *
 * Tauri injects `__TAURI_INTERNALS__` into every page it hosts, including with
 * `withGlobalTauri: false` (that flag only controls the convenience `__TAURI__` global). The call is
 * still written defensively: in `vite dev` — and in any browser tab pointed at the dev server —
 * there is no shell to call, and that must produce `{ ok: false }` rather than an exception the menu
 * handler would have to guess about.
 */
export async function invokeShell<T = unknown>(command: string, args: Record<string, unknown> = {}): Promise<{ ok: boolean; value?: T; error?: string }> {
  const internals = (globalThis as Record<string, unknown>).__TAURI_INTERNALS__ as
    | { invoke?: (cmd: string, args: Record<string, unknown>) => Promise<unknown> }
    | undefined
  if (!internals || typeof internals.invoke !== 'function') {
    return { ok: false, error: '当前不在桌面外壳中运行（浏览器预览模式）' }
  }
  try {
    const value = (await internals.invoke(command, args)) as T
    return { ok: true, value }
  } catch (error) {
    return { ok: false, error: String((error as { message?: string })?.message ?? error) }
  }
}

/** `1.4 MB` / `812 KB` / `96 B` — sizes in a log window are read, not calculated. */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB']
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  return `${value >= 10 || unit === 0 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`
}

/** Local wall-clock time, seconds precision — what a log line actually needs. */
export function formatClock(at: number): string {
  const date = new Date(at)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
}

/** `刚刚` / `3 分钟前` / `2 天前` — relative time for lists that are read at a glance. */
export function formatAgo(at: number): string {
  const seconds = Math.max(0, Math.round((Date.now() - at) / 1000))
  if (seconds < 45) return '刚刚'
  if (seconds < 3600) return `${Math.round(seconds / 60)} 分钟前`
  if (seconds < 86400) return `${Math.round(seconds / 3600)} 小时前`
  return `${Math.round(seconds / 86400)} 天前`
}
