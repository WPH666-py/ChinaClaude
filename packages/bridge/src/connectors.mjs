/**
 * 连接器：把「上游插件提供的服务商」变成本应用能真正使用的一条模型通道。
 *
 * WHY THIS IS NOT JUST A MODEL PRESET: the reference app (Harness-CN) works because it HOSTS the
 * upstream plugin adapters — it can speak a vendor's private SSE and hand the result to its own
 * tool loop. This app runs `claude.exe`, which speaks one protocol only: Anthropic Messages at
 * `${baseUrl}/v1/messages`. So a connector here is only honest when the upstream offers exactly that
 * protocol. The three upstream plugins researched split cleanly on this line:
 *
 *   dsh-opencode-go  → offers `/anthropic/v1/messages`  → usable directly, one API key.
 *   dsh-connect-workbuddy / dsh-connect-trae → proprietary SSE to the vendor's web gateway, with the
 *   token taken from the locally installed desktop app (WorkBuddy even AES-GCM-encrypts it and needs
 *   its own native binding to decrypt). Nothing in that path is Anthropic-shaped, so this build
 *   reports them as 未接入 with the reason instead of pretending a preset would work.
 *
 * The registry below therefore carries a STATUS, and the UI is expected to show it verbatim: a
 * connector that silently does nothing is exactly the class of failure this project already paid for
 * once (the "double-click does nothing" sideload bug).
 */
import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { discoverWorkBuddyCli } from './workbuddy.mjs'
import { discoverTraeCli } from './traecli.mjs'
import { join } from 'node:path'

/** Where the OpenAI-compatible catalog and the Anthropic inference route live. */
const OPENCODE_GO = {
  /** Catalog + usage are rooted at /v1. */
  apiBase: 'https://opencode.ai/inference/go/v1',
  /** `claude.exe` appends `/v1/messages`, so the Anthropic base stops at `/anthropic`. */
  anthropicBase: 'https://opencode.ai/inference/go/anthropic',
  /** Legacy base still accepted by the gateway; used when a user pastes it. */
  legacyBase: 'https://opencode.ai/zen/go',
}

const TIMEOUT_MS = 15000

/**
 * The three upstream plugins, with the evidence line that decides whether a port is possible.
 *
 * `state` is computed at request time (see `connectorList`) rather than stored: an app can be
 * installed or removed between two page loads, and a cached "可用" that is no longer true is worse
 * than no status at all.
 */
export const CONNECTORS = [
  {
    id: 'opencode-go',
    name: 'dsh-opencode-go',
    version: '0.1.25-pre',
    title: 'OpenCode Go',
    summary: 'OpenCode Go 网关：一把 Bearer Key 接入 DeepSeek / Qwen / MiniMax 等模型，按量计费。',
    supportsChat: true,
    detail:
      '上游自带 Anthropic 兼容路由（/inference/go/anthropic/v1/messages），所以 claude.exe 可以直接把它当服务商使用；模型目录与额度来自 /v1/models 与 /v1/usage。',
    keyHint: 'OPENCODE_API_KEY',
    docs: 'https://github.com/Duskriver/dsh-opencode-go',
    /** Fields the panel renders. One key is enough — the gateway routes per model. */
    fields: [{ id: 'apiKey', label: 'API Key', type: 'password', placeholder: '粘贴 OpenCode Go 的 Bearer Key' }],
  },
  {
    id: 'workbuddy',
    name: 'dsh-connect-workbuddy',
    version: '5.3.1',
    title: 'WorkBuddy 连接器',
    summary: '把本机已登录的 WorkBuddy 桌面端当作模型后端（国内版 / 国际版）：经自带 CodeBuddy CLI 路由。',
    supportsChat: false,
    detail:
      '上游走专有 WorkBuddy SSE（copilot.tencent.com），Token 取自本机桌面端、且新版会用 AES-GCM 加密、需要 App 自身的原生绑定才能解密。它不是 Anthropic 协议，本版只做登记与安装/登录探测，不提供对话路由。',
    keyHint: 'WORKBUDDY_AUTH_FILE',
    docs: 'https://github.com/dingminhua/dsh-connect-workbuddy',
    fields: [],
  },
]

/**
 * Places the desktop apps keep their login, per platform.
 *
 * Only used for "did the user install it" — this module never reads or copies a token. That is a
 * deliberate limit: a token copied into our own store becomes our responsibility to refresh and to
 * protect, and the protocol it unlocks is not one we can speak anyway.
 */
function appLocations(connector) {
  if (process.platform !== 'win32') return []
  const roaming = process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming')
  if (connector.id === 'trae') {
    return [
      join(roaming, 'Trae', 'User', 'globalStorage', 'storage.json'),
      join(roaming, 'Trae CN', 'User', 'globalStorage', 'storage.json'),
      join(roaming, 'TRAE SOLO CN', 'User', 'globalStorage', 'storage.json'),
    ]
  }
  if (connector.id === 'workbuddy') {
    const explicit = process.env.WORKBUDDY_AUTH_FILE
    if (explicit) return [explicit]
    return [
      join(roaming, 'CodeBuddy', 'User', 'globalStorage', 'storage.json'),
      join(roaming, 'WorkBuddy', 'User', 'globalStorage', 'storage.json'),
      join(roaming, 'workbuddy', 'User', 'globalStorage', 'storage.json'),
    ]
  }
  return []
}

/** The public shape: registry fields plus a live status the UI can render without guessing. */
export function connectorList() {
  return CONNECTORS.map((connector) => {
    const evidence = appLocations(connector).filter((path) => existsSync(path))
    // CLI 也是一等证据：桌面端数据目录可能在不同位置，但能跑起来的 CLI 就说明路由可用。
    const cli = connector.id === 'workbuddy' ? discoverWorkBuddyCli().cli : connector.id === 'trae' ? discoverTraeCli().cli : null
    const hasRoute = Boolean(cli)
    return {
      id: connector.id,
      name: connector.name,
      version: connector.version,
      title: connector.title,
      summary: connector.summary,
      detail: connector.detail,
      docs: connector.docs,
      keyHint: connector.keyHint,
      fields: connector.fields,
      supportsChat: connector.supportsChat,
      /** `ready` = can carry a conversation now; `detected` = app found but no route; `absent`. */
      state: connector.supportsChat ? 'ready' : evidence.length > 0 || hasRoute ? 'detected' : 'absent',
      route: hasRoute ? 'cli' : null,
      routeCli: cli,
      evidence: evidence.map((path) => path.replace(homedir(), '~')),
    }
  })
}

/** One registry entry by id. */
export function connectorById(id) {
  return CONNECTORS.find((connector) => connector.id === id) ?? null
}

function authHeaders(apiKey) {
  const key = String(apiKey ?? '').trim()
  if (key === '') return null
  return { authorization: `Bearer ${key}`, accept: 'application/json' }
}

async function getJson(url, headers) {
  const response = await fetch(url, { headers, signal: AbortSignal.timeout(TIMEOUT_MS) })
  const text = await response.text()
  let payload = null
  try {
    payload = text === '' ? null : JSON.parse(text)
  } catch {
    payload = null
  }
  return { status: response.status, ok: response.ok, payload, text: text.slice(0, 400) }
}

/**
 * List the gateway's models, mapped onto the provider entries this app stores.
 *
 * WHY THE PANEL NEEDS THIS RATHER THAN A HARD-CODED LIST: OpenCode Go's catalog moves (models are
 * added and retired server-side), and a preset listing a retired model fails at the first message
 * with an upstream error the user cannot act on.
 */
export async function connectorCatalog({ id, apiKey } = {}) {
  const connector = connectorById(id)
  if (!connector) return { ok: false, error: `未知连接器：${String(id)}` }
  if (id !== 'opencode-go') {
    return { ok: false, error: `${connector.title} 没有可用的模型目录：上游不是 Anthropic 协议`, unsupported: true }
  }

  const headers = authHeaders(apiKey)
  if (!headers) return { ok: false, error: '请先填写 API Key' }

  try {
    const answer = await getJson(`${OPENCODE_GO.apiBase}/models`, headers)
    if (!answer.ok) {
      return {
        ok: false,
        status: answer.status,
        error:
          answer.status === 401 || answer.status === 403
            ? 'API Key 被拒绝（401/403），请检查是否复制完整'
            : `读取模型目录失败（HTTP ${answer.status}）：${answer.text}`,
      }
    }
    const list = Array.isArray(answer.payload?.data)
      ? answer.payload.data
      : Array.isArray(answer.payload?.models)
        ? answer.payload.models
        : Array.isArray(answer.payload)
          ? answer.payload
          : []
    const models = list
      .map((entry) => (typeof entry === 'string' ? { id: entry } : entry))
      .map((entry) => ({
        id: String(entry.id ?? entry.model ?? entry.name ?? ''),
        name: String(entry.name ?? entry.id ?? entry.model ?? ''),
        contextWindow: Number(entry.context_window ?? entry.contextWindow ?? 0) || null,
      }))
      .filter((entry) => entry.id !== '')
    return { ok: true, baseUrl: OPENCODE_GO.anthropicBase, models, fetchedAt: Date.now() }
  } catch (error) {
    return { ok: false, error: `连不上 OpenCode Go：${error?.message ?? error}` }
  }
}

/** Quota / usage readout. A gateway that does not implement it answers 404, which is reported as-is. */
export async function connectorUsage({ id, apiKey } = {}) {
  const connector = connectorById(id)
  if (!connector) return { ok: false, error: `未知连接器：${String(id)}` }
  if (id !== 'opencode-go') {
    return { ok: false, error: `${connector.title} 的额度接口依赖本机 App 的登录态，本版未接入`, unsupported: true }
  }
  const headers = authHeaders(apiKey)
  if (!headers) return { ok: false, error: '请先填写 API Key' }

  try {
    const answer = await getJson(`${OPENCODE_GO.apiBase}/usage`, headers)
    if (!answer.ok) {
      return { ok: false, status: answer.status, error: `读取额度失败（HTTP ${answer.status}）：${answer.text}` }
    }
    return { ok: true, usage: answer.payload, fetchedAt: Date.now() }
  } catch (error) {
    return { ok: false, error: `连不上 OpenCode Go：${error?.message ?? error}` }
  }
}

/**
 * Turn a catalog into the provider rows the app stores (one row per model).
 *
 * The key is written into each row because that is the shape the existing model store uses; the
 * settings panel is the only reader, and the bridge never sends it back out (see `publicModels`).
 */
export function connectorProviders({ id, apiKey, models } = {}) {
  const connector = connectorById(id)
  if (!connector) return { ok: false, error: `未知连接器：${String(id)}` }
  if (!connector.supportsChat) return { ok: false, error: `${connector.title} 暂不支持对话路由`, unsupported: true }
  const key = String(apiKey ?? '').trim()
  if (key === '') return { ok: false, error: '请先填写 API Key' }
  const list = Array.isArray(models) ? models : []
  if (list.length === 0) return { ok: false, error: '模型目录是空的，先刷新一次目录' }

  return {
    ok: true,
    baseUrl: OPENCODE_GO.anthropicBase,
    providers: list.map((model) => ({
      name: String(model.id ?? model),
      baseUrl: OPENCODE_GO.anthropicBase,
      apiKey: key,
      provider: connector.title,
    })),
  }
}

/** Constants exported for the settings panel and for tests. */
export { OPENCODE_GO }

/**
 * 本机 CLI 路由的「模型行」：导入后用户不需要填任何 URL。
 *
 * WHY GENERATE THE ROW INSTEAD OF ASKING THE USER TO TYPE A BASE URL: the endpoint is this same bridge, so
 * its address is known at runtime. Making a person copy `http://127.0.0.1:PORT/proxy/workbuddy` into a
 * settings field is exactly the kind of step that produces "it doesn't work" reports.
 *
 * The apiKey is a local placeholder: the CLI owns the real credential, and the proxy ignores this value —
 * it is only here because the models store requires a non-empty key.
 */
export function cliProviderRows({ port, workbuddyCli = null, traeCli = null } = {}) {
  const base = `http://127.0.0.1:${Number(port) || 43130}`
  const rows = []
  if (workbuddyCli) {
    rows.push({
      name: 'workbuddy-default',
      baseUrl: `${base}/proxy/workbuddy`,
      apiKey: 'local-cli',
      provider: 'WorkBuddy CLI',
      models: [{ id: randomUUID(), model: 'workbuddy-default', label: 'workbuddy-default' }],
    })
  }
  /**
   * Trae 不再是内置能力：产品上删掉了它的连接器与插件，所以这里也不再生成 trae-default 行。
   *
   * WHY THIS IS A DELETION AND NOT A TOGGLE: read-time generation runs on every start, so a
   * leftover auto-row would keep resurrecting a provider the user just deleted.
   */
  void traeCli
  return { ok: true, rows }
}

/**
 * Merge generated rows into the existing models list without duplicating or overwriting user edits.
 *
 * Identity is (name + baseUrl): a user who renamed the entry or pointed it elsewhere keeps their version;
 * a second import is a no-op. That is what makes it safe to run on every start.
 */
export function mergeCliProviders(existing, rows) {
  const list = Array.isArray(existing) ? existing.slice() : []
  const added = []
  for (const row of Array.isArray(rows) ? rows : []) {
    const existing = list.find((entry) => entry?.name === row.name || entry?.baseUrl === row.baseUrl)
    if (existing) {
      // 老数据修复：之前导入的行没有 models，模型选择器看不到它。补一条而不是覆盖用户已有条目。
      if (Array.isArray(existing.models) && existing.models.length === 0 && row.models?.length) {
        existing.models.push({ ...row.models[0], id: randomUUID() })
      }
      continue
    }
    list.push(row)
    added.push(row)
  }
  return { providers: list, added }
}

/**
 * 凭据探测：这台机器上有没有这两个 App 的登录态，以及能不能读到它的 token。
 *
 * WHY THIS EXISTS AS A READ-ONLY DIAGNOSTIC: routing these two connectors' conversations depends on
 * facts only the machine can answer — is the app installed, where does it keep its session, is the token
 * readable or does it need the app's own native binding to decrypt. Producing that answer is useful on
 * its own, and it is the prerequisite a translation proxy would need.
 *
 * WHAT IT NEVER DOES: print, copy or upload a token. Only the presence of a key and the path are
 * reported — "we found your credential" is enough to plan the next step, and the value is not.
 */
export function connectorDiagnose({ id } = {}) {
  const connector = connectorById(id)
  if (!connector) return { ok: false, error: `未知连接器：${String(id)}` }

  const candidatePaths = appLocations(connector)
  const found = []
  for (const path of candidatePaths) {
    if (!existsSync(path)) continue
    let keys = 0
    let hasToken = false
    let readable = true
    try {
      const raw = readFileSync(path, 'utf8')
      const parsed = JSON.parse(raw)
      keys = Object.keys(parsed ?? {}).length
      hasToken = /"(accessToken|refreshToken|access_token|refresh_token)"/.test(raw)
    } catch {
      // Encrypted or binary stores are legitimately unreadable here; that IS the finding.
      readable = false
    }
    found.push({ path: path.replace(homedir(), '~'), readable, keys, hasToken })
  }

  const executable = connector.id === 'workbuddy' ? process.env.WORKBUDDY_APP_EXECUTABLE ?? null : null
  const diagnosis =
    found.length === 0
      ? `${connector.title} 的本机登录文件没有找到：这台机器上要么没装，要么登录态在别处。`
      : found.some((entry) => entry.hasToken && entry.readable)
        ? `找到 ${found.length} 个文件，其中可读且带 accessToken/refreshToken —— 具备做翻译代理的前提。`
        : `找到 ${found.length} 个文件，但都没有可读的 accessToken/refreshToken 字段：凭据不在这个文件里（或需要 App 自己解密），无法据此建立代理。`

  return {
    ok: true,
    id: connector.id,
    supportsChat: connector.supportsChat,
    candidates: candidatePaths.map((path) => path.replace(homedir(), '~')),
    found,
    executable,
    diagnosis,
    next: connector.supportsChat
      ? '这个连接器不需要诊断：它用的是普通 API Key。'
      : '要做对话路由，需要一份真实的请求/响应样本与可复现的登录态；没有它们，写出来的协议只能靠猜。',
  }
}

/**
 * 翻译代理解析骨架：说明这个连接器目前能不能被代理，缺什么。
 *
 * WHY A SKELETON AND NOT A FAKE PROXY: the route exists so the capability boundary is a fact in the code
 * rather than a sentence in a README — and so the day a real credential sample arrives, there is one
 * place to fill in instead of a new subsystem. It deliberately refuses instead of forwarding: a proxy
 * that guesses a vendor's private SSE would fail in a way users would report as "ChinaClaude 坏了".
 */
export function connectorProxyStatus({ id } = {}) {
  const connector = connectorById(id)
  if (!connector) return { ok: false, error: `未知连接器：${String(id)}` }
  if (connector.supportsChat) {
    return {
      ok: true,
      id: connector.id,
      state: 'not-needed',
      reason: '这个连接器已经直接走 Anthropic 兼容端点，不需要本机代理。',
      endpoint: null,
    }
  }
  const diagnosis = connectorDiagnose({ id })
  const readable = diagnosis.found?.some((entry) => entry.hasToken && entry.readable) === true
  return {
    ok: true,
    id: connector.id,
    state: readable ? 'blocked-on-protocol' : 'blocked-on-credential',
    reason: readable
      ? '本机凭据可读，但上游的专有 SSE 协议还没有实现：没有真实报文样本时，代理只能靠猜。'
      : diagnosis.diagnosis,
    endpoint: '/api/connectors/proxy',
    method: 'POST',
    body: { id: connector.id, request: '{ Anthropic Messages 请求体 }' },
    diagnosis,
  }
}

/**
 * The refusal itself. Always `ok: false`, always a code — never a 200 that carries no answer.
 */
export function connectorProxyRefuse({ id } = {}) {
  const status = connectorProxyStatus({ id })
  if (!status.ok) return status
  if (status.state === 'not-needed') return { ok: false, error: status.reason, code: 'not-needed' }
  return {
    ok: false,
    code: 'not-implemented',
    state: status.state,
    error: status.reason,
    next: '需要一份真实请求/响应样本与可复现登录态；地址与请求体形状已经固定，见 status。',
  }
}
