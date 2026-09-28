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
import { bundledInventory, NOT_BUNDLED } from './bundled.mjs'
import { scanDirectory, groupFindings, scannerStatus } from './vet.mjs'
import { ENGINE_VERSION } from './vet-engine-version.mjs'
import { listTranscripts, groupTranscripts, transcriptToMarkdown } from './transcripts.mjs'
import { fetchBalance } from './balance.mjs'
import { testConnection } from './connect-test.mjs'
import { saveAttachments, attachmentsUsage, clearAttachments } from './attachments.mjs'

const MAX_BODY_BYTES = 1024 * 1024

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

    try {
      // ---- health -------------------------------------------------------------
      if (req.method === 'GET' && url.pathname === '/api/health') {
        sendJson(res, 200, {
          ok: true,
          version: 1,
          binary: options.binary,
          baseUrl: defaults.baseUrl,
          hasCredential: Boolean(defaults.authToken),
          sessions: sessions.size,
        })
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
        const apiKey = body.apiKey !== undefined && body.apiKey !== null ? String(body.apiKey) : (defaults.authToken ?? '')
        const result = await fetchBalance({
          baseUrl: typeof body.baseUrl === 'string' && body.baseUrl ? body.baseUrl : defaults.baseUrl,
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
        })

        // No separate pre-attach buffer is kept: ClaudeSession already appends every event
        // to `history`, and the SSE handler replays it. Maintaining a second buffer here
        // would double up on the first connection.
        sessions.set(session.id, session)
        session.on('exit', () => {
          // Keep the session object for history; mark it closed via status.
        })

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
          const accepted = session.send(text)
          sendJson(res, accepted ? 202 : 409, {
            accepted,
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
            sendJson(res, 200, { removed: true, id: session.id })
            return
          }
          session.stop()
          sendJson(res, 200, { stopped: true })
          return
        }
      }

      sendJson(res, 404, { error: 'not found', path: url.pathname })
    } catch (error) {
      sendJson(res, 500, { error: String(error?.message ?? error) })
    }
  })

  server.on('close', () => {
    for (const session of sessions.values()) session.stop()
  })

  return { server, sessions, defaults }
}
