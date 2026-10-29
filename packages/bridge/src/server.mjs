/**
 * Bridge HTTP surface.
 *
 * Plain HTTP + SSE rather than an IPC channel: the Tauri webview and `vite dev` both
 * reach it over 127.0.0.1, so the shell owns process lifetime only — it does not have to
 * forward traffic. That is what lets this project drop Electron's custom protocol and
 * framed pipe transport entirely.
 */
import { createServer } from 'node:http'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { ClaudeSession, DEFAULT_BASE_URL } from './session.mjs'
import { createScanner } from './discovery.mjs'
import { listDirectories, listRoots } from './directories.mjs'
import { bundledInventory, builtinPluginList, NOT_BUNDLED } from './bundled.mjs'
import { sessionMcpConfig } from './mcp-config.mjs'
import { AUTHOR, SHOP_PRODUCTS, createLogRing, createFeedbackInbox, revealLogFile } from './shell.mjs'
import { scanDirectory, groupFindings, scannerStatus } from './vet.mjs'
import { ENGINE_VERSION } from './vet-engine-version.mjs'
import { listTranscripts, groupTranscripts, transcriptToMarkdown } from './transcripts.mjs'
import { fetchBalance } from './balance.mjs'
import { testConnection } from './connect-test.mjs'
import * as ourfree from './ourfree.mjs'
import * as ofm from './ofm.mjs'
import { saveAttachments, attachmentsUsage, clearAttachments } from './attachments.mjs'
import { checkForUpdate, createUpdateInstaller, publicCheckResult, DEFAULT_SOURCES } from './update.mjs'
import { createRemoteAccess, SESSION_COOKIE } from './remote.mjs'
import { publicModels, readModels, writeModels, keyForBaseUrl } from './models.mjs'
import { readSessions, writeSessions } from './session-store.mjs'
import { createWechatNotifier } from './wechat.mjs'
import { ORIGIN_SCRIPT, ORIGIN_SCRIPT_PATH, pairPage, parseForm, readFormBody, serveWebFile } from './webhost.mjs'
import { qrSvg } from './qr.mjs'
import { searchWeb } from './search.mjs'
import { detectTests, runTest } from './qa.mjs'
import { rollbackLastTurn } from './rollback.mjs'
import { previewTurnFiles, restoreTurnFiles } from './turns.mjs'

const MAX_BODY_BYTES = 1024 * 1024

/** How long a paired phone stays paired without re-entering a code. */
const PAIR_COOKIE_MAX_AGE = 30 * 24 * 60 * 60

/**
 * Load a feature module on first use.
 *
 * WHY NOT A STATIC IMPORT: every feature behind the menu bar (记忆 / 规则 / 检查点 / 防护 / git /
 * 视觉) is optional to the app's actual job, which is running a session. A static import would make
 * any one of them — a syntax error in a hand-written module, a file an installer failed to copy —
 * take the whole bridge down at startup, i.e. turn "one panel is broken" into "the app does not
 * open". Loaded lazily, the same failure is a sentence inside one window, and the rest of the app
 * never learns about it.
 */
const featureCache = new Map()
async function feature(name) {
  if (!featureCache.has(name)) featureCache.set(name, import(`./${name}.mjs`))
  return await featureCache.get(name)
}

/** Run a feature route, turning a module-level failure into the shape every caller already handles. */
async function withFeature(name, run) {
  try {
    return await run(await feature(name))
  } catch (error) {
    return { ok: false, error: `${name} 模块不可用：${String(error?.message ?? error)}` }
  }
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        reject(new Error('request body too large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8')
      if (!text) return resolve({})
      try {
        resolve(JSON.parse(text))
      } catch (error) {
        reject(new Error(`invalid JSON body: ${error.message}`))
      }
    })
    req.on('error', reject)
  })
}

function sendJson(res, status, value) {
  const body = JSON.stringify(value)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  })
  res.end(body)
}

/**
 * @param {object} options
 * @param {string} options.binary     absolute path to claude.exe
 * @param {string} [options.bundledDir] directory holding a CLI shipped with the app
 * @param {object} [options.defaults] baseUrl / authToken / model / permissionMode defaults
 * @param {number} [options.port]
 * @param {string} [options.host]
 */
export function createBridgeServer(options) {
  const defaults = {
    baseUrl: DEFAULT_BASE_URL,
    authToken: '',
    apiKey: '',
    model: '',
    permissionMode: '',
    proxy: '',
    ...(options.defaults ?? {}),
  }

  /** @type {Map<string, ClaudeSession>} */
  const sessions = new Map()

  /**
   * 当前会话是“桥级状态”，不是每个客户端自己的内存。
   *
   * 为什么放在这里：桌面端和手机端是同一个桥的两个客户端，会话进程也由这个桥统一持有。
   * 以前“选中了哪个会话”只存在各自前端的 JS 里，于是手机打开时明明桌面正在对话，页面
   * 却显示“未选择工作目录 / 就绪 0 事件 / 状态 -”。桥是两端唯一都能看到的地方，所以由
   * 桥记住这个指针，客户端通过 `/api/state` 读取、通过 `/api/state/events` 订阅变化。
   *
   * 语义保持“最后操作者获胜”：任何按会话 id 的请求、新建会话、显式切换都会更新它；
   * 桥重启后回到 null，由客户端重新选择（服务端不持久化，避免把已被删除的会话复活）。
   *
   * @type {string | null}
   */
  let activeSessionId = null

  /**
   * 所有 `GET /api/state/events` 的长连接。
   *
   * 只保存响应对象：广播时一帧写失败就当作该客户端已经断开，顺手清掉，避免死连接越积越多。
   *
   * @type {Set<import('node:http').ServerResponse>}
   */
  const stateSubscribers = new Set()

  /** `/api/sessions` 与 `/api/state` 共用的列表投影，避免两处各拼一遍导致字段漂移。 */
  function listSessions() {
    return [...sessions.values()].map((session) => session.toJSON())
  }

  /** 当前会话的一帧 SSE 数据；`/api/state/events` 的首帧和后续广播共用同一格式。 */
  function stateFrame() {
    return `event: state\ndata: ${JSON.stringify({ activeSessionId })}\n\n`
  }

  /** 把当前会话推给所有 state 订阅者。 */
  function broadcastState() {
    const frame = stateFrame()
    for (const subscriber of stateSubscribers) {
      try {
        subscriber.write(frame)
      } catch {
        stateSubscribers.delete(subscriber)
      }
    }
  }

  /** 统一更新入口：只有值真的变了才广播，避免客户端收到无意义的重复帧。 */
  function rememberActiveSession(id) {
    if (activeSessionId === id) return
    activeSessionId = id
    broadcastState()
  }

  /**
   * Persist the session list across restarts, debounced.
   *
   * Writing on EVERY event would hit the disk in bursts (a single answer emits many tool events),
   * so a short debounce coalesces them into one write. A final flush on close guarantees the last
   * turn lands even if the app is quit right after it.
   */
  let saveTimer = null
  function flushSessions() {
    if (saveTimer) {
      clearTimeout(saveTimer)
      saveTimer = null
    }
    writeSessions([...sessions.values()].map((session) => session.toSnapshot()))
  }
  function scheduleSave() {
    if (saveTimer) return
    saveTimer = setTimeout(() => {
      saveTimer = null
      flushSessions()
    }, 800)
    saveTimer.unref?.()
  }
  /**
   * The scanner behind `/api/discovery`, which is what the UI reports as "where claude.exe came
   * from".
   *
   * `bundledDir` MUST be forwarded from the entry point: this scanner used to be built with no
   * arguments at all, so the directory holding the shipped CLI was never searched here even though
   * session creation (which uses the entry point's own resolution) found it. The result was that a
   * working installed app displayed "未找到 claude.exe" and offered to install one that was already
   * sitting next to it.
   */
  const scanner = createScanner({
    bundledDir: options.bundledDir,
    // The entry point already resolved the binary (flag, env, bundle or PATH); report THAT object
    // so `/api/discovery` agrees with what sessions actually run, source included.
    ...(options.resolvedBinary ? { resolvedBinary: options.resolvedBinary } : {}),
  })

  /**
   * LAN access policy and credentials.
   *
   * Created by the ENTRY POINT and handed in, because the bind address depends on whether LAN access
   * is enabled — a decision the entry point must make before it calls `listen`.
   */
  const remote = options.remote ?? createRemoteAccess()

  /** The built UI, staged into the sidecar so a phone has something to load. */
  const webRoot = options.webRoot ?? null

  /** Requests from this machine are trusted; everything else must pair first. */
  const hostIsLan = Boolean(options.host) && options.host !== '127.0.0.1'

  const updater = createUpdateInstaller()
  /**
   * The shell's own log ring, teed onto the process's stdout/stderr.
   *
   * Created BEFORE any session exists, because the lines that matter most are the ones from before
   * anything worked: a missing binary, a handshake that never arrived, a spawn that failed. A ring
   * that only starts recording once a session is up would be blind to exactly those.
   */
  const logRing = createLogRing()
  logRing.tee()
  const feedback = createFeedbackInbox()

  /**
   * 微信接入：企业微信群机器人出站通知。
   *
   * 与 remote 同一条规则——webhook 是凭据，只有本机（loopback）能读能写；页面永远只拿到掩码。
   * 推送是 best-effort：通知发不出去绝不能连累它要描述的那次会话。
   */
  const wechat = createWechatNotifier()

  /**
   * 项目记忆 → `--append-system-prompt`。
   *
   * 为什么不靠「导出成 CLAUDE.memory.md」：那个文件名 CLI 不会自动读（它只读 `CLAUDE.md`），
   * 所以导出对会话本身没有任何影响 —— 这一条是核对出来的，不是猜的。真正生效的是 CLI 现成的
   * 钩子：spawn 时把附录交给子进程，`session.mjs` 一直在等这个参数，只是从来没人传。
   *
   * 任何失败都退化成「不注入」而不是抛错：记忆是增强，不能因为它让会话建不起来。
   */
  async function memoryAppendix(cwd) {
    if (!cwd) return undefined
    const answer = await withFeature('memory', async (mod) => await mod.memoryForPrompt({ cwd }))
    if (!answer?.ok || !answer.text) return undefined
    logRing.append('info', `memory: 注入 ${answer.count} 条项目记忆（${answer.chars} 字）到新会话的系统提示`, 'shell')
    return answer.text
  }

  /**
   * 发送前的本地检查：规则引擎 + 安全防护。
   *
   * 为什么判定放在桥里而不是页面上：规则与防护的存储都在桥这一侧，判断必须在数据所在的地方做，
   * 否则「面板里看得见、真发出去时不起作用」就会再发生一次 —— 那正是这一轮要修的毛病。
   *
   * 为什么是「确认一次」而不是硬拦：写这段代码时我自己就被密钥规则误伤过（测试文件里一个假 key
   * 让写文件被拒），所以对**用户自己敲的提示词**只做一次确认，不单方面拦截。误报的代价是把用户
   * 锁在自己的工具外面，比漏报更难恢复。确认过就照发，并且这次放行会写进运行日志。
   */
  async function runPreflight({ text, cwd, confirmed }) {
    const blockers = []
    let rules = []
    let appendText = ''

    const rulesAnswer = await withFeature('rules', async (mod) => await mod.evaluateRules({ text, cwd }))
    if (rulesAnswer?.ok && Array.isArray(rulesAnswer.hits)) {
      rules = rulesAnswer.hits.map((hit) => ({
        id: hit.id,
        name: hit.name,
        label: hit.label,
        action: hit.action,
      }))
      for (const hit of rules) {
        if (hit.action === 'block') blockers.push({ source: 'rule', name: hit.name, label: hit.label })
      }
      appendText = rulesAnswer.hits
        .filter((hit) => hit.action === 'append' && hit.append)
        .map((hit) => hit.append)
        .join('\n')
    }

    const guardAnswer = await withFeature('defend', async (mod) =>
      await mod.guard({ text, where: 'prompt', action: 'preflight' }),
    )
    for (const hit of Array.isArray(guardAnswer?.hits) ? guardAnswer.hits : []) {
      if (hit.severity !== 'block') continue
      blockers.push({
        source: 'defend',
        name: hit.ruleName ?? hit.rule,
        label: hit.excerpt ?? '',
        family: hit.familyLabel ?? hit.family ?? null,
      })
    }

    if (blockers.length > 0 && !confirmed) {
      return {
        needsConfirm: true,
        blockers,
        rules,
        error: `发送前检查命中 ${blockers.length} 项：${blockers.map((entry) => entry.name).join('、')}`,
      }
    }
    if (blockers.length > 0) {
      logRing.append('warn', `preflight: 用户确认后放行（${blockers.map((entry) => entry.name).join('、')}）`, 'shell')
    }

    return {
      needsConfirm: false,
      blockers,
      rules,
      appended: appendText,
      text: appendText ? `${text}\n\n${appendText}` : text,
    }
  }

  const appVersion = options.appVersion ?? process.env.CCCN_APP_VERSION ?? '0.0.0'
  /**
   * The last check's result, and the ONLY place a download URL may come from.
   *
   * The page can ask for a check and then for a download, but it can never hand this server a URL to
   * fetch and execute — that would turn a local HTTP port into "download and run anything". The URL
   * always originates in the configured update sources.
   */
  let lastCheck = null

  /** The bot→session handler is wired once, on the first bot request (the module is lazily imported). */
  let botsWired = false

  /**
   * 开箱即用：把本机 CLI 路由对应的模型行写进模型列表，用户不必手填 Base URL。
   *
   * Runs once per process, before the first API response. It only ADDS rows (identity = name + baseUrl), so a
   * second start is a no-op and a user-edited entry is never overwritten. Failures are swallowed: a broken
   * models file must not stop the bridge from serving.
   */
  let cliProvidersEnsured = false
  let cliProvidersInfo = null
  const ensureCliProviders = async (actualPort) => {
    // A second request reports no new additions; dded describes the one-time import, not the state.
    if (cliProvidersEnsured) return { ...(cliProvidersInfo ?? { rows: [], added: [] }), added: [] }
    cliProvidersEnsured = true
    try {
      const connectors = await withFeature('connectors', async (mod) => mod)
      const workbuddy = await withFeature('workbuddy', async (mod) => mod).catch(() => null)
      const traecli = await withFeature('traecli', async (mod) => mod).catch(() => null)
      // The REAL listening port: options.port may be absent when the caller binds 0 or a different one,
      // and a model row pointing at the wrong port is exactly the kind of silent breakage to avoid.
      const port = Number(actualPort) || options.port || 43130
      const rows = connectors.cliProviderRows({
        port,
        workbuddyCli: workbuddy?.discoverWorkBuddyCli?.().cli ?? null,
        traeCli: traecli?.discoverTraeCli?.().cli ?? null,
      }).rows
      const merged = connectors.mergeCliProviders(readModels().providers, rows)
      // 无条件写回：merge 会顺手修复老行缺失的 models，而「修复」不算 added。
      writeModels(merged.providers)
      cliProvidersInfo = { rows, added: merged.added.map((row) => row.name) }
    } catch {
      cliProvidersInfo = { rows: [], added: [] }
    }
    return cliProvidersInfo
  }

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? '127.0.0.1'}`)

    // 开箱即用的一次性导入：等第一个 API 请求时再做，避免把模型文件的读写塞进启动路径。
    if (url.pathname.startsWith('/api/')) await ensureCliProviders(req.socket.localPort)

    // The desktop webview may be served from a different origin (vite dev / tauri://).
    res.setHeader('Access-Control-Allow-Origin', '*')
    res.setHeader('Access-Control-Allow-Headers', 'content-type')
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,DELETE,OPTIONS')
    if (req.method === 'OPTIONS') {
      res.writeHead(204)
      res.end()
      return
    }

    /**
     * ---- phone bootstrap ------------------------------------------------------
     * Runs BEFORE the gate, and both paths are public on purpose:
     *   /bridge-origin.js  no secret — it only tells the page where its own API lives
     *   /pair              the form a phone must be able to reach in order to authenticate at all
     */
    if (req.method === 'GET' && url.pathname === ORIGIN_SCRIPT_PATH) {
      res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-store' })
      res.end(ORIGIN_SCRIPT)
      return
    }

    if (url.pathname === '/pair') {
      const current = remote.authorize(req)
      const canPair = remote.isEnabled() && !current.loopback

      if (req.method === 'POST') {
        const token = canPair ? remote.redeemPairCode(parseForm(await readFormBody(req)).code) : null
        if (!token) {
          res.writeHead(canPair ? 401 : 403, {
            'content-type': 'text/html; charset=utf-8',
            'cache-control': 'no-store',
          })
          res.end(
            pairPage({
              message: !canPair
                ? '局域网访问未开启：请在电脑端的「设置 → 手机访问」里打开，然后重启应用。'
                : '配对码不正确或已过期，请在电脑端重新生成。',
              showForm: canPair,
            }),
          )
          return
        }
        res.writeHead(303, {
          location: '/',
          /**
           * HttpOnly: the page never needs to read it, so JS cannot leak it.
           * SameSite=Lax: set by a top-level form POST and then sent on the follow-up navigation,
           * which is exactly the pairing flow.
           * NO `Secure`: this is plain HTTP on a LAN, and a Secure cookie would simply be dropped —
           * which would look like "pairing silently does nothing".
           */
          'set-cookie': `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${PAIR_COOKIE_MAX_AGE}`,
          'cache-control': 'no-store',
        })
        res.end()
        return
      }

      /**
       * 扫码进来的请求：二维码里已经带了配对码（?code=...），这里直接兑换并种下 cookie。
       *
       * 手输配对码那条路仍然保留；但如果扫码之后还要在手机上再敲一遍六位数字，扫码就失去意义了。
       */
      const scanned = url.searchParams.get('code')
      if (req.method === 'GET' && scanned && canPair) {
        const issued = remote.redeemPairCode(scanned)
        if (issued) {
          res.writeHead(303, {
            location: '/',
            'set-cookie': `${SESSION_COOKIE}=${issued}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${PAIR_COOKIE_MAX_AGE}`,
            'cache-control': 'no-store',
          })
          res.end()
          return
        }
      }

      // GET /pair: the desktop, or a phone that is already paired, has nothing to do here.
      if (current.ok) {
        res.writeHead(303, { location: '/', 'cache-control': 'no-store' })
        res.end()
        return
      }
      res.writeHead(current.status, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
      res.end(pairPage({ message: current.message, showForm: current.reason !== 'lan-disabled' }))
      return
    }

    /**
     * ---- the gate -------------------------------------------------------------
     * Everything below this line is either loopback or paired. The desktop webview is loopback, so its
     * behaviour is unchanged; a LAN peer without a valid cookie gets an actionable page, not a bare 401.
     */
    const gate = remote.authorize(req)
    if (!gate.ok) {
      if (url.pathname.startsWith('/api/')) {
        sendJson(res, gate.status, { error: gate.message, reason: gate.reason })
      } else {
        res.writeHead(gate.status, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
        res.end(pairPage({ message: gate.message, showForm: gate.reason !== 'lan-disabled' }))
      }
      return
    }

    try {
      // ---- health -------------------------------------------------------------
      if (req.method === 'GET' && url.pathname === '/api/health') {
        sendJson(res, 200, {
          ok: true,
          // Protocol version, so a stale page can detect a mismatched bridge.
          version: 1,
          /** The INSTALLED version, which is what the menu bar displays. */
          appVersion,
          binary: options.binary,
          baseUrl: defaults.baseUrl,
          hasCredential: Boolean(defaults.authToken),
          sessions: sessions.size,
        })
        return
      }

      // ---- shared model config -------------------------------------------------
      /**
       * WHAT THIS IS FOR: the desktop webview and a phone browser are different origins, so they do not
       * share localStorage. A fully configured desktop therefore still looked unbound on the phone. The
       * desktop publishes its provider list here; the phone reads it and skips retyping endpoints and
       * model names in its own binding form.
       *
       * TRUST NOTE: this route NEVER returns credentials. The stored snapshot holds the desktop's keys,
       * but both responses below go through `publicModels()`, which blanks them — so the key is asked
       * for once on the phone and stays there, and the desktop's credential does not cross the LAN as
       * plain HTTP. Writes stay loopback-only so a phone can never change what the desktop uses.
       */
      /**
       * 模型列表自愈：按 Base URL 合并重复服务商，模型取并集。
       *
       * WHY: 多轮导入/发布曾把同一条链路写成几十个同名 provider（每个只有一条默认模型），下拉里就会出现
       * 大量重复项。合并只做「同一端点 → 一条」，不改变用户自己的端点或 key。
       */
      const normalizeProviders = (list) => {
        const byUrl = new Map()
        for (const provider of Array.isArray(list) ? list : []) {
          const url = String(provider?.baseUrl ?? '')
          if (url === '') continue
          const current = byUrl.get(url)
          if (!current) {
            byUrl.set(url, { ...provider, models: [...(provider.models ?? [])] })
            continue
          }
          const seen = new Set(current.models.map((model) => model.model))
          for (const model of provider.models ?? []) {
            if (model?.model && !seen.has(model.model)) {
              current.models.push(model)
              seen.add(model.model)
            }
          }
        }
        return [...byUrl.values()]
      }
      if (url.pathname === '/api/models/remove' && req.method === 'POST') {
        // 显式删除：用户点了「删除」才走这里，覆盖式发布不再承担删除语义。
        if (!gate.loopback) {
          sendJson(res, 403, { error: '只有电脑端可以修改模型配置' })
          return
        }
        const body = await readJsonBody(req)
        const target = String(body.baseUrl ?? '')
        writeModels(readModels().providers.filter((provider) => provider.baseUrl !== target))
        sendJson(res, 200, { ok: true })
        return
      }
      if (url.pathname === '/api/models') {
        if (req.method === 'GET') {
          /**
           * 开箱即用：读的时候把本机 CLI 路由补进去。
           *
           * WHY MERGE ON READ, NOT ONLY ON START: the webview posts its own list back at startup, which
           * overwrites the one-time import. Merging here means the rows are visible no matter who wrote
           * last, and it never removes a user's own entries.
           */
          const view = publicModels()
          view.providers = normalizeProviders(view.providers)
          /**
           * 修复读取路径：webview 启动时会把本地列表整体 POST 回来，可能覆盖掉导入时写入的 models。
           * 所以在读取时补齐一次——只补空数组，不改用户已有条目，也不落盘。
           */
          for (const provider of view.providers) {
            const isImported = String(provider.baseUrl ?? '').includes('/proxy/')
            if (isImported && Array.isArray(provider.models) && provider.models.length === 0) {
              const fallback = String(provider.baseUrl).endsWith('/proxy/trae') ? 'trae-default' : String(provider.baseUrl).endsWith('/proxy/workbuddy') ? 'workbuddy-default' : provider.name
              provider.models.push({ id: `auto-${fallback}`, model: fallback, label: fallback })
            }
          }
          const rows = cliProvidersInfo?.rows ?? []
          const missing = rows.filter((row) => !view.providers.some((entry) => entry?.name === row.name || entry?.baseUrl === row.baseUrl))
          sendJson(res, 200, { ...view, providers: [...view.providers, ...missing], loopback: gate.loopback })
          return
        }
        if (req.method === 'POST') {
          if (!gate.loopback) {
            sendJson(res, 403, { error: '只有电脑端可以修改模型配置' })
            return
          }
          const body = await readJsonBody(req)
          /**
           * 合并，而不是覆盖。
           *
           * WHY: 导入写在桥里，而桌面端每次启动都会把自己那份列表 POST 回来。整体覆盖时，只要哪一端
           * 的本地列表慢了一步（旧窗口、手机、刚重装还没合并），导入的行就被抹掉 —— 用户看到的就是
           * 「明明导入过，怎么不见了」。用户主动删除走 /api/models/remove，那是显式的，不靠覆盖表达。
           */
          const incoming = normalizeProviders(body.providers)
          const stored = normalizeProviders(readModels().providers)
          const byUrl = new Map(stored.map((provider) => [provider.baseUrl, provider]))
          for (const provider of incoming) {
            const existing = byUrl.get(provider.baseUrl)
            if (!existing) {
              byUrl.set(provider.baseUrl, provider)
              continue
            }
            const seen = new Set((existing.models ?? []).map((model) => model.model))
            for (const model of provider.models ?? []) {
              if (!model?.model || seen.has(model.model)) continue
              existing.models.push(model)
              seen.add(model.model)
            }
            existing.name = provider.name || existing.name
            existing["apiKey"] = provider["apiKey"] || existing["apiKey"]
            existing.isDefault = Boolean(provider.isDefault ?? existing.isDefault)
          }
          writeModels([...byUrl.values()])
          // Echo the public view, not the stored snapshot: the snapshot would hand the key back to the
          // caller, and no response on this route should carry a secret even on the trusted path.
          sendJson(res, 200, publicModels())
          return
        }
      }

      // ---- phone access (LAN) -------------------------------------------------
      /**
       * Every management route here is LOOPBACK-ONLY, and that is not a nicety: pairing codes must be
       * mintable only by someone physically at the machine. A phone that could mint its own code, or
       * close the door on the desktop, would defeat the point of pairing.
       */
      if (url.pathname === '/api/remote') {
        if (req.method === 'GET') {
          sendJson(res, 200, {
            ...remote.status(),
            /** Whether the socket is ACTUALLY reachable from the LAN right now, vs merely configured. */
            active: hostIsLan,
            /** Whether this request came from the machine itself, so the UI can adapt. */
            loopback: gate.loopback,
          })
          return
        }

        if (req.method === 'POST') {
          if (!gate.loopback) {
            sendJson(res, 403, { error: '只有电脑端可以修改手机访问设置' })
            return
          }
          const body = await readJsonBody(req)
          sendJson(res, 200, {
            ...remote.setEnabled(body.enabled === true),
            active: hostIsLan,
            /**
             * The bind address is fixed when the socket opens, so this cannot take effect now. Saying
             * so beats a toggle that silently appears to do nothing.
             */
            restartRequired: true,
          })
          return
        }
      }

      /**
       * 扫码连接：一次调用同时给出配对码、手机地址和二维码图形。
       *
       * 拆成三个接口会让页面自己拼 URL（拼错就是扫不开），所以桥里拼好、画好，页面只负责显示。
       * 仅限本机：配对码就是进入这台电脑的凭证。
       */
      if (url.pathname === '/api/remote/scan' && req.method === 'POST') {
        if (!gate.loopback) {
          sendJson(res, 403, { error: '二维码只能在电脑端生成' })
          return
        }
        if (!remote.isEnabled()) {
          sendJson(res, 409, { error: '局域网访问还没开启：先打开开关并重启应用', active: hostIsLan })
          return
        }
        const issued = remote.issuePairCode()
        const base = String(remote.urlFor()).replace(/\/$/, '')
        const link = `${base}/pair?code=${encodeURIComponent(issued.code)}`
        sendJson(res, 200, {
          url: base,
          link,
          code: issued.code,
          expiresAt: issued.expiresAt ?? null,
          active: hostIsLan,
          svg: qrSvg(link),
        })
        return
      }

      if (url.pathname === '/api/remote/pair-code' && req.method === 'POST') {
        if (!gate.loopback) {
          sendJson(res, 403, { error: '配对码只能在电脑端生成' })
          return
        }
        if (!remote.isEnabled()) {
          sendJson(res, 409, { error: '请先开启局域网访问并重启应用，再生成配对码' })
          return
        }
        sendJson(res, 200, { ...remote.issuePairCode(), url: remote.urlFor() })
        return
      }

      if (url.pathname === '/api/remote/revoke' && req.method === 'POST') {
        if (!gate.loopback) {
          sendJson(res, 403, { error: '只有电脑端可以解除配对' })
          return
        }
        // Invalidates every issued cookie at once — the action a user can reason about when they want
        // to be sure a lost or borrowed phone no longer reaches this machine.
        sendJson(res, 200, { ...remote.revokeAll(), active: hostIsLan })
        return
      }

      // ---- 微信通知（企业微信群机器人） ---------------------------------------
      /**
       * LOOPBACK-ONLY, for the same reason pairing codes are: the webhook URL is a credential that
       * lets its holder post into the user's group. A paired phone must not be able to read it (only
       * the masked form is ever returned), replace it, or trigger a send to an address it chose.
       */
      if (url.pathname === '/api/wechat') {
        if (req.method === 'GET') {
          sendJson(res, 200, { ...wechat.status(), loopback: gate.loopback })
          return
        }
        if (req.method === 'POST') {
          if (!gate.loopback) {
            sendJson(res, 403, { error: '只有电脑端可以修改微信通知设置' })
            return
          }
          const body = await readJsonBody(req)
          // 200 carries a rejected webhook as data (ok:false), matching /api/test-connection: a form
          // that must show WHY is not a transport failure.
          sendJson(res, 200, wechat.configure({
            webhookUrl: body.webhookUrl,
            enabled: body.enabled,
            notifyOnFinish: body.notifyOnFinish,
          }))
          return
        }
      }

      if (url.pathname === '/api/wechat/test' && req.method === 'POST') {
        if (!gate.loopback) {
          sendJson(res, 403, { error: '只有电脑端可以发送测试消息' })
          return
        }
        const body = await readJsonBody(req).catch(() => ({}))
        // Let the test form try a URL before committing to it: without this the user would have to
        // save a possibly-wrong credential just to find out it does not work. Saving it also enables
        // push, so a successful test leaves the feature ready to go.
        const draftUrl = typeof body.webhookUrl === 'string' ? body.webhookUrl.trim() : ''
        if (draftUrl) {
          const saved = wechat.configure({ webhookUrl: draftUrl, enabled: true })
          if (!saved.ok) {
            sendJson(res, 200, saved)
            return
          }
        }
        // Push is best-effort; the result is data either way (ok:false for a refused send).
        const result = await wechat.notify({
          title: 'ChinaClaude-Mobot 测试消息',
          lines: ['如果你在群里看到这条消息，说明微信通知已经接通。', `时间：${new Date().toLocaleString('zh-CN')}`],
        })
        sendJson(res, 200, result)
        return
      }

      // ---- updates ------------------------------------------------------------
      /**
       * Ask the configured sources whether a newer build exists.
       *
       * Never fails the request: an unreachable host is a NORMAL outcome for this app, so the answer
       * distinguishes "no update" from "could not check" instead of turning into a 500 the UI would
       * have to interpret.
       */
      if (req.method === 'GET' && url.pathname === '/api/update') {
        lastCheck = await checkForUpdate({
          currentVersion: appVersion,
          sources: options.updateSources ?? DEFAULT_SOURCES,
        })
        sendJson(res, 200, {
          // Redacted by a named helper: the download URL must not cross into the page, so that a page
          // can never nominate a file for this process to fetch and execute.
          ...publicCheckResult(lastCheck),
          progress: updater.status(),
        })
        return
      }

      if (req.method === 'POST' && url.pathname === '/api/update/download') {
        const asset = lastCheck?.asset
        if (!asset?.url) {
          sendJson(res, 409, { error: '没有可下载的安装包：请先检查更新，或换一个能提供安装包的源', progress: updater.status() })
          return
        }
        // Fire and forget; the client polls /api/update/status for progress. `download` reports its
        // own failures through that status rather than by rejecting.
        void updater.download(asset)
        sendJson(res, 202, { started: true, progress: updater.status() })
        return
      }

      if (req.method === 'GET' && url.pathname === '/api/update/status') {
        sendJson(res, 200, updater.status())
        return
      }

      if (req.method === 'POST' && url.pathname === '/api/update/install') {
        try {
          sendJson(res, 200, updater.install())
        } catch (error) {
          sendJson(res, 409, { error: String(error?.message ?? error) })
        }
        return
      }

      // ---- bundled inventory --------------------------------------------------
      if (req.method === 'GET' && url.pathname === '/api/bundled') {
        const root = options.sidecarRoot ?? null
        const items = bundledInventory().map((component) => ({
          ...component,
          /** Whether the file actually shipped. Independent of whether anything loaded it. */
          present: root && component.evidencePath ? existsSync(join(root, component.evidencePath)) : null,
          absolutePath: root && component.evidencePath ? join(root, component.evidencePath) : null,
        }))
        sendJson(res, 200, {
          sidecarRoot: root,
          bundled: items,
          notBundled: NOT_BUNDLED,
        })
        return
      }

      // ---- plugin manager (the menu bar's 插件管理 window) ----------------------
      /**
       * The upstream plugins this build was asked to carry, each with how its capability is provided.
       *
       * Served from a registry rather than by scanning node_modules: this client does not install
       * plugins at runtime, so "what is here" is a fact about the build, and reading it from a
       * directory would report whatever happened to be on disk instead of what shipped.
       */
      if (req.method === 'GET' && url.pathname === '/api/plugins') {
        sendJson(res, 200, { plugins: builtinPluginList(), version: appVersion })
        return
      }

      // ---- 运行日志 ------------------------------------------------------------
      if (req.method === 'GET' && url.pathname === '/api/shell/logs') {
        const since = Number(url.searchParams.get('since') ?? 0) || 0
        sendJson(res, 200, logRing.snapshot(since))
        return
      }

      if (req.method === 'POST' && url.pathname === '/api/shell/logs/clear') {
        sendJson(res, 200, logRing.clear())
        return
      }

      if (req.method === 'POST' && url.pathname === '/api/shell/logs/reveal') {
        sendJson(res, 200, revealLogFile(logRing.file))
        return
      }

      // ---- 作者信息 / 休闲食品商城 ---------------------------------------------
      if (req.method === 'GET' && url.pathname === '/api/shell/author') {
        sendJson(res, 200, AUTHOR)
        return
      }

      if (req.method === 'GET' && url.pathname === '/api/shop/catalog') {
        sendJson(res, 200, { products: SHOP_PRODUCTS })
        return
      }

      // ---- 评价与反馈 ----------------------------------------------------------
      if (req.method === 'GET' && url.pathname === '/api/feedback') {
        sendJson(res, 200, { entries: feedback.list(), file: feedback.file })
        return
      }

      if (req.method === 'POST' && url.pathname === '/api/feedback') {
        const body = await readJsonBody(req)
        const result = feedback.submit({ message: body.message, email: body.email })
        // 200 with ok:false for a form the user must fix: that is a result, not a transport error.
        sendJson(res, 200, result)
        return
      }

      // ---- 项目记忆 (hindsight-coding-agents port) ------------------------------
      if (url.pathname === '/api/memory') {
        const answer = await withFeature('memory', async (mod) => {
          if (req.method === 'GET') return await mod.listMemory({ cwd: url.searchParams.get('cwd') ?? '' })
          const body = await readJsonBody(req)
          if (body.action === 'add') return await mod.addMemory({ cwd: body.cwd, text: body.text, kind: body.kind, tags: body.tags })
          if (body.action === 'remove') return await mod.removeMemory({ cwd: body.cwd, id: body.id })
          if (body.action === 'export') return await mod.exportMemory({ cwd: body.cwd })
          return { ok: false, error: `未知操作：${String(body.action)}` }
        })
        sendJson(res, 200, answer)
        return
      }

      // ---- 规则引擎 (rule-engine port) -----------------------------------------
      if (url.pathname === '/api/rules') {
        const answer = await withFeature('rules', async (mod) => {
          if (req.method === 'GET') return await mod.listRules()
          const body = await readJsonBody(req)
          if (body.action === 'save') return await mod.saveRule({ rule: body.rule })
          if (body.action === 'delete') return await mod.deleteRule({ id: body.id })
          if (body.action === 'test') return await mod.evaluateRules({ text: body.text, cwd: body.cwd })
          return { ok: false, error: `未知操作：${String(body.action)}` }
        })
        sendJson(res, 200, answer)
        return
      }

      // ---- 时间机器 (time-machine port) ----------------------------------------
      if (url.pathname === '/api/checkpoints') {
        const answer = await withFeature('checkpoints', async (mod) => {
          if (req.method === 'GET') {
            const what = url.searchParams.get('what') ?? 'list'
            if (what === 'usage') return await mod.checkpointUsage()
            return await mod.listCheckpoints({ cwd: url.searchParams.get('cwd') ?? '' })
          }
          const body = await readJsonBody(req)
          if (body.action === 'create') return await mod.createCheckpoint({ cwd: body.cwd, label: body.label, note: body.note })
          if (body.action === 'diff') return await mod.diffCheckpoint({ cwd: body.cwd, id: body.id })
          if (body.action === 'restore') return await mod.restoreCheckpoint({ cwd: body.cwd, id: body.id, files: body.files })
          if (body.action === 'delete') return await mod.deleteCheckpoint({ cwd: body.cwd, id: body.id })
          if (body.action === 'usage') return await mod.checkpointUsage()
          return { ok: false, error: `未知操作：${String(body.action)}` }
        })
        sendJson(res, 200, answer)
        return
      }

      // ---- 安全防护 (defend port) ----------------------------------------------
      if (url.pathname === '/api/defend') {
        const answer = await withFeature('defend', async (mod) => {
          if (req.method === 'GET') return await mod.defendStats()
          const body = await readJsonBody(req)
          if (body.action === 'scan') return await mod.scanText({ text: body.text, where: body.where ?? 'panel' })
          if (body.action === 'clear') return await mod.clearDefend()
          return { ok: false, error: `未知操作：${String(body.action)}` }
        })
        sendJson(res, 200, answer)
        return
      }

      // ---- 代码管理 (git-panel port) -------------------------------------------
      if (url.pathname === '/api/git') {
        const answer = await withFeature('gitpanel', async (mod) => {
          if (req.method === 'GET') {
            const cwd = url.searchParams.get('cwd') ?? ''
            const what = url.searchParams.get('what') ?? 'status'
            if (what === 'available') return await mod.gitAvailable()
            if (what === 'log') return await mod.gitLog({ cwd, limit: Number(url.searchParams.get('limit') ?? 20) || 20 })
            if (what === 'branches') return await mod.gitBranches({ cwd })
            if (what === 'stash') return await mod.gitStashList({ cwd })
            return await mod.gitStatus({ cwd })
          }
          const body = await readJsonBody(req)
          if (body.action === 'diff') return await mod.gitDiff({ cwd: body.cwd, file: body.file, staged: body.staged })
          if (body.action === 'commit') return await mod.gitCommit({ cwd: body.cwd, message: body.message, files: body.files })
          if (body.action === 'available') return await mod.gitAvailable()
          if (body.action === 'stage') return await mod.gitStage({ cwd: body.cwd, files: body.files })
          if (body.action === 'unstage') return await mod.gitUnstage({ cwd: body.cwd, files: body.files })
          if (body.action === 'discard') return await mod.gitDiscard({ cwd: body.cwd, path: body.path, confirm: body.confirm })
          if (body.action === 'branches') return await mod.gitBranches({ cwd: body.cwd })
          if (body.action === 'checkout') return await mod.gitCheckout({ cwd: body.cwd, branch: body.branch })
          if (body.action === 'stash-list') return await mod.gitStashList({ cwd: body.cwd })
          if (body.action === 'stash-save') return await mod.gitStashSave({ cwd: body.cwd, message: body.message })
          if (body.action === 'stash-apply') return await mod.gitStashUse({ cwd: body.cwd, index: body.index, action: 'apply' })
          if (body.action === 'stash-pop') return await mod.gitStashUse({ cwd: body.cwd, index: body.index, action: 'pop' })
          if (body.action === 'stash-drop') return await mod.gitStashUse({ cwd: body.cwd, index: body.index, action: 'drop', confirm: body.confirm })
          return { ok: false, error: `未知操作：${String(body.action)}` }
        })
        sendJson(res, 200, answer)
        return
      }

      // ---- 办公工具 (office-tools port) -----------------------------------------
      /**
       * Status only: the tools themselves run inside the MCP server the CLI spawns. This route exists so
       * the panel can say "handed to the CLI" versus "claimed in a badge" — the distinction the whole
       * built-in inventory is built on.
       */
      if (req.method === 'GET' && url.pathname === '/api/office') {
        const answer = await withFeature('office', async (mod) => mod.officeStatus())
        sendJson(res, 200, answer)
        return
      }

      // ---- IM 机器人（长轮询 / sync）------------------------------------------
      /**
       * Bots live beside the webhooks: same data root, same loopback-only write rule. The handler is wired
       * ONCE, lazily — it forwards a chat message into the session that chat is bound to, and refuses when
       * there is no binding instead of guessing a session.
       */
      if (url.pathname === '/api/im/bots') {
        if (req.method === 'GET') {
          const answer = await withFeature('bots', async (mod) => mod.botList())
          sendJson(res, 200, answer)
          return
        }
        const body = await readJsonBody(req)
        if (!gate.loopback) {
          sendJson(res, 403, { ok: false, error: '只有电脑端可以管理机器人' })
          return
        }
        const answer = await withFeature('bots', async (mod) => {
          if (!botsWired) {
            mod.setBotHandler(async (bot, chat, text) => {
              const sessionId = bot.bindings?.[chat] ?? bot.sessionId ?? null
              const session = sessionId ? sessions.get(sessionId) : null
              if (!session) return '这个聊天还没有绑定会话：在「消息通道 → 机器人」里绑定后再发。'
              session.send(text)
              return '已转给会话，稍后看回复。'
            })
            botsWired = true
          }
          if (body.action === 'save') return mod.botSave({ id: body.id, channel: body.channel, token: body.token, homeserver: body.homeserver, label: body.label, allowedChats: body.allowedChats, workspace: body.workspace })
          if (body.action === 'remove') return mod.botRemove({ id: body.id })
          if (body.action === 'bind') return mod.botBind({ id: body.id, chat: body.chat, sessionId: body.sessionId })
          if (body.action === 'start') return mod.startBot({ id: body.id })
          if (body.action === 'stop') return mod.stopBot({ id: body.id })
          return { ok: false, error: `未知操作：${String(body.action)}` }
        })
        sendJson(res, 200, answer)
        return
      }

      // ---- 消息通道 (dsh-im port): webhooks --------------------------------------
      /**
       * Writes are loopback-only: a webhook is a bearer credential, and a paired phone must not be able
       * to repoint it (or use this machine to post into a group). Reads are safe — they carry only the
       * masked endpoint, never the token.
       */
      if (url.pathname === '/api/im') {
        if (req.method === 'GET') {
          const answer = await withFeature('im', async (mod) => mod.imList())
          sendJson(res, 200, answer)
          return
        }
        const body = await readJsonBody(req)
        if (!gate.loopback) {
          sendJson(res, 403, { ok: false, error: '只有电脑端可以管理消息通道' })
          return
        }
        const answer = await withFeature('im', async (mod) => {
          if (body.action === 'save') return mod.imSave({ id: body.id, webhook: body.webhook, secret: body.secret })
          if (body.action === 'remove') return mod.imRemove({ id: body.id })
          if (body.action === 'test' || body.action === 'send') {
            return await mod.imSend({ id: body.id, text: body.text ?? 'ChinaClaude 连接测试：看到这条说明通道可用。' })
          }
          return { ok: false, error: `未知操作：${String(body.action)}` }
        })
        sendJson(res, 200, answer)
        return
      }

      // ---- 连接器 (third-party provider ports) ---------------------------------
      /**
       * A connector is only allowed to answer "this works" when it can carry a conversation for
       * `claude.exe`; the module decides that and reports the reason when it cannot. The route stays a
       * pass-through so the rule lives in one place.
       */
      if (url.pathname === '/api/connectors') {
        if (req.method === 'GET') {
          const answer = await withFeature('connectors', async (mod) => ({
            ok: true,
            connectors: mod.connectorList(),
            // `added` must describe the CURRENT state (rows still missing), not a stale one-time result.
            localRoutes: cliProvidersInfo
              ? {
                  ...cliProvidersInfo,
                  added: cliProvidersInfo.rows
                    .filter((row) => !readModels().providers.some((entry) => entry?.name === row.name || entry?.baseUrl === row.baseUrl))
                    .map((row) => row.name),
                }
              : null,
          }))
          sendJson(res, 200, answer)
          return
        }
        const body = await readJsonBody(req)
        const answer = await withFeature('connectors', async (mod) => {
          if (body.action === 'catalog') return await mod.connectorCatalog({ id: body.id, apiKey: body.apiKey })
          if (body.action === 'usage') return await mod.connectorUsage({ id: body.id, apiKey: body.apiKey })
          if (body.action === 'diagnose') return mod.connectorDiagnose({ id: body.id })
          if (body.action === 'apply') {
            const built = mod.connectorProviders({ id: body.id, apiKey: body.apiKey, models: body.models })
            if (!built.ok) return built
            // Applying is a models-store write, so it stays loopback-only for the same reason the
            // other management routes are: a phone must not repoint what this machine talks to.
            if (!gate.loopback) return { ok: false, error: '只有电脑端可以应用连接器配置' }
            writeModels([...readModels().providers, ...built.providers])
            return { ...built, providers: built.providers.map((row) => ({ ...row, apiKey: '' })) }
          }
          return { ok: false, error: `未知操作：${String(body.action)}` }
        })
        sendJson(res, 200, answer)
        return
      }

      /**
       * 翻译代理解析骨架。
       *
       * GET  answers "why can / can't this connector be proxied" (state + reason + the request shape).
       * POST is the endpoint a future proxy would serve; today it refuses with a code, never a 200 that
       * carries nothing. A 501 is the honest status for "the route exists, the protocol does not".
       */
      if (url.pathname === '/api/connectors/proxy') {
        if (req.method === 'GET') {
          const answer = await withFeature('connectors', async (mod) =>
            mod.connectorProxyStatus({ id: url.searchParams.get('id') ?? '' }),
          )
          sendJson(res, 200, answer)
          return
        }
        const body = await readJsonBody(req)
        if (!gate.loopback) {
          sendJson(res, 403, { ok: false, error: '只有电脑端可以调用连接器代理' })
          return
        }
        const answer = await withFeature('connectors', async (mod) => mod.connectorProxyRefuse({ id: body.id }))
        sendJson(res, 501, answer)
        return
      }

      // ---- WorkBuddy CLI 路由（Anthropic 兼容端点）----------------------------
      /**
       * This is the base URL `claude.exe` would be pointed at for the WorkBuddy connector. It is a
       * translation, not a forward: the CLI takes one prompt and prints an answer, so the history is
       * flattened and the answer is wrapped back into Anthropic shapes (JSON, or SSE when streaming).
       *
       * A CLI failure is a 502 with the reason — the CLI's own "Authentication required" is passed
       * through as `unauthenticated`, because that is the one failure the user can fix by logging in.
       */
      if (url.pathname === '/proxy/workbuddy/v1/messages' || url.pathname === '/proxy/workbuddy-cn/v1/messages') {
        // 国际版与国内版共用同一个翻译代理，只是导入时那一行的名字不同。
        if (req.method !== 'POST') {
          sendJson(res, 405, { ok: false, error: '只接受 POST' })
          return
        }
        const body = await readJsonBody(req)
        const answer = await withFeature('workbuddy', async (mod) => {
          const prompt = mod.flattenRequest(body)
          const result = await mod.askWorkBuddy({ prompt, cwd: body?.metadata?.cwd })
          if (!result.ok) return result
          return {
            ok: true,
            response: mod.toAnthropicResponse({ text: result.text, model: body?.model }),
            sse: mod.toAnthropicSse({ text: result.text, model: body?.model }),
          }
        })
        if (!answer.ok) {
          sendJson(res, answer.code === 'unauthenticated' ? 401 : 502, { type: 'error', error: { type: answer.code ?? 'api_error', message: answer.error ?? 'CLI 调用失败' } })
          return
        }
        if (body?.stream === true) {
          res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store' })
          res.end(answer.sse)
          return
        }
        sendJson(res, 200, answer.response)
        return
      }

      if (req.method === 'GET' && url.pathname === '/api/connectors/cli') {
        const answer = await withFeature('workbuddy', async (mod) => mod.workbuddyStatus())
        sendJson(res, 200, answer)
        return
      }

      /**
       * Trae 接入（MCP 方向）。这是「Trae 调用本应用的工具」，不是反向的模型代理；两者在响应里写清楚，
       * 免得设置页让人误以为 Trae 的模型已经能被 claude.exe 使用。
       */
      if (req.method === 'GET' && url.pathname === '/api/connectors/trae/integration') {
        const answer = await withFeature('trae', async (mod) =>
          mod.traeMcpIntegration({
            nodePath: process.env.CCCN_MCP_NODE ?? process.execPath,
            entryPath: process.env.CCCN_MCP_ENTRY ?? '',
          }),
        )
        sendJson(res, 200, answer)
        return
      }

      /** 保存用户粘贴的 WorkBuddy 令牌并用它真跑一次请求。 */
      if (req.method === 'POST' && url.pathname === '/api/connectors/cli/token') {
        if (!gate.loopback) {
          sendJson(res, 403, { ok: false, error: '只有电脑端可以保存令牌' })
          return
        }
        const body = await readJsonBody(req)
        const answer = await withFeature('workbuddy', async (mod) => await mod.setToken({ token: body.token }))
        sendJson(res, 200, answer)
        return
      }

      if (req.method === 'POST' && url.pathname === '/api/connectors/cli/login') {
        if (!gate.loopback) {
          sendJson(res, 403, { ok: false, error: '只有电脑端可以打开 CLI 登录窗口' })
          return
        }
        const answer = await withFeature('workbuddy', async (mod) => mod.openCliLogin())
        sendJson(res, 200, answer)
        return
      }

      if (req.method === 'POST' && url.pathname === '/api/connectors/cli/test') {
        if (!gate.loopback) {
          sendJson(res, 403, { ok: false, error: '只有电脑端可以测试 CLI 连接' })
          return
        }
        const answer = await withFeature('workbuddy', async (mod) => await mod.testCli())
        sendJson(res, 200, answer)
        return
      }

      /**
       * TRAE CLI 路由：与 WorkBuddy 同构 —— 把历史扁平化后交给官方 CLI 的无头模式，再把最终答复包回
       * Anthropic JSON / SSE。Trae IDE 本身没有模型 API，但官方 CLI 2.0 有，且登录/沙箱/审批都是它自己的
       * 一等公民，所以这里只做翻译，不碰凭据。
       */
      /**
       * opencode 免费模型：Anthropic 请求 → 一次 `opencode run --format json`。
       * 免费档只允许 OpenCode 客户端本身调用，所以这里驱动的是随包携带的官方 CLI，而不是直连 Zen。
       */
      if (url.pathname === '/proxy/opencode-free/v1/messages') {
        if (req.method !== 'POST') {
          sendJson(res, 405, { ok: false, error: '只接受 POST' })
          return
        }
        const body = await readJsonBody(req)
        const answer = await withFeature('opencode-free', async (mod) => {
          const wb = await import('./workbuddy.mjs')
          const prompt = wb.flattenRequest(body)
          const result = await mod.askOpencode({ prompt, model: body?.model, cwd: body?.metadata?.cwd })
          if (!result.ok) return result
          return {
            ok: true,
            response: wb.toAnthropicResponse({ text: result.text, model: body?.model ?? 'opencode-free' }),
            sse: wb.toAnthropicSse({ text: result.text, model: body?.model ?? 'opencode-free' }),
          }
        })
        if (!answer.ok) {
          sendJson(res, 502, { type: 'error', error: { type: answer.code ?? 'api_error', message: answer.error ?? 'opencode 调用失败' } })
          return
        }
        if (body?.stream === true) {
          res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store' })
          res.end(answer.sse)
          return
        }
        sendJson(res, 200, answer.response)
        return
      }

      if (url.pathname === '/proxy/trae/v1/messages') {
        if (req.method !== 'POST') {
          sendJson(res, 405, { ok: false, error: '只接受 POST' })
          return
        }
        const body = await readJsonBody(req)
        const answer = await withFeature('traecli', async (mod) => {
          const result = await mod.askTrae({ prompt: mod.flattenAnthropicRequest(body), cwd: body?.metadata?.cwd })
          if (!result.ok) return result
          const wb = await import('./workbuddy.mjs')
          return {
            ok: true,
            response: wb.toAnthropicResponse({ text: result.text, model: body?.model ?? 'traecli' }),
            sse: wb.toAnthropicSse({ text: result.text, model: body?.model ?? 'traecli' }),
          }
        })
        if (!answer.ok) {
          sendJson(res, answer.code === 'unauthenticated' ? 401 : 502, { type: 'error', error: { type: answer.code ?? 'api_error', message: answer.error ?? 'traecli 调用失败' } })
          return
        }
        if (body?.stream === true) {
          res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store' })
          res.end(answer.sse)
          return
        }
        sendJson(res, 200, answer.response)
        return
      }

      if (req.method === 'GET' && url.pathname === '/api/connectors/trae/auth') {
        const answer = await withFeature('trae', async (mod) => mod.traeAuthStatus())
        sendJson(res, 200, answer)
        return
      }
      if (req.method === 'GET' && url.pathname === '/api/connectors/trae/cli') {
        const answer = await withFeature('traecli', async (mod) => {
          const status = mod.traeCliStatus()
          const login = status.available ? await mod.traeLoginStatus() : { available: false, loggedIn: false }
          return { ...status, loggedIn: login.loggedIn === true, loginDetail: login.detail ?? null }
        })
        sendJson(res, 200, answer)
        return
      }

      if (req.method === 'POST' && url.pathname === '/api/connectors/trae/cli/test') {
        if (!gate.loopback) {
          sendJson(res, 403, { ok: false, error: '只有电脑端可以测试 TRAE CLI' })
          return
        }
        const answer = await withFeature('traecli', async (mod) => {
          const result = await mod.askTrae({ prompt: '这是连接测试，只回复 OK 两个字。', timeoutMs: 120000 })
          return result.ok
            ? { ok: true, text: result.text, baseUrlHint: 'http://127.0.0.1:43130/proxy/trae' }
            : { ok: false, code: result.code, error: result.error }
        })
        sendJson(res, 200, answer)
        return
      }

      if (req.method === 'POST' && url.pathname === '/api/connectors/trae/cli/login') {
        if (!gate.loopback) {
          sendJson(res, 403, { ok: false, error: '只有电脑端可以打开登录窗口' })
          return
        }
        /**
         * 不再弹终端：CLI 登录时会在 stderr 打出浏览器授权地址，桥把它抓出来直接用默认浏览器打开。
         * MEASURED: 这个 CLI 构建打出的是企业版 SSO 地址（console.enterprise.trae.cn），响应里如实标注。
         */
        const answer = await withFeature('traecli', async (mod) => await mod.startTraeLogin())
        if (answer.ok && answer.url) {
          const { spawn: spawnProcess } = await import('node:child_process')
          try {
            spawnProcess('cmd', ['/c', 'start', '', answer.url], { detached: true, stdio: 'ignore', windowsHide: true }).unref()
          } catch {
            /* 打开浏览器失败时仍把 URL 交给前端 */
          }
        }
        sendJson(res, 200, answer)
        return
      }
      /**
       * 一键导入模型：把「本机已有的凭据」变成模型列表里的行。
       *
       * - trae: `traecli models` 的真实清单（21 个），全部指向本桥 /proxy/trae；
       * - workbuddy: 有令牌时走 /v3/config 真实清单（UA 必须是无空格的 WorkBuddyAI/<版本>），
       *   无令牌时退回一条默认行并说明原因；
       * - opencode: 用 Key 拉真实目录。
       */
      if (req.method === 'POST' && url.pathname === '/api/models/import') {
        if (!gate.loopback) {
          sendJson(res, 403, { ok: false, error: '只有电脑端可以导入模型' })
          return
        }
        const body = await readJsonBody(req)
        const source = String(body.source ?? '')
        const port = req.socket.localPort || options.port || 43130
        const answer = await withFeature('connectors', async (mod) => {
          if (source === 'opencode') {
            const key = String(body.apiKey ?? '').trim()
            if (key === '') return { ok: false, error: 'opencode 需要先填 API Key' }
            const catalog = await mod.connectorCatalog({ id: 'opencode-go', apiKey: key })
            if (!catalog.ok) return catalog
            const built = mod.connectorProviders({ id: 'opencode-go', apiKey: key, models: catalog.models })
            if (!built.ok) return built
            const snapshot = readModels()
            const merged = mod.mergeCliProviders(snapshot.providers, built.providers)
            writeModels(merged.providers)
            return { ok: true, source, added: merged.added.map((row) => row.name), modelCount: built.providers.length }
          }

          if (source === 'trae') {
            const traecli = await withFeature('traecli', async (m) => m)
            if (!traecli.discoverTraeCli().cli) return { ok: false, error: '未检测到已安装的 Trae（traecli）。请先安装 TRAE CLI 并登录，再点「从 Trae 导入模型」。' }
            const listed = await traecli.listTraeModels()
            if (!listed.ok) return listed
            const row = {
              name: 'TRAE CLI',
              baseUrl: `http://127.0.0.1:${port}/proxy/trae`,
              apiKey: 'local-cli',
              provider: 'TRAE CLI',
              models: listed.models.map((model) => ({ id: `trae-${model}`, model, label: model })),
            }
            const snapshot = readModels()
            const existing = snapshot.providers.find((entry) => entry?.baseUrl === row.baseUrl)
            if (existing) {
              existing.models = row.models
              writeModels(snapshot.providers)
              return { ok: true, source, added: [], modelCount: row.models.length, loggedIn: (await traecli.traeLoginStatus()).loggedIn === true }
            }
            writeModels([...snapshot.providers, row])
            return { ok: true, source, added: [row.name], modelCount: row.models.length, loggedIn: (await traecli.traeLoginStatus()).loggedIn === true }
          }

          if (source === 'opencode-free') {
            const free = await withFeature('opencode-free', async (mod) => mod)
            const listed = await free.listFreeModels()
            if (!listed.ok) return { ok: false, error: listed.error }
            const row = {
              name: 'OpenCode 免费',
              baseUrl: `http://127.0.0.1:${port}/proxy/opencode-free`,
              apiKey: 'local',
              provider: 'OpenCode Free',
              models: listed.models.map((id) => ({ id: `ocfree-${id}`, model: id, label: id.replace(/^opencode\//, '') })),
            }
            const snapshot = readModels()
            const existing = snapshot.providers.find((entry) => entry?.baseUrl === row.baseUrl)
            if (existing) {
              existing.models = row.models
              writeModels(snapshot.providers)
              return { ok: true, source, added: [], modelCount: row.models.length }
            }
            writeModels([...snapshot.providers, row])
            return { ok: true, source, added: [row.name], modelCount: row.models.length }
          }

          if (source === 'kimi') {
            const key = String(body.apiKey ?? '').trim()
            if (key === '') return { ok: false, error: 'Kimi 需要先填 API Key（https://platform.moonshot.cn）' }
            try {
              const response = await fetch('https://api.moonshot.cn/v1/models', { headers: { authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(20000) })
              const payload = await response.json().catch(() => null)
              if (!response.ok) return { ok: false, error: `Kimi 返回 HTTP ${response.status}：${JSON.stringify(payload).slice(0, 160)}` }
              const models = (payload?.data ?? []).map((entry) => String(entry.id ?? '')).filter((id) => id !== '')
              if (models.length === 0) return { ok: false, error: 'Kimi 没有返回模型' }
              const row = {
                name: 'Kimi',
                baseUrl: 'https://api.moonshot.cn/anthropic',
                apiKey: key,
                provider: 'Kimi',
                models: models.map((id) => ({ id: `kimi-${id}`, model: id, label: id })),
              }
              const snapshot = readModels()
              const existing = snapshot.providers.find((entry) => entry?.baseUrl === row.baseUrl)
              if (existing) {
                existing.models = row.models
                existing.apiKey = key
                writeModels(snapshot.providers)
                return { ok: true, source, added: [], modelCount: row.models.length }
              }
              writeModels([...snapshot.providers, row])
              return { ok: true, source, added: [row.name], modelCount: row.models.length }
            } catch (error) {
              return { ok: false, error: `连不上 api.moonshot.cn：${String(error?.message ?? error)}` }
            }
          }

                    if (source === 'free-model') {
            /**
             * 零配置：用户只点按钮。地址与密钥由桥自己从插件配置 + 本机端口探测得出；
             * 探测不到时返回「去 DSH 里打开本地转发」的可执行提示，而不是让用户填地址。
             */
            // 随包服务优先：不需要 DSH、不需要任何开关。只有它起不来（运行时缺失等）才回落到
            // DSH 里那个插件的网关，最后才把两边的失败原因一起报给用户。
            const bundled = await ofm.detectBundled().catch(() => null)
            const detected = bundled?.ok ? bundled : await ourfree.detectGateway()
            if (!detected.ok) return { ok: false, error: detected.error, tried: detected.tried }
            const row = {
              name: 'Our Free Model',
              baseUrl: detected.base,
              apiKey: detected.secret || 'local',
              provider: 'Our Free Model',
              models: detected.models.map((id) => ({ id: `ofm-${id}`, model: id, label: id })),
            }
            const snapshot = readModels()
            const existing = snapshot.providers.find((entry) => entry?.baseUrl === row.baseUrl)
            if (existing) {
              existing.models = row.models
              existing.apiKey = row.apiKey
              writeModels(snapshot.providers)
              return { ok: true, source, added: [], modelCount: row.models.length, gateway: detected.base }
            }
            writeModels([...snapshot.providers, row])
            return { ok: true, source, added: [row.name], modelCount: row.models.length, gateway: detected.base }
          }

          if (source === 'codebuddy') {
            const workbuddy = await withFeature('workbuddy', async (m) => m)
            const desktop = workbuddy.readDesktopToken()
            if (!desktop.token) {
              return {
                ok: false,
                error: desktop.encrypted
                  ? 'CodeBuddy 桌面端已登录，但令牌是加密的（新版），暂时读不出明文；请先保存令牌后再导入。'
                  : '未检测到 CodeBuddy / WorkBuddy 桌面端的登录态：请先安装并登录桌面端，再点「从 CodeBuddy 导入模型」。',
              }
            }
            const catalog = await workbuddy.fetchCodebuddyCatalog()
            const models = catalog.ok ? catalog.payload?.data?.models : null
            if (!Array.isArray(models) || models.length === 0) {
              return { ok: false, error: catalog.ok ? 'CodeBuddy 返回的模型清单为空：令牌可能无效或已过期' : catalog.error }
            }
            const row = {
              name: 'CodeBuddy 国内版',
              // ?cn=1 只是让这一行和 WorkBuddy 国际版区分开（同一个翻译代理，同一个 CLI）。
              baseUrl: `http://127.0.0.1:${port}/proxy/workbuddy-cn`,
              apiKey: '',
              provider: 'CodeBuddy',
              models: models
                .map((entry) => {
                  const id = String(entry?.id ?? entry?.model ?? entry?.name ?? '')
                  const label = String(entry?.displayName ?? entry?.display_name ?? entry?.name ?? id)
                  return { id: `cb-${id}`, model: id, label }
                })
                .filter((entry) => entry.model !== "" && !/^(default|fast|balanced|primary|auto)-model$/i.test(entry.model)),
            }
            const snapshot = readModels()
            const existing = snapshot.providers.find((entry) => entry?.baseUrl === row.baseUrl)
            if (existing) {
              existing.models = row.models
              writeModels(snapshot.providers)
            } else {
              writeModels([...snapshot.providers, row])
            }
            return { ok: true, source, added: existing ? [] : [row.name], modelCount: row.models.length, via: 'v3-config-cn' }
          }
if (source === 'workbuddy') {
            const workbuddy = await withFeature('workbuddy', async (m) => m)
            if (!workbuddy.discoverWorkBuddyCli().cli) return { ok: false, error: '未检测到已安装的 WorkBuddy（CodeBuddy CLI）。请先安装 WorkBuddy 桌面端并登录，再点「从 WorkBuddy 导入模型」。' }
            if (workbuddy.tokenStatus().hasToken || workbuddy.readDesktopToken().token) {
              const catalog = await workbuddy.fetchWorkbuddyCatalog()
              const models = catalog.ok ? catalog.payload?.data?.models : null
              if (Array.isArray(models) && models.length > 0) {
                const row = {
                  name: 'WorkBuddy AI',
                  baseUrl: `http://127.0.0.1:${port}/proxy/workbuddy`,
                  apiKey: 'local-cli',
                  provider: 'WorkBuddy',
                  models: models
                    .map((entry) => {
                      const id = String(entry?.id ?? entry?.model ?? entry?.name ?? '')
                      const label = String(entry?.displayName ?? entry?.display_name ?? entry?.name ?? id)
                      return { id: `wb-${id}`, model: id, label }
                    })
                    // 过滤「模式」条目：default-model / fast-model / balanced-model / primary-model 是推理档位，
                    // 不是可选择的模型名，列出来只会制造噪音。
                    .filter((entry) => entry.model !== '' && !/^(default|fast|balanced|primary|auto)-model$/i.test(entry.model)),
                }
                const snapshot = readModels()
                const existing = snapshot.providers.find((entry) => entry?.baseUrl === row.baseUrl)
                if (existing) {
                  existing.models = row.models
                  writeModels(snapshot.providers)
                } else {
                  writeModels([...snapshot.providers, row])
                }
                return { ok: true, source, added: existing ? [] : [row.name], modelCount: row.models.length, via: 'v3-config' }
              }
              return { ok: false, error: catalog.ok ? 'WorkBuddy 返回的模型清单为空：令牌可能无效或已过期' : catalog.error }
            }
            const rows = mod.cliProviderRows({ port, workbuddyCli: workbuddy.discoverWorkBuddyCli().cli })
              .rows.filter((row) => row.baseUrl.includes('/proxy/workbuddy'))
            const snapshot = readModels()
            const merged = mod.mergeCliProviders(snapshot.providers, rows)
            if (merged.added.length > 0) writeModels(merged.providers)
            return {
              ok: true,
              source,
              added: merged.added.map((row) => row.name),
              modelCount: 1,
              via: 'default',
              hint: '没有保存令牌，只能导入一条默认通道；粘贴令牌后可导入真实模型清单与积分。',
            }
          }

          return { ok: false, error: `未知来源：${source}` }
        })
        sendJson(res, 200, answer)
        return
      }
      // ---- 远程运维 (remote-ssh-ops port) --------------------------------------
      /**
       * Every write here is loopback-only for the same reason the other management routes are: a paired
       * phone must not be able to add a host or run a command on this machine's behalf. `sshExec` is the
       * sharpest capability in the app, so the gate is checked here as well as inside the module.
       */
      if (url.pathname === '/api/ssh') {
        if (req.method === 'GET') {
          const what = url.searchParams.get('what') ?? 'hosts'
          const answer = await withFeature('ssh', async (mod) => {
            if (what === 'status') return await mod.sshStatus()
            return mod.sshListHosts()
          })
          sendJson(res, 200, answer)
          return
        }
        const body = await readJsonBody(req)
        if (!gate.loopback) {
          sendJson(res, 403, { ok: false, error: '只有电脑端可以管理远程主机' })
          return
        }
        const answer = await withFeature('ssh', async (mod) => {
          if (body.action === 'add') return mod.sshAddHost({ name: body.name, host: body.host, port: body.port, user: body.user, keyPath: body.keyPath })
          if (body.action === 'remove') return mod.sshRemoveHost({ id: body.id })
          if (body.action === 'probe') return await mod.sshProbeHost({ host: body.host, port: body.port })
          if (body.action === 'confirm') return mod.sshConfirmHost({ id: body.id, line: body.line, fingerprint: body.fingerprint })
          if (body.action === 'exec') return await mod.sshExec({ id: body.id, command: body.command, timeoutMs: body.timeoutMs })
          if (body.action === 'read') return await mod.sshReadFile({ id: body.id, path: body.path })
          return { ok: false, error: `未知操作：${String(body.action)}` }
        })
        sendJson(res, 200, answer)
        return
      }

      // ---- 网页搜索 (modsearch) --------------------------------------------------
      if (url.pathname === '/api/search') {
        const query = url.searchParams.get('q') ?? ''
        const answer = await searchWeb({ query, limit: Number(url.searchParams.get('limit') ?? 8) })
        sendJson(res, 200, answer)
        return
      }

      // ---- 代码测试 (qa-skills) ---------------------------------------------------
      if (url.pathname === '/api/qa') {
        if (req.method === 'GET') {
          sendJson(res, 200, detectTests({ cwd: url.searchParams.get('cwd') ?? '' }))
          return
        }
        if (!gate.loopback) {
          sendJson(res, 403, { ok: false, error: '只有电脑端可以执行测试命令' })
          return
        }
        const body = await readJsonBody(req)
        sendJson(res, 200, await runTest({ cwd: body.cwd, command: body.command, timeoutMs: body.timeoutMs }))
        return
      }

      // ---- 消息回滚 (message-ops) -------------------------------------------------
      if (url.pathname === '/api/rollback') {
        if (!gate.loopback) {
          sendJson(res, 403, { ok: false, error: '只有电脑端可以回滚会话' })
          return
        }
        const body = await readJsonBody(req)
        const session = sessions.get(String(body.sessionId ?? ''))
        if (!session) {
          sendJson(res, 404, { ok: false, error: 'session not found' })
          return
        }
        // 记录文件用的是 CLI 自己的会话 id，不是桥的 id —— 用错了就会「找不到记录文件」。
        const result = rollbackLastTurn({ sessionId: session.claudeSessionId, text: body.text })
        if (result.ok) {
          // 不在这里重启：会话会当场变成「已结束」，而用户只是想撤回一轮。
          // 标记一下，下一次发送前再按截断后的记录重启。
          session.rollbackPending = true
          result.pending = true
        }
        sendJson(res, 200, result)
        return
      }

      /**
       * 撤回前先问「会动哪些文件」：这条消息之后工具改过的东西，还原前必须让用户看见。
       * 时间戳来自事件里的 at —— 会话记录和快照目录各自编号，只有时间在两边都稳定。
       */
      if (url.pathname === '/api/rollback/preview') {
        if (!gate.loopback) {
          sendJson(res, 403, { ok: false, error: '只有电脑端可以回滚会话' })
          return
        }
        const body = await readJsonBody(req)
        const session = sessions.get(String(body.sessionId ?? ''))
        if (!session) {
          sendJson(res, 404, { ok: false, error: 'session not found' })
          return
        }
        const wanted = String(body.text ?? '').trim()
        const event = [...session.history].reverse().find((item) => item.kind === 'user' && (item.text ?? '').trim() === wanted)
        if (!event) {
          sendJson(res, 200, { ok: false, error: '会话事件里找不到这条消息' })
          return
        }
        const preview = previewTurnFiles({ sessionId: session.id, since: event.at })
        sendJson(res, 200, { ...preview, since: event.at })
        return
      }

      if (url.pathname === '/api/rollback/restore') {
        if (!gate.loopback) {
          sendJson(res, 403, { ok: false, error: '只有电脑端可以还原文件' })
          return
        }
        const body = await readJsonBody(req)
        sendJson(res, 200, restoreTurnFiles({ sessionId: body.sessionId, since: body.since, paths: body.paths }))
        return
      }

      // ---- 工作台 (workbench port) ---------------------------------------------
      /**
       * The workspace panel: tree, preview, search, changes.
       *
       * Every call takes `cwd` and a WORKSPACE-RELATIVE path; the module resolves and confines both
       * (realpath on each side), so a page cannot walk out of the workspace by sending `..` or an
       * absolute path. That check is not repeated here on purpose — one implementation, one place to
       * audit.
       */
      if (req.method === 'GET' && url.pathname === '/api/workbench/tree') {
        const answer = await withFeature('workbench', async (mod) =>
          mod.workbenchTree({
            cwd: url.searchParams.get('cwd') ?? '',
            path: url.searchParams.get('path') ?? '',
          }),
        )
        sendJson(res, 200, answer)
        return
      }

      if (req.method === 'GET' && url.pathname === '/api/workbench/file') {
        const answer = await withFeature('workbench', async (mod) =>
          mod.workbenchFile({
            cwd: url.searchParams.get('cwd') ?? '',
            path: url.searchParams.get('path') ?? '',
          }),
        )
        sendJson(res, 200, answer)
        return
      }

      if (req.method === 'GET' && url.pathname === '/api/workbench/search') {
        const answer = await withFeature('workbench', async (mod) =>
          mod.workbenchSearch({
            cwd: url.searchParams.get('cwd') ?? '',
            query: url.searchParams.get('q') ?? '',
            limit: Number(url.searchParams.get('limit') ?? 0) || undefined,
          }),
        )
        sendJson(res, 200, answer)
        return
      }

      if (req.method === 'GET' && url.pathname === '/api/workbench/changes') {
        const cwd = url.searchParams.get('cwd') ?? ''
        const answer = await withFeature('workbench', async (mod) => mod.workbenchChanges({ cwd }))
        // 按轮差异 rides on the same route: one request returns both "uncommitted" and "this turn", which
        // is how the review tab shows them side by side.
        const sessionId = url.searchParams.get('sessionId') ?? ''
        if (sessionId !== '') {
          const turns = await withFeature('turns', async (mod) => ({
            ok: true,
            turns: mod.listTurns({ sessionId }).turns,
            ...(url.searchParams.get('turn') !== null
              ? mod.turnDiff({ sessionId, turn: Number(url.searchParams.get('turn')) })
              : {}),
          }))
          sendJson(res, 200, { ...answer, ...turns })
          return
        }
        sendJson(res, 200, answer)
        return
      }

      // ---- 图片理解 (modlens port) ---------------------------------------------
      if (req.method === 'GET' && url.pathname === '/api/vision/status') {
        const answer = await withFeature('vision', async (mod) => await mod.visionStatus({ skillsRoot: options.skillsRoot }))
        sendJson(res, 200, answer)
        return
      }

      if (req.method === 'GET' && url.pathname === '/api/vision/images') {
        const answer = await withFeature('vision', async (mod) =>
          await mod.listImages({ dir: url.searchParams.get('dir') ?? '', limit: Number(url.searchParams.get('limit') ?? 200) || 200 }),
        )
        sendJson(res, 200, answer)
        return
      }

      if (req.method === 'POST' && url.pathname === '/api/vision/read') {
        const body = await readJsonBody(req)
        const answer = await withFeature('vision', async (mod) =>
          await mod.readImage({ skillsRoot: options.skillsRoot, path: body.path, focus: body.focus }),
        )
        sendJson(res, 200, answer)
        return
      }

      // ---- environment discovery ---------------------------------------------
      if (req.method === 'GET' && url.pathname === '/api/discovery') {
        sendJson(res, 200, scanner.scan())
        return
      }

      // ---- directory browser (workspace picker) ------------------------------
      if (req.method === 'GET' && url.pathname === '/api/directories/roots') {
        sendJson(res, 200, { roots: listRoots() })
        return
      }

      if (req.method === 'GET' && url.pathname === '/api/directories') {
        // `path` absent means "start at home"; `hidden=1` reveals dotfolders.
        const target = url.searchParams.get('path') ?? undefined
        const includeHidden = url.searchParams.get('hidden') === '1'
        try {
          sendJson(res, 200, listDirectories(target, { includeHidden }))
        } catch (error) {
          if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') {
            sendJson(res, 404, { error: String(error.message), code: error.code })
            return
          }
          if (error?.code === 'EACCES' || error?.code === 'EPERM') {
            sendJson(res, 403, { error: `无权限访问: ${target}`, code: error.code })
            return
          }
          throw error
        }
        return
      }

      // ---- directory security audit (plugin-vet engine) ------------------------
      if (req.method === 'GET' && url.pathname === '/api/vet/status') {
        const status = scannerStatus()
        sendJson(res, 200, {
          available: status.available,
          reason: status.reason,
          /** The engine's own rule-set version, so a verdict can be attributed to a rule set. */
          engine: status.available ? ENGINE_VERSION : null,
        })
        return
      }

      if (req.method === 'POST' && url.pathname === '/api/vet/scan') {
        const body = await readJsonBody(req)
        const target = typeof body.path === 'string' ? body.path : ''
        if (!target.trim()) {
          sendJson(res, 400, { error: 'path is required' })
          return
        }
        // An audit that cannot run must say so; returning an empty report would read as "clean".
        const result = await scanDirectory(target, {
          scanBasis: body.scanBasis === 'npm' ? 'npm' : 'git',
          targetKind: body.targetKind === 'generic' ? 'generic' : 'plugin',
          osv: body.osv === true,
          includeTextSurfaces: body.includeTextSurfaces !== false,
        })
        if (!result.ok) {
          sendJson(res, 200, { ok: false, error: result.error, meta: result.meta ?? null })
          return
        }
        sendJson(res, 200, {
          ok: true,
          meta: result.meta,
          report: {
            ...result.report,
            groups: groupFindings(result.report.findings),
          },
        })
        return
      }

      // ---- existing Claude Code transcripts (import panel) ---------------------
      if (req.method === 'GET' && url.pathname === '/api/transcripts') {
        const query = url.searchParams.get('q') ?? ''
        const listing = await listTranscripts({ query })
        sendJson(res, 200, { ...listing, groups: groupTranscripts(listing.transcripts) })
        return
      }

      if (req.method === 'POST' && url.pathname === '/api/transcripts/export') {
        const body = await readJsonBody(req)
        const sessionId = typeof body.sessionId === 'string' ? body.sessionId : ''
        if (!sessionId.trim()) {
          sendJson(res, 400, { error: 'sessionId is required' })
          return
        }
        const result = await transcriptToMarkdown(sessionId)
        if (!result.ok) {
          sendJson(res, 404, { error: result.error })
          return
        }
        sendJson(res, 200, { markdown: result.markdown, meta: result.meta })
        return
      }

      // ---- connection test (endpoint + key + model in one call) ----------------
      if (req.method === 'POST' && url.pathname === '/api/test-connection') {
        const body = await readJsonBody(req)
        const result = await testConnection({
          baseUrl: typeof body.baseUrl === 'string' ? body.baseUrl : '',
          // An explicit empty key means "none supplied" here, never "use the bridge default": the
          // point of the test is to check the key THE USER TYPED.
          apiKey: body.apiKey === undefined || body.apiKey === null ? '' : String(body.apiKey),
          model: typeof body.model === 'string' ? body.model : '',
        })
        // 200 with ok:false for a failed test: "the endpoint said no" is a result, not a transport error.
        sendJson(res, 200, result)
        return
      }

      // ---- account balance (provider's own API) --------------------------------
      if (req.method === 'POST' && url.pathname === '/api/balance') {
        const body = await readJsonBody(req)
        /**
         * An EXPLICIT empty key means "no key", not "use the bridge default".
         *
         * The distinction is a correctness one: falling back to the bridge's credential for a
         * provider the page did not supply a key for would display ANOTHER account's balance and
         * present it as this provider's. `??` keeps absent distinct from empty, the same rule the
         * session route already follows.
         */
        const effectiveBaseUrl =
          typeof body.baseUrl === 'string' && body.baseUrl ? body.baseUrl : defaults.baseUrl
        let apiKey = body.apiKey !== undefined && body.apiKey !== null ? String(body.apiKey) : (defaults.authToken ?? '')
        /**
         * A REMOTE caller has no key BY DESIGN: models are shared with phones with their credentials
         * stripped, so the phone's balance request always arrives empty and used to render "未配置
         * API KEY" while the desktop showed a figure for the same account. Resolve the stored key for
         * this endpoint on the bridge instead — the phone still never receives the credential. Loopback
         * keeps the original rule, so a typed-but-empty key on the desktop still means "no key".
         */
        if (!apiKey && !gate.loopback) apiKey = keyForBaseUrl(effectiveBaseUrl)
        const result = await fetchBalance({
          baseUrl: effectiveBaseUrl,
          apiKey,
          balanceUrl: typeof body.balanceUrl === 'string' ? body.balanceUrl : '',
          balancePath: typeof body.balancePath === 'string' ? body.balancePath : '',
          currency: typeof body.currency === 'string' ? body.currency : '',
        })
        sendJson(res, 200, result)
        return
      }

      // ---- attachments (files handed to the conversation) ----------------------
      if (req.method === 'POST' && url.pathname === '/api/attachments') {
        const body = await readJsonBody(req)
        const saved = saveAttachments(body.files)
        if (!saved.ok) {
          sendJson(res, 400, { ok: false, error: saved.error ?? '没有可用的附件', results: saved.results ?? [] })
          return
        }
        // A partial success is still 200: the ones that landed are usable, and the response says
        // exactly which failed so the UI can name them instead of failing the whole attach.
        sendJson(res, 200, saved)
        return
      }

      if (req.method === 'GET' && url.pathname === '/api/attachments') {
        sendJson(res, 200, attachmentsUsage())
        return
      }

      if (req.method === 'DELETE' && url.pathname === '/api/attachments') {
        sendJson(res, 200, clearAttachments())
        return
      }

      // ---- shared "current session" ------------------------------------------
      /**
       * 当前会话的三个桥级接口。
       *
       * WHY：见模块级 `activeSessionId` 的注释——桌面端与手机端共享的是同一个桥，谁在前台
       * 不该由各自浏览器决定。这三个接口都很薄：读快照、显式切换、订阅变化；真正的会话数据
       * 仍走已有的 `/api/sessions` 与 `/api/sessions/:id/events`。
       */
      if (req.method === 'GET' && url.pathname === '/api/state') {
        sendJson(res, 200, { activeSessionId, sessions: listSessions() })
        return
      }

      if (req.method === 'POST' && url.pathname === '/api/state/active') {
        const body = await readJsonBody(req)
        const requested = typeof body.sessionId === 'string' ? body.sessionId : ''
        if (!requested) {
          sendJson(res, 400, { error: 'sessionId is required' })
          return
        }
        if (!sessions.has(requested)) {
          sendJson(res, 404, { error: 'session not found' })
          return
        }
        /**
         * 这里刻意不加“仅本机”限制：手机正是需要切换当前会话的那个客户端，而上面的
         * `remote.authorize` 已经校验过配对 cookie。只要配对通过，就允许改这个共享指针。
         */
        rememberActiveSession(requested)
        sendJson(res, 200, { activeSessionId, session: sessions.get(requested).toJSON() })
        return
      }

      if (req.method === 'GET' && url.pathname === '/api/state/events') {
        res.writeHead(200, {
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-cache, no-transform',
          Connection: 'keep-alive',
          'X-Accel-Buffering': 'no',
        })
        // 与 `/api/sessions/:id/events` 一致的写法：连接注释、心跳、close 清理。
        res.write(': connected\n\n')
        // 立刻补一帧当前值：客户端可能在切换之后才连上来，EventSource 不会替它“读当前状态”。
        res.write(stateFrame())
        stateSubscribers.add(res)
        const ping = setInterval(() => res.write(': ping\n\n'), 15000)
        req.on('close', () => {
          clearInterval(ping)
          stateSubscribers.delete(res)
        })
        return
      }

      // ---- list sessions ------------------------------------------------------
      if (req.method === 'GET' && url.pathname === '/api/sessions') {
        sendJson(res, 200, { sessions: listSessions() })
        return
      }

      // ---- create session -----------------------------------------------------
      if (req.method === 'POST' && url.pathname === '/api/sessions') {
        const body = await readJsonBody(req)
        const session = new ClaudeSession({
          binary: options.binary,
          cwd: body.cwd || process.cwd(),
          baseUrl: body.baseUrl || defaults.baseUrl,
          // Per-session credentials let the setup form supply a key without the bridge
          // ever persisting it; `??` keeps an explicit empty string distinct from absent.
          authToken: body.authToken ?? defaults.authToken,
          apiKey: body.apiKey ?? defaults.apiKey,
          model: body.model || defaults.model || undefined,
          permissionMode: body.permissionMode || defaults.permissionMode || undefined,
           // Reasoning effort pinned to the chosen model, if the user set one. Absent is the
          // normal case and leaves the CLI on its model default.
          effort: typeof body.effort === 'string' && body.effort ? body.effort : undefined,
          resumeSessionId: body.resumeSessionId || undefined,
          proxy: body.proxy || defaults.proxy || undefined,
          // Bundled skills are mounted for EVERY session; the user never has to opt in.
          skillsRoot: options.skillsRoot,
          // Office tools, pinned to THIS session's workspace (see `sessionMcpConfig`).
          mcpConfig: sessionMcpConfig(body.cwd || process.cwd()) ?? undefined,
          // 本工作区的项目记忆随会话注入（见 memoryAppendix：CLAUDE.memory.md 不会被 CLI 自动读，
          // 因此导出只是给人看的，真正影响会话的是这个附录）。
          systemPromptAppend: await memoryAppendix(body.cwd || process.cwd()),
        })

        // No separate pre-attach buffer is kept: ClaudeSession already appends every event
        // to `history`, and the SSE handler replays it. Maintaining a second buffer here
        // would double up on the first connection.
        sessions.set(session.id, session)
        wireSession(session)
        scheduleSave()
        session.start()
        /**
         * 新建会话即成为“当前会话”。
         *
         * 这是桌面端点“新建”时的自然语义，也让随后打开的手机知道该跟到哪；必须放在
         * `sendJson` 之前，保证 201 返回时其它客户端的 `/api/state` 已经能读到它。
         */
        rememberActiveSession(session.id)
        sendJson(res, 201, session.toJSON())
        return
      }

      // ---- one session --------------------------------------------------------
      const sessionMatch = url.pathname.match(/^\/api\/sessions\/([0-9a-fA-F-]{36})(\/[a-z_-]+)?$/)
      if (sessionMatch) {
        const session = sessions.get(sessionMatch[1])
        if (!session) {
          sendJson(res, 404, { error: 'session not found' })
          return
        }
        const action = sessionMatch[2]

        /**
         * 任何按会话 id 的“活”请求都算一次选择：打开事件流、发消息、改模型、看快照……
         * 桌面端一路点过来时，手机端靠这一次次触达跟上，不需要每处前端调用都记得显式上报。
         * DELETE 例外：它可能马上删除会话，交给下面 purge 分支处理置空。
         */
        if (req.method !== 'DELETE') rememberActiveSession(session.id)

        if (!action && req.method === 'GET') {
          sendJson(res, 200, session.toJSON())
          return
        }

        if (action === '/events' && req.method === 'GET') {
          res.writeHead(200, {
            'Content-Type': 'text/event-stream; charset=utf-8',
            'Cache-Control': 'no-cache, no-transform',
            Connection: 'keep-alive',
            'X-Accel-Buffering': 'no',
          })
          res.write(': connected\n\n')

          // Resume where the client left off. A reconnecting EventSource sends Last-Event-ID
          // automatically; a fresh client gets the whole timeline.
          const lastEventId = Number(req.headers['last-event-id'] ?? url.searchParams.get('since') ?? 0)
          const write = (event) => {
            // `id:` lets the browser track the cursor for us across reconnects.
            if (event.seq !== undefined) res.write(`id: ${event.seq}\n`)
            res.write(`data: ${JSON.stringify(event)}\n\n`)
          }

          for (const event of session.eventsSince(lastEventId)) write(event)

          const onEvent = (event) => write(event)
          const onLog = (log) => write({ sessionId: session.id, kind: 'log', ...log, at: Date.now() })
          const onExit = (info) =>
            write({ sessionId: session.id, kind: 'closed', ...info, at: Date.now() })

          session.on('event', onEvent)
          session.on('log', onLog)
          session.on('exit', onExit)

          const ping = setInterval(() => res.write(': ping\n\n'), 15000)

          req.on('close', () => {
            clearInterval(ping)
            session.off('event', onEvent)
            session.off('log', onLog)
            session.off('exit', onExit)
          })
          return
        }

        if (action === '/messages' && req.method === 'POST') {
          const body = await readJsonBody(req)
          const text = typeof body.text === 'string' ? body.text : ''
          if (!text.trim()) {
            sendJson(res, 400, { error: 'text is required' })
            return
          }
          if (session.turnActive) {
            // 409 lets the UI say "still running" instead of pretending the send worked.
            sendJson(res, 409, { accepted: false, error: 'a turn is already running' })
            return
          }

          // A session restored from disk has no child yet: launch it on the first turn, so reopening
          // the app and continuing a conversation just works — and only then, so merely viewing a
          // restored session never starts a process.
          if (!session.child) await startRestoredSession(session)

          const preflight = await runPreflight({
            text,
            cwd: session.options.cwd,
            confirmed: body.confirm === true,
          })
          if (preflight.needsConfirm) {
            // 409 with a body the page can act on: this is a decision for the user, not a failure.
            sendJson(res, 409, {
              accepted: false,
              needsConfirm: true,
              blockers: preflight.blockers,
              error: preflight.error,
            })
            return
          }

          const accepted = session.send(preflight.text)
          sendJson(res, accepted ? 202 : 409, {
            accepted,
            // What the local checks decided, so the page can show it: a label the user should read,
            // and the exact text that was appended (silently rewriting a prompt is not acceptable).
            rules: preflight.rules,
            appended: preflight.appended || null,
            error: accepted ? undefined : 'session is not accepting input',
          })
          return
        }

        if (action === '/model' && req.method === 'POST') {
          const body = await readJsonBody(req)
          const model = typeof body.model === 'string' ? body.model : ''
          const baseUrl = typeof body.baseUrl === 'string' ? body.baseUrl : ''
          const apiKey = typeof body.apiKey === 'string' ? body.apiKey : undefined
          // Absent means "leave the effort alone"; a string pins it, an empty one clears it.
          const effort = typeof body.effort === 'string' ? body.effort : undefined

          // A DIFFERENT ENDPOINT CANNOT BE REACHED BY A CONTROL REQUEST: base URL and key are
          // environment variables of the child process, so crossing providers means a new
          // process. That restart resumes the conversation via --resume, so context survives.
          const crossesEndpoint = Boolean(baseUrl) && baseUrl !== session.options.baseUrl
          /**
           * Effort needs a fresh process for the same class of reason — it is a `--effort`
           * argument, and the CLI has no control request for it. Only restart when the level
           * actually DIFFERS: relaunching on every model switch would be a visible stall for
           * users who never set an effort at all.
           */
          const changesEffort = effort !== undefined && (effort || undefined) !== (session.options.effort || undefined)
          if (crossesEndpoint || changesEffort) {
            const resumed = session.restartWith({ baseUrl, authToken: apiKey, model, effort })
            sendJson(res, resumed ? 202 : 409, {
              ok: resumed,
              mode: 'restarted',
              model: model || null,
              baseUrl,
              error: resumed ? undefined : 'a turn is running; wait for it to finish',
            })
            return
          }

          const ok = session.setModel(model)
          sendJson(res, ok ? 200 : 409, { ok, mode: 'in-session', model: model || null })
          return
        }

        if (action === '/permission-mode' && req.method === 'POST') {
          const body = await readJsonBody(req)
          const mode = typeof body.mode === 'string' ? body.mode : ''
          const VALID = ['default', 'acceptEdits', 'bypassPermissions', 'plan', 'dontAsk', 'auto', 'manual']
          if (!VALID.includes(mode)) {
            sendJson(res, 400, { error: `mode must be one of ${VALID.join(', ')}` })
            return
          }
          const ok = session.setPermissionMode(mode)
          if (ok) session.options.permissionMode = mode
          sendJson(res, ok ? 200 : 409, { ok, mode })
          return
        }

        if (action === '/cost' && req.method === 'GET') {
          sendJson(res, 200, {
            cost: session.cost(),
            // Which model the session ran, so the UI can explain an unpriced result rather than
            // showing a bare zero.
            model: session.options.model ?? session.resolvedModel ?? session.initialModel ?? null,
            currency: 'CNY',
          })
          return
        }

        if (action === '/catalog' && req.method === 'GET') {
          sendJson(res, 200, session.catalog())
          return
        }

        if (action === '/dialogs' && req.method === 'GET') {
          sendJson(res, 200, { pending: session.listPendingDialogs() })
          return
        }

        if (action === '/dialogs' && req.method === 'POST') {
          const body = await readJsonBody(req)
          const requestId = typeof body.requestId === 'string' ? body.requestId : ''
          if (!requestId) {
            sendJson(res, 400, { error: 'requestId is required' })
            return
          }
          const ok = session.respondDialog(requestId, {
            behavior: body.behavior === 'completed' ? 'completed' : 'cancelled',
            result: body.result,
          })
          if (!ok) {
            sendJson(res, 409, { error: 'no such pending dialog', requestId })
            return
          }
          sendJson(res, 200, { ok: true, requestId })
          return
        }

        if (action === '/permissions' && req.method === 'GET') {
          sendJson(res, 200, { pending: session.listPendingPermissions() })
          return
        }

        if (action === '/permissions' && req.method === 'POST') {
          const body = await readJsonBody(req)
          const requestId = typeof body.requestId === 'string' ? body.requestId : ''
          if (!requestId) {
            sendJson(res, 400, { error: 'requestId is required' })
            return
          }
          const ok = session.respondPermission(requestId, {
            behavior: body.behavior === 'allow' ? 'allow' : 'deny',
            scope: body.scope === 'session' ? 'session' : 'once',
            message: body.message,
            interrupt: body.interrupt === true,
          })
          if (!ok) {
            // Already answered, expired, or never existed — the UI is out of date.
            sendJson(res, 409, { error: 'no such pending permission', requestId })
            return
          }
          sendJson(res, 200, { ok: true, requestId })
          return
        }

        if (req.method === 'DELETE') {
          // `purge=1` removes the session instead of only stopping it. Stopping keeps the entry
          // in the list (it is still a thing the user can look at); purging is what the sidebar's
          // delete affordance needs, because a workspace disappears with its last session.
          const purge = url.searchParams.get('purge') === '1'
          if (purge) {
            session.kill()
            sessions.delete(session.id)
            // 删掉的正好是共享的当前会话时清空指针，否则另一端会一直指着一个已不存在的 id。
            if (activeSessionId === session.id) {
              activeSessionId = null
              broadcastState()
            }
            // Persist the removal right away, not on the next debounce: a purged session must not
            // come back when the app is reopened.
            flushSessions()
            sendJson(res, 200, { removed: true, id: session.id })
            return
          }
          session.stop()
          sendJson(res, 200, { stopped: true })
          return
        }
      }

      /**
       * ---- the built UI -------------------------------------------------------
       * A phone has no Tauri shell, so the bridge itself serves the page. This sits AFTER every API
       * route so a real endpoint is never shadowed by a static file, and BEFORE the 404 so a
       * client-side route (which is not a file) still returns the app instead of "not found".
       */
      if (req.method === 'GET' && webRoot && !url.pathname.startsWith('/api/')) {
        if (serveWebFile(res, webRoot, url.pathname)) return
        if (serveWebFile(res, webRoot, '/index.html')) return
      }

      sendJson(res, 404, { error: 'not found', path: url.pathname })
    } catch (error) {
      sendJson(res, 500, { error: String(error?.message ?? error) })
    }
  })

  /**
   * Attach the bridge-level listeners every session needs, whether it was just created or restored
   * from disk. Extracted so the two paths cannot drift: a fix to protection or notifications lands
   * on restored sessions too, instead of only on freshly created ones.
   */
  function wireSession(session) {
    // A finished CLI keeps its session for the transcript; `status` alone records that it closed.
    session.on('exit', () => {})

    // Mirror the session's own log lines into the shell ring, so the menu bar's log window shows the
    // whole story even when its per-session SSE channel is not open.
    session.on('log', (line) =>
      logRing.append(String(line?.level ?? 'info'), String(line?.text ?? line?.message ?? line ?? ''), 'session'),
    )

    session.on('event', (event) => {
      if (!event || event.transient === true || event.kind === 'log' || event.kind === 'closed') return

      // Remember the conversation so a restart can bring it back.
      scheduleSave()

      /**
       * Let 安全防护 look at what the session is carrying.
       *
       * OBSERVE, NEVER REWRITE: a hit is recorded and counted, and the event still reaches the UI
       * byte for byte. Silently editing a tool result to hide a secret would break the transcript
       * the user is reading, and would make the app's output differ from what the model saw — a
       * far worse bug than the leak it would be hiding.
       */
      void withFeature('defend', async (mod) => {
        let text = ''
        try {
          text = JSON.stringify(event)
        } catch {
          return null
        }
        // Size guard: one 2 MB tool result must not turn every event into a stringify + scan.
        if (!text || text.length > 262144) return null
        return await mod.guard({ text, where: `session:${event.kind ?? 'event'}`, action: 'observe' })
      }).catch(() => {
        // A protection layer that can break the transcript is worse than no protection layer.
      })

      /**
       * 微信通知：一轮对话结束时推一条。
       *
       * 挂在 `result` 事件上而不是 `exit`：`exit` 只在进程结束时发生，而用户真正关心的是"这一轮
       * 跑完了"，那可能发生很多次。推送是 best-effort，吞掉一切异常——通知失败绝不能变成会话故障。
       */
      if (event.kind === 'result' && wechat.status().enabled && wechat.status().notifyOnFinish) {
        const cwd = session.options.cwd ?? ''
        void wechat
          .notify({
            title: event.isError ? '会话出错（ChinaClaude-Mobot）' : '会话已完成（ChinaClaude-Mobot）',
            lines: [
              `目录：${cwd}`,
              event.isError ? '结果：本轮以错误结束' : '结果：本轮已正常完成',
              event.durationMs ? `耗时：${Math.round(event.durationMs / 1000)} 秒` : '',
            ],
          })
          .catch(() => {})
      }
    })
  }

  /**
   * Launch the child for a session restored from disk, filling in what a snapshot does not carry.
   *
   * Credentials are re-resolved HERE from the shared model list, because the snapshot stores none:
   * the endpoint's key is looked up on the bridge and never written to disk or handed to the client.
   */
  async function startRestoredSession(session) {
    const baseUrl = session.options.baseUrl || defaults.baseUrl
    session.options.binary = session.options.binary || options.binary
    session.options.cwd = session.options.cwd || process.cwd()
    if (!session.options.apiKey) session.options.apiKey = keyForBaseUrl(baseUrl) || undefined
    if (!session.options.authToken) session.options.authToken = defaults.authToken || undefined
    if (!session.options.proxy) session.options.proxy = defaults.proxy || undefined
    session.options.skillsRoot = options.skillsRoot
    // Restored sessions pin their MCP workspace too: the snapshot's cwd is the project the user had
    // open, and that is the tree a tool call must stay inside.
    session.options.mcpConfig = sessionMcpConfig(session.options.cwd) ?? undefined
    // Resume the same conversation; a snapshot without an id simply starts a fresh one.
    session.options.resumeSessionId = session.claudeSessionId ?? undefined
    try {
      session.options.systemPromptAppend = await memoryAppendix(session.options.cwd)
    } catch {
      /* memory is an enhancement, never a precondition */
    }
    session.start()
  }

  /**
   * Bring back the previous run's sessions.
   *
   * Done LAST, after every collaborator these sessions need (`logRing`, `withFeature`, `wechat`) has
   * been created, so `wireSession` can attach to them immediately.
   */
  for (const snapshot of readSessions()) {
    const restored = ClaudeSession.fromSnapshot(snapshot, {
      binary: options.binary,
      proxy: defaults.proxy || undefined,
      skillsRoot: options.skillsRoot,
    })
    wireSession(restored)
    sessions.set(restored.id, restored)
  }

  server.on('close', () => {
    for (const session of sessions.values()) session.stop()
    // Final flush: the last turn must survive an app quit that happens right after it.
    flushSessions()
  })

  return { server, sessions, defaults }
}
