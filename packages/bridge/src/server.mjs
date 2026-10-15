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
import { AUTHOR, SHOP_PRODUCTS, createLogRing, createFeedbackInbox, revealLogFile } from './shell.mjs'
import { scanDirectory, groupFindings, scannerStatus } from './vet.mjs'
import { ENGINE_VERSION } from './vet-engine-version.mjs'
import { listTranscripts, groupTranscripts, transcriptToMarkdown } from './transcripts.mjs'
import { fetchBalance } from './balance.mjs'
import { testConnection } from './connect-test.mjs'
import { saveAttachments, attachmentsUsage, clearAttachments } from './attachments.mjs'
import { checkForUpdate, createUpdateInstaller, publicCheckResult, DEFAULT_SOURCES } from './update.mjs'
import { createRemoteAccess, SESSION_COOKIE } from './remote.mjs'
import { publicModels, writeModels, keyForBaseUrl } from './models.mjs'
import { readSessions, writeSessions } from './session-store.mjs'
import { createWechatNotifier } from './wechat.mjs'
import { ORIGIN_SCRIPT, ORIGIN_SCRIPT_PATH, pairPage, parseForm, readFormBody, serveWebFile } from './webhost.mjs'

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

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? '127.0.0.1'}`)

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
      if (url.pathname === '/api/models') {
        if (req.method === 'GET') {
          sendJson(res, 200, { ...publicModels(), loopback: gate.loopback })
          return
        }
        if (req.method === 'POST') {
          if (!gate.loopback) {
            sendJson(res, 403, { error: '只有电脑端可以修改模型配置' })
            return
          }
          const body = await readJsonBody(req)
          writeModels(body.providers)
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
            return await mod.gitStatus({ cwd })
          }
          const body = await readJsonBody(req)
          if (body.action === 'diff') return await mod.gitDiff({ cwd: body.cwd, file: body.file, staged: body.staged })
          if (body.action === 'commit') return await mod.gitCommit({ cwd: body.cwd, message: body.message, files: body.files })
          if (body.action === 'available') return await mod.gitAvailable()
          return { ok: false, error: `未知操作：${String(body.action)}` }
        })
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

      // ---- list sessions ------------------------------------------------------
      if (req.method === 'GET' && url.pathname === '/api/sessions') {
        sendJson(res, 200, { sessions: [...sessions.values()].map((s) => s.toJSON()) })
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
