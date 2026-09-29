/**
 * One Claude Code session: owns a persistent `claude.exe` child, speaks the CLI's
 * stream-json protocol on stdin/stdout, and fans normalized events out to consumers.
 *
 * Protocol facts established by direct capture (see _probe/stream-events.jsonl):
 *   - the CLI emits NDJSON on stdout: {type:"system",subtype:"init"|"thinking_tokens"},
 *     {type:"assistant"}, {type:"result"}, ...
 *   - `--output-format=stream-json` requires `--print` AND `--verbose`
 *   - with `--input-format=stream-json` the process stays alive between turns, so one
 *     session == one long-lived child
 *   - the `system/init` event carries session_id, model, tools, slash_commands
 *   - the CLI probes `HEAD /api/hello` on the configured base URL at startup
 */
import { spawn } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { appendFileSync, existsSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { priceEvents } from './pricing.mjs'

/** Default credential surface: the DeepSeek Anthropic-compatible endpoint. */
export const DEFAULT_BASE_URL = 'https://api.deepseek.com/anthropic'

/**
 * Dialog kinds this client declares it can render.
 *
 * The CLI only emits a `request_user_dialog` whose kind appears in `supportedDialogKinds`, and
 * absence fails closed (the feature degrades to its no-dialog path) rather than parking a
 * dialog nothing can answer. So this list must contain ONLY kinds the UI genuinely handles —
 * declaring one we cannot answer would be worse than not declaring it.
 *
 * The UI renders every kind generically (choosing from payload-provided options), so the list
 * is deliberately short and safe rather than exhaustive.
 */
export const SUPPORTED_DIALOG_KINDS = [
  // Emitted when a model refusal could be retried on a fallback model. Very reachable on a
  // relay backend; without it the user just sees the refusal error.
  'refusal_fallback_prompt',
]

/** Capabilities sent in the `initialize` handshake. */
export const DEFAULT_CAPABILITIES = {
  supportedDialogKinds: SUPPORTED_DIALOG_KINDS,
  // Needed for subagent text to reach the stream at all — the CLI withholds it otherwise.
  forwardSubagentText: true,
  // Periodic progress lines for running agents.
  agentProgressSummaries: true,
}

/**
 * Environment for the child. Kept as a pure function so tests can assert it.
 * Every non-essential traffic switch is set because the desktop client must not
 * phone home to endpoints that are unreachable from the target network anyway.
 */
export function buildChildEnv(config, baseEnv = process.env) {
  const env = {
    ...baseEnv,
    ANTHROPIC_BASE_URL: config.baseUrl || DEFAULT_BASE_URL,
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    DISABLE_AUTOUPDATER: '1',
    DISABLE_TELEMETRY: '1',
    DISABLE_ERROR_REPORTING: '1',
    DISABLE_BUG_COMMAND: '1',
    // The bridge is the SDK host: no interactive prompts, no terminal assumptions.
    CI: '1',
  }

  if (config.authToken) {
    // A relay key travels as a bearer token; ANTHROPIC_API_KEY is deliberately left
    // unset so the CLI never tries OAuth or the OS keychain.
    env.ANTHROPIC_AUTH_TOKEN = config.authToken
    env.ANTHROPIC_API_KEY = ''
  } else if (config.apiKey) {
    env.ANTHROPIC_API_KEY = config.apiKey
    env.ANTHROPIC_AUTH_TOKEN = ''
  }

  if (config.proxy) env.HTTPS_PROXY = config.proxy
  if (config.extraCaCert) env.NODE_EXTRA_CA_CERTS = config.extraCaCert

  return env
}

/** Argument vector for a session child. */
export function buildChildArgs(config) {
  const args = ['--print', '--verbose', '--output-format', 'stream-json', '--input-format', 'stream-json']

  // This is what makes the CLI ask THIS process before running a tool. Without it the CLI
  // auto-denies anything that would prompt and the approval UI can never appear — verified
  // empirically: with only `--permission-prompts host` (the default) no control_request is
  // ever sent; adding `--permission-prompt-tool stdio` produces one immediately.
  args.push('--permission-prompt-tool', 'stdio')

  /**
   * Make `bypassPermissions` selectable without starting in it.
   *
   * The CLI refuses to enter bypass mode unless the session was launched with a skip-permissions
   * flag ("Cannot set permission mode to bypassPermissions because the session was not launched
   * with --dangerously-skip-permissions"). `--allow-dangerously-skip-permissions` differs from
   * `--dangerously-skip-permissions` in exactly the way the permission presets need: it ENABLES
   * the option but does not activate it, so a session still starts in the configured mode and
   * only escalates when the user picks "完全权限".
   */
  args.push('--allow-dangerously-skip-permissions')

  if (config.model) args.push('--model', config.model)
  if (config.permissionMode) args.push('--permission-mode', config.permissionMode)
  if (config.cwd) args.push('--add-dir', config.cwd)

  /**
   * Reasoning effort, when the user pinned a level to this model.
   *
   * SPAWN-TIME ONLY, which is why it is an argument rather than a control request: the binary
   * exposes `--effort <level>` and a `/effort` command, but no `set_effort` control subtype, and
   * says outright that "the transport can't change server effort". Changing it therefore requires
   * relaunching the child — see `restartWith`, which resumes the same conversation.
   *
   * Omitted entirely when unset, so a session that never opts in sends exactly the arguments it
   * always did. The CLI validates the value itself and falls back to the model default with a
   * warning for anything it does not know, so a stale level cannot break a session.
   */
  if (config.effort) args.push('--effort', config.effort)

  /**
   * Bundled skills root.
   *
   * Skills are discovered at `<root>/.claude/skills/<name>/SKILL.md` where `<root>` is the cwd or
   * any `--add-dir` root — verified by probe: pointing `--add-dir` straight at a skills directory
   * does NOT work, the `.claude/skills` level is required. Adding the bundle's own root here is
   * what makes shipped skills available to every session without writing into the user's project.
   */
  if (config.skillsRoot) args.push('--add-dir', config.skillsRoot)

  if (config.resumeSessionId) args.push('--resume', config.resumeSessionId)
  if (config.systemPromptAppend) args.push('--append-system-prompt', config.systemPromptAppend)
  return args
}

/** Normalize one raw CLI line into a UI-facing event, or null when not surfaced. */
export function normalizeEvent(raw, sessionId) {
  const base = { sessionId, at: Date.now() }

  switch (raw?.type) {
    case 'system':
      if (raw.subtype === 'init') {
        return {
          ...base,
          kind: 'init',
          claudeSessionId: raw.session_id,
          model: raw.model,
          tools: raw.tools ?? [],
          skills: raw.skills ?? [],
          slashCommands: raw.slash_commands ?? [],
          /**
           * Loaded plugins and MCP servers.
           *
           * The raw init frame carries both (`plugins`, `mcp_servers`) and they are the ONLY
           * report of what is actually loaded — dropping them here left the UI unable to show an
           * inventory at all.
           */
          plugins: Array.isArray(raw.plugins)
            ? raw.plugins.map((plugin) => ({
                name: plugin?.name ?? '',
                path: plugin?.path ?? null,
                source: plugin?.source ?? null,
              }))
            : [],
          mcpServers: Array.isArray(raw.mcp_servers) ? raw.mcp_servers : [],
          agents: raw.agents ?? [],
          permissionMode: raw.permissionMode,
          capabilities: raw.capabilities ?? [],
          claudeCodeVersion: raw.claude_code_version,
          cwd: raw.cwd,
        }
      }
      if (raw.subtype === 'thinking_tokens') {
        return { ...base, kind: 'thinking_tokens', estimated: raw.estimated_tokens }
      }
      // A tool call auto-denied without ever prompting (deny rule, dontAsk mode, ...).
      if (raw.subtype === 'permission_denied') {
        return {
          ...base,
          kind: 'permission_denied',
          name: raw.tool_name,
          message: raw.message,
          toolUseId: raw.tool_use_id,
        }
      }
      return null

    case 'assistant': {
      // One event per completed content block; the UI wants block-level granularity.
      const blocks = Array.isArray(raw.message?.content) ? raw.message.content : []
      const block = blocks[0]
      if (!block) return null
      // Non-null when the message was produced INSIDE a subagent started by that tool_use.
      // This is the only lineage signal the stream carries, so it is preserved on every
      // assistant-shaped event rather than only on the blocks the UI nests today.
      const parentToolUseId = raw.parent_tool_use_id ?? null
      if (block.type === 'text') return { ...base, kind: 'text', text: block.text ?? '', parentToolUseId }
      if (block.type === 'thinking') return { ...base, kind: 'thinking', text: block.thinking ?? '', parentToolUseId }
      if (block.type === 'tool_use') {
        return { ...base, kind: 'tool_use', id: block.id, name: block.name, input: block.input, parentToolUseId }
      }
      return { ...base, kind: 'assistant_other', blockType: block.type, parentToolUseId }
    }

    case 'user': {
      // Tool results come back as user-role content.
      const blocks = Array.isArray(raw.message?.content) ? raw.message.content : []
      const block = blocks[0]
      if (block?.type === 'tool_result') {
        return {
          ...base,
          kind: 'tool_result',
          toolUseId: block.tool_use_id,
          isError: block.is_error === true,
          content: typeof block.content === 'string' ? block.content : JSON.stringify(block.content ?? ''),
          parentToolUseId: raw.parent_tool_use_id ?? null,
        }
      }
      return null
    }

    case 'result':
      return {
        ...base,
        kind: 'result',
        subtype: raw.subtype,
        isError: raw.is_error === true,
        durationMs: raw.duration_api_ms,
        stopReason: raw.stop_reason,
        // total_cost_usd is computed from Anthropic's price catalog, so it is wrong for a
        // relay backend. Keep it as a hint, but the UI bills from `usage` and its own table.
        reportedCostUsd: raw.total_cost_usd,
        usage: {
          inputTokens: raw.usage?.input_tokens ?? 0,
          outputTokens: raw.usage?.output_tokens ?? 0,
          cacheReadTokens: raw.usage?.cache_read_input_tokens ?? 0,
          cacheCreationTokens: raw.usage?.cache_creation_input_tokens ?? 0,
        },
      }

    default:
      return null
  }
}

export class ClaudeSession extends EventEmitter {
  /**
   * @param {object} options
   * @param {string} options.binary        absolute path to claude.exe
   * @param {string} [options.cwd]         working directory for the agent
   * @param {string} [options.baseUrl]     Anthropic-compatible base URL
   * @param {string} [options.authToken]   bearer token for the relay
   * @param {string} [options.model]
   * @param {string} [options.permissionMode]
   * @param {string} [options.resumeSessionId]
   */
  constructor(options) {
    super()
    this.id = options.id ?? randomUUID()
    this.options = options
    this.claudeSessionId = null
    this.status = 'starting'
    this.history = []
    this.stderrTail = []
    this.child = null
    this.stdoutBuffer = ''
    this.turnActive = false
    /** When the session was created, so the sidebar can tell two sessions in one workspace apart. */
    this.createdAt = Date.now()
    /** Set once the session is being torn down, so late child events are ignored. */
    this.stopping = false
    /**
     * In-flight permission asks, keyed by the control_request's request_id.
     *
     * The CLI blocks the tool call until one of these is answered, so they are held here
     * rather than only being emitted: a client that reconnects must be able to see and answer
     * a prompt that is still pending.
     */
    this.pendingPermissions = new Map()
    /** In-flight `request_user_dialog` asks, keyed by request_id. */
    this.pendingDialogs = new Map()
    /** request_id of the last `initialize` we sent, so its reply can be recognised. */
    this.initializeRequestId = null
    this.initializeResult = null
    /** Model named on the launch command line, if any. */
    this.initialModel = options.model ?? null
    /** Model the CLI reports it is actually running (from the `system/init` frame). */
    this.resolvedModel = null
    /** Monotonic event counter backing SSE resumption. */
    this.seq = 0
  }

  start() {
    if (!existsSync(this.options.binary)) {
      this.status = 'failed'
      const message = `claude.exe not found at ${this.options.binary}`
      this.#pushEvent({ sessionId: this.id, kind: 'error', message, at: Date.now() })
      this.emit('exit', { code: null, reason: message })
      return this
    }

    const args = buildChildArgs(this.options)
    const env = buildChildEnv(this.options)
    this.emit('log', { level: 'info', message: `spawn ${this.options.binary} ${args.join(' ')}` })

    this.child = spawn(this.options.binary, args, {
      cwd: this.options.cwd || undefined,
      env,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    })

    if (process.env.CCCN_DEBUG_FILE) {
      const note = `[session ${this.id}] spawn pid=${this.child.pid} args=${args.join(' ')}\n`
      appendFileSync(process.env.CCCN_DEBUG_FILE, note)
      this.child.on('spawn', () =>
        appendFileSync(process.env.CCCN_DEBUG_FILE, `[session ${this.id}] 'spawn' event fired\n`),
      )
      this.child.on('error', (error) =>
        appendFileSync(process.env.CCCN_DEBUG_FILE, `[session ${this.id}] child error: ${error?.message}\n`),
      )
      this.child.on('close', (code, signal) =>
        appendFileSync(process.env.CCCN_DEBUG_FILE, `[session ${this.id}] child close code=${code} signal=${signal}\n`),
      )
    }

    this.child.stdout.setEncoding('utf8')
    this.child.stdout.on('data', (chunk) => this.#onStdout(chunk))

    this.child.stderr.setEncoding('utf8')
    this.child.stderr.on('data', (chunk) => {
      const text = String(chunk)
      this.stderrTail.push(text)
      if (this.stderrTail.length > 40) this.stderrTail.shift()
      this.emit('log', { level: 'warn', message: text.trim() })
    })

    this.child.on('spawn', () => {
      /**
       * The CLI is lazy: it emits NOTHING on stdout — not even `system/init` — until the first
       * user turn is written to stdin. Verified by bisect: with stdin left quiet the process
       * stays completely silent for 45s+, and writing one user message produces `init` within
       * seconds (see test/bisect.mjs).
       *
       * So "ready" must mean "writable", not "initialized". Waiting for `init` before sending
       * the first turn deadlocks: no message -> no init -> never ready -> no message.
       */
      if (this.status === 'starting') this.status = 'ready'

      // Declare host capabilities immediately: the CLI gates several behaviours on them and
      // fails closed when nothing is declared, so the handshake has to precede the first turn.
      this.initialize(this.options.capabilities ?? DEFAULT_CAPABILITIES)
    })

    this.child.on('error', (error) => {
      this.status = 'failed'
      this.#pushEvent({ sessionId: this.id, kind: 'error', message: String(error?.message ?? error), at: Date.now() })
      this.emit('exit', { code: null, reason: String(error?.message ?? error) })
    })

    this.child.on('close', (code) => {
      // A session being removed reports 'closed'; one whose CLI exited on its own is 'closed'
      // too, but keeping the distinction here means a removal never looks like a crash.
      this.status = 'closed'
      this.emit('exit', { code, reason: null })
    })

    return this
  }

  #onStdout(chunk) {
    this.stdoutBuffer += chunk
    let index
    while ((index = this.stdoutBuffer.indexOf('\n')) >= 0) {
      const line = this.stdoutBuffer.slice(0, index).trim()
      this.stdoutBuffer = this.stdoutBuffer.slice(index + 1)
      if (!line) continue
      this.#handleLine(line)
    }
  }

  #handleLine(line) {
    let raw
    try {
      raw = JSON.parse(line)
    } catch {
      this.emit('log', { level: 'warn', message: `non-JSON stdout: ${line.slice(0, 200)}` })
      return
    }

    // The control channel shares stdout with the message stream. A can_use_tool request
    // blocks the CLI until answered, so it is surfaced as an event and parked.
    if (raw?.type === 'control_request' && raw.request?.subtype === 'can_use_tool') {
      this.#onPermissionRequest(raw)
      return
    }
    // The same channel carries blocking host dialogs (`request_user_dialog`).
    if (raw?.type === 'control_request' && raw.request?.subtype === 'request_user_dialog') {
      this.#onDialogRequest(raw)
      return
    }
    if (raw?.type === 'control_response') {
      // Only the reply to our own initialize is interesting; everything else is an echo of a
      // response we wrote and has already been rendered as an event.
      const response = raw.response
      if (response?.request_id && response.request_id === this.initializeRequestId) {
        this.initializeResult = response.subtype === 'success' ? (response.response ?? {}) : null
        if (response.subtype !== 'success') {
          this.emit('log', { level: 'warn', message: `initialize failed: ${response.error ?? 'unknown'}` })
        } else {
          // A joining client learns about asks that are already in flight from here, so
          // surface them rather than waiting for a replay that may never come.
          for (const pending of response.pending_permission_requests ?? []) {
            if (pending?.request?.subtype === 'can_use_tool' && !this.pendingPermissions.has(pending.request_id)) {
              this.#onPermissionRequest(pending)
            }
          }
          for (const pending of response.pending_user_dialog_requests ?? []) {
            if (pending?.request?.subtype === 'request_user_dialog' && !this.pendingDialogs.has(pending.request_id)) {
              this.#onDialogRequest(pending)
            }
          }
        }
        this.emit('initialized', this.initializeResult)
      }
      return
    }

    if (raw?.type === 'system' && raw.subtype === 'init') {
      this.claudeSessionId = raw.session_id ?? null
      /**
       * Do NOT force 'ready' here.
       *
       * `system/init` arrives DURING the first turn, so marking the session ready on that frame
       * would advertise "you can send now" while a turn is still running — the UI would then get
       * a 409 from a session it was just told was idle. The status is derived from the real
       * guards instead: a turn in flight owns the status, and `result` hands it back.
       */
      if (!this.turnActive) this.status = 'ready'
      // The init frame carries the model actually in use, which is the only way to name a model
      // when the session was launched without an explicit --model.
      if (typeof raw.model === 'string' && raw.model.length > 0) {
        this.resolvedModel = raw.model
        if (!this.initialModel) this.initialModel = raw.model
      }
    }
    if (raw?.type === 'result') {
      this.turnActive = false
      // Pending asks take priority over 'ready': the CLI is still parked on them, and claiming
      // otherwise would let the UI send into a turn that cannot proceed.
      if (this.pendingPermissions.size > 0) this.status = 'awaiting_approval'
      else if (this.pendingDialogs.size > 0) this.status = 'awaiting_dialog'
      else this.status = 'ready'
      // Any ask still parked at the end of a turn can never be answered now.
      if (this.pendingPermissions.size > 0) {
        for (const [requestId, pending] of this.pendingPermissions) {
          this.#pushEvent({
            sessionId: this.id,
            kind: 'permission_settled',
            requestId,
            toolUseId: pending.toolUseId,
            decision: 'expired',
            at: Date.now(),
          })
        }
        this.pendingPermissions.clear()
      }
      // Same for host dialogs: the CLI cancels them at its own deadline, but a dialog that
      // outlives its turn is already unanswerable.
      if (this.pendingDialogs.size > 0) {
        for (const [requestId, pending] of this.pendingDialogs) {
          this.#pushEvent({
            sessionId: this.id,
            kind: 'dialog_settled',
            requestId,
            dialogKind: pending.dialogKind,
            behavior: 'expired',
            at: Date.now(),
          })
        }
        this.pendingDialogs.clear()
      }
    }

    const event = normalizeEvent(raw, this.id)
    if (event) {
      this.#pushEvent(event)
    }
    this.emit('raw', raw)
  }

  /**
   * Append one UI event and announce it.
   *
   * Every event carries a monotonically increasing `seq`. That is what makes the SSE stream
   * resumable: a reconnecting client sends `Last-Event-ID` and receives only what it missed,
   * instead of the whole timeline again (which would duplicate everything it already had).
   */
  #pushEvent(event) {
    this.seq += 1
    // Stamp WHICH MODEL RAN THIS TURN while that fact is still true. `setModel` and a
    // cross-provider restart both mutate `options.model`, so a bill computed later would reprice
    // every earlier turn at the newest model's rate. The event is the only place that can carry
    // the answer forward.
    const stamped =
      event.kind === 'result' && event.model === undefined ? { ...event, model: this.#billingModel() } : event
    const sequenced = { ...stamped, seq: this.seq }
    this.history.push(sequenced)
    if (this.history.length > 4000) this.history.splice(0, 1000)
    this.emit('event', sequenced)
    return sequenced
  }

  /** The model a turn started right now would run on. */
  #billingModel() {
    return this.options.model ?? this.resolvedModel ?? this.initialModel ?? null
  }

  /** Events after `sinceSeq`, for stream resumption. */
  eventsSince(sinceSeq) {
    if (!Number.isFinite(sinceSeq) || sinceSeq <= 0) return this.history.slice()
    return this.history.filter((event) => (event.seq ?? 0) > sinceSeq)
  }

  /** Park a permission ask and tell consumers about it. */
  #onPermissionRequest(raw) {
    const request = raw.request ?? {}
    const pending = {
      requestId: raw.request_id,
      toolName: request.tool_name ?? 'unknown',
      displayName: request.display_name ?? request.tool_name ?? 'unknown',
      input: request.input ?? {},
      description: request.description ?? '',
      toolUseId: request.tool_use_id ?? '',
      suggestions: request.permission_suggestions ?? [],
      decisionReason: request.decision_reason,
      decisionReasonType: request.decision_reason_type,
      // Honour the CLI's own guardrails rather than inventing our own.
      defaultToNo: request.default_to_no === true,
      suppressAlwaysAllowRule: request.suppress_always_allow_rule === true,
      requiresUserInteraction: request.requires_user_interaction === true,
      blockedPath: request.blocked_path,
      at: Date.now(),
    }

    this.pendingPermissions.set(pending.requestId, pending)
    this.status = 'awaiting_approval'

    this.#pushEvent({
      sessionId: this.id,
      kind: 'permission_request',
      requestId: pending.requestId,
      name: pending.toolName,
      displayName: pending.displayName,
      input: pending.input,
      description: pending.description,
      toolUseId: pending.toolUseId,
      suggestions: pending.suggestions,
      decisionReason: pending.decisionReason,
      decisionReasonType: pending.decisionReasonType,
      defaultToNo: pending.defaultToNo,
      suppressAlwaysAllowRule: pending.suppressAlwaysAllowRule,
      blockedPath: pending.blockedPath,
      at: pending.at,
    })
  }

  /**
   * Answer a parked permission ask.
   *
   * @param {string} requestId
   * @param {{behavior:'allow'|'deny', message?:string, scope?:'once'|'session', interrupt?:boolean}} decision
   * @returns {boolean} false when the request is unknown or already answered
   */
  respondPermission(requestId, decision) {
    const pending = this.pendingPermissions.get(requestId)
    if (!pending) return false
    this.pendingPermissions.delete(requestId)

    const behavior = decision?.behavior === 'allow' ? 'allow' : 'deny'
    let result

    if (behavior === 'allow') {
      result = { behavior: 'allow', toolUseID: pending.toolUseId }
      // `scope: 'session'` turns the one-off approval into a session-wide rule for this
      // tool. The CLI supplies the exact rule shape in permission_suggestions, so the
      // client never has to invent one.
      if (decision?.scope === 'session') {
        const updates = pending.suggestions.filter((s) => s?.type === 'addRules' || s?.type === 'setMode')
        if (updates.length > 0) result.updatedPermissions = updates
      }
      if (decision?.updatedInput && typeof decision.updatedInput === 'object') {
        result.updatedInput = decision.updatedInput
      }
    } else {
      result = {
        behavior: 'deny',
        message: typeof decision?.message === 'string' && decision.message ? decision.message : '用户拒绝了此操作',
        interrupt: decision?.interrupt === true,
        toolUseID: pending.toolUseId,
      }
    }

    const accepted = this.#writeControlResponse(requestId, result)
    if (accepted) {
      this.status = this.pendingPermissions.size > 0 ? 'awaiting_approval' : 'busy'
      this.#pushEvent({
        sessionId: this.id,
        kind: 'permission_settled',
        requestId,
        toolUseId: pending.toolUseId,
        decision: behavior,
        scope: decision?.scope ?? 'once',
        at: Date.now(),
      })
    }
    return accepted
  }

  /**
   * Send the `initialize` control request.
   *
   * This is the host's capability handshake, and it is REQUIRED for anything the CLI gates on
   * a declared capability:
   *
   *   - `supportedDialogKinds` — the CLI emits a `request_user_dialog` kind ONLY if some
   *     attached client declared it. Absence fails closed: the flow behind the dialog degrades
   *     to its no-dialog behaviour. So without this handshake the dialog path is unreachable.
   *   - `forwardSubagentText` — without it the CLI withholds subagent text from the stream.
   *   - `agentProgressSummaries` — periodic progress lines for running agents.
   *
   * Safe to call more than once: the CLI re-registers and later calls replace the earlier set
   * for the process that owns stdin.
   *
   * @param {{supportedDialogKinds?: string[], forwardSubagentText?: boolean, agentProgressSummaries?: boolean}} capabilities
   */
  initialize(capabilities = {}) {
    if (!this.child || !this.child.stdin.writable) return false

    const request = { subtype: 'initialize' }
    // Only send keys we actually mean: every one of these is optional and the CLI defaults
    // each to its conservative behaviour when absent.
    if (Array.isArray(capabilities.supportedDialogKinds) && capabilities.supportedDialogKinds.length > 0) {
      request.supportedDialogKinds = capabilities.supportedDialogKinds
    }
    if (capabilities.forwardSubagentText) request.forwardSubagentText = true
    if (capabilities.agentProgressSummaries) request.agentProgressSummaries = true
    if (capabilities.systemPrompt !== undefined) request.systemPrompt = capabilities.systemPrompt
    if (capabilities.appendSystemPrompt !== undefined) request.appendSystemPrompt = capabilities.appendSystemPrompt

    const requestId = randomUUID()
    this.initializeRequestId = requestId
    this.child.stdin.write(JSON.stringify({ type: 'control_request', request_id: requestId, request }) + '\n')
    this.emit('log', { level: 'info', message: `initialize sent (dialogs: ${(capabilities.supportedDialogKinds ?? []).join(',') || 'none'})` })
    return true
  }

  /**
   * Restart the CLI child against a different endpoint or credential, resuming the conversation.
   *
   * WHY A RESTART IS UNAVOIDABLE HERE: a base URL and an API key are environment variables of
   * the child process, so no control request can change them. `set_model` only renames the model
   * within the endpoint the process was started against. Switching providers therefore means a
   * new process — and because Claude Code supports `--resume <session-id>`, the conversation can
   * be carried across rather than lost.
   *
   * The caller must have confirmed the session is idle; a busy turn would be cut off.
   *
   * @param {{baseUrl?: string, authToken?: string, model?: string, effort?: string|null}} next
   * @returns {boolean} false when the child is missing or a turn is in flight
   */
  restartWith(next = {}) {
    if (!this.child) return false
    if (this.turnActive) return false

    // Snapshot what the resume needs BEFORE the old child is torn down.
    const resumeSessionId = this.claudeSessionId
    const previousModel = this.initialModel

    try {
      this.child.removeAllListeners()
      this.child.kill()
    } catch {
      /* already gone */
    }
    this.child = null
    this.stdoutBuffer = ''

    // A new process starts from scratch: pending asks belong to the dead process and can never
    // be answered, and the handshake has to happen again.
    this.pendingPermissions.clear()
    this.pendingDialogs.clear()
    this.initializeResult = null
    this.initializeRequestId = null
    this.seq = 0
    this.history.length = 0

    /**
     * An EMPTY baseUrl means "leave it", not "clear it".
     *
     * The caller passes `''` whenever it is changing something else — an effort-only change sends no
     * endpoint at all — and `'' ?? x` is `''`, so the nullish default did NOT protect this. The
     * result was a session restarted with no endpoint, silently sending the next turn to Anthropic's
     * default instead of the provider the user configured. A falsy URL is never a valid target, so
     * only a real one is applied.
     */
    if (next.baseUrl) this.options.baseUrl = next.baseUrl
    // `undefined` means "leave the credential alone"; an explicit empty string clears it.
    if (next.authToken !== undefined) this.options.authToken = next.authToken
    this.options.model = next.model ?? this.options.model
    this.options.apiKey = next.apiKey ?? this.options.apiKey
    // `effort` is a spawn argument, so a change to it is one of the few things a restart exists
    // for beyond the endpoint: `undefined` means "leave it", an empty value clears it.
    if (next.effort !== undefined) this.options.effort = next.effort || undefined
    // Resume the same conversation. Only fall back to a fresh one when there is nothing to
    // resume, because a wrong id would start an empty session and look like context loss.
    this.options.resumeSessionId = resumeSessionId ?? undefined
    this.initialModel = next.model ?? previousModel ?? null
    this.resolvedModel = null
    this.status = 'starting'

    this.#pushEvent({
      sessionId: this.id,
      kind: 'notice',
      message: `已切换到 ${this.options.baseUrl}${next.model ? ` · ${next.model}` : ''}${
        resumeSessionId ? '，正在恢复会话上下文' : ''
      }`,
      at: Date.now(),
    })

    this.start()
    return true
  }

  /**
   * Change the model used for subsequent turns.
   *
   * Omitted, null or 'default' all mean "reset to the session default model", so that is what
   * an empty value sends rather than a made-up model id.
   *
   * Only valid WITHIN the current endpoint: the model name travels in a control request, but the
   * endpoint it is resolved against is fixed for the life of the process. Crossing providers
   * needs `restartWith`.
   */
  setModel(model) {
    if (!this.child || !this.child.stdin.writable) return false
    const next = typeof model === 'string' && model.length > 0 ? model : null
    const requestId = randomUUID()
    this.child.stdin.write(
      JSON.stringify({
        type: 'control_request',
        request_id: requestId,
        request: { subtype: 'set_model', model: next },
      }) + '\n',
    )
    // Tracked here because the initialize reply is a handshake snapshot and the CLI does not
    // re-send it after a model switch.
    this.options.model = next ?? undefined
    this.emit('log', { level: 'info', message: `model -> ${next ?? 'default'}` })
    return true
  }

  /**
   * Change the session's permission mode mid-conversation.
   *
   * Uses the control channel rather than a relaunch, so an escalation applies to the running
   * session without losing its context. The CLI rejects `bypassPermissions` unless the process
   * was launched with a skip-permissions flag, which `buildChildArgs` always provides as an
   * OPTION (see `--allow-dangerously-skip-permissions`).
   */
  setPermissionMode(mode) {
    if (!this.child || !this.child.stdin.writable) return false
    const requestId = randomUUID()
    this.child.stdin.write(
      JSON.stringify({
        type: 'control_request',
        request_id: requestId,
        request: { subtype: 'set_permission_mode', mode },
      }) + '\n',
    )
    this.emit('log', { level: 'info', message: `permission mode -> ${mode}` })
    return true
  }

  /** Answer a parked user-dialog ask. */  respondDialog(requestId, outcome) {
    const pending = this.pendingDialogs.get(requestId)
    if (!pending) return false
    this.pendingDialogs.delete(requestId)

    const payload =
      outcome?.behavior === 'completed'
        ? { behavior: 'completed', result: outcome.result }
        : { behavior: 'cancelled' }

    const accepted = this.#writeControlResponse(requestId, payload)
    if (accepted) {
      this.#pushEvent({
        sessionId: this.id,
        kind: 'dialog_settled',
        requestId,
        dialogKind: pending.dialogKind,
        behavior: payload.behavior,
        at: Date.now(),
      })
    }
    return accepted
  }

  /** Park a `request_user_dialog` ask and tell consumers about it. */
  #onDialogRequest(raw) {
    const request = raw.request ?? {}
    const pending = {
      requestId: raw.request_id,
      dialogKind: request.dialog_kind ?? 'unknown',
      payload: request.payload ?? {},
      toolUseId: request.tool_use_id ?? '',
      at: Date.now(),
    }
    this.pendingDialogs.set(pending.requestId, pending)
    this.status = 'awaiting_dialog'

    this.#pushEvent({
      sessionId: this.id,
      kind: 'dialog_request',
      requestId: pending.requestId,
      dialogKind: pending.dialogKind,
      payload: pending.payload,
      toolUseId: pending.toolUseId,
      at: pending.at,
    })
  }

  /** Write one control_response frame. Returns false when stdin is gone. */
  #writeControlResponse(requestId, payload) {
    if (!this.child || !this.child.stdin.writable) return false
    const frame = { type: 'control_response', response: { subtype: 'success', request_id: requestId, response: payload } }
    this.child.stdin.write(JSON.stringify(frame) + '\n')
    this.emit('log', { level: 'info', message: `permission ${requestId} -> ${payload.behavior}` })
    return true
  }

  /** Pending asks, for a client that attaches after they were raised. */
  listPendingPermissions() {
    return [...this.pendingPermissions.values()]
  }

  /**
   * The session catalog: what the CLI reported in its `initialize` reply.
   *
   * `commands` is the skill/slash-command list (43 entries, with full descriptions) and
   * `agents` is the subagent type list. Both are far too large to sit in the session summary
   * that the UI polls, so they get their own endpoint.
   *
   * Descriptions are truncated: they are prompt text for the model, sometimes several hundred
   * characters, and the UI only ever shows a line or two.
   */
  catalog() {
    const payload = this.initializeResult
    if (!payload) {
      return { ready: false, commands: [], agents: [], models: [], account: null, permissionMode: this.options.permissionMode ?? null }
    }

    const trim = (list, extra = () => ({})) =>
      (Array.isArray(list) ? list : []).map((item) => ({
        name: typeof item?.name === 'string' ? item.name : String(item ?? ''),
        description: typeof item?.description === 'string' ? item.description.slice(0, 240) : '',
        argumentHint: typeof item?.argumentHint === 'string' ? item.argumentHint : '',
        builtin: item?.builtin === true,
        ...extra(item),
      }))

    return {
      ready: true,
      commands: trim(payload.commands),
      agents: trim(payload.agents),
      models: (Array.isArray(payload.models) ? payload.models : []).map((model) => ({
        value: model?.value ?? '',
        displayName: model?.displayName ?? model?.value ?? '',
        resolvedModel: model?.resolvedModel ?? null,
        description: typeof model?.description === 'string' ? model.description.slice(0, 200) : '',
        supportsEffort: model?.supportsEffort === true,
        effortLevels: Array.isArray(model?.supportedEffortLevels) ? model.supportedEffortLevels : [],
        supportsFastMode: model?.supportsFastMode === true,
      })),
      account: payload.account
        ? { tokenSource: payload.account.tokenSource ?? null, apiProvider: payload.account.apiProvider ?? null }
        : null,
      // The initialize reply is a HANDSHAKE SNAPSHOT. After a set_permission_mode the CLI does
      // not send a fresh one, so its `current_permission_mode` goes stale — the locally tracked
      // value is the accurate one once we have changed it ourselves.
      permissionMode: this.options.permissionMode ?? payload.current_permission_mode ?? null,
      // Same snapshot problem for the model: a set_model is not reflected in the old reply.
      model: this.options.model ?? this.initialModel ?? null,
      /** What the CLI says it is actually running, which may differ from the requested value. */
      resolvedModel: this.resolvedModel,
      sessionState: payload.session_state ?? null,
      outputStyle: payload.output_style ?? null,
    }
  }

  /** Open host dialogs, for a client that attaches after they were raised. */
  listPendingDialogs() {
    return [...this.pendingDialogs.values()]
  }

  /**
   * Cost of this session, priced per turn.
   *
   * Priced from the timeline rather than from running totals so each turn is billed at the rates
   * that were in force when it ran — DeepSeek's peak window makes the TIME a real difference, and
   * a mid-session model switch makes the MODEL one. The per-turn model arrives on the event (see
   * #pushEvent); the session-level model here is only the fallback for a turn with no stamp.
   */
  cost() {
    const timeline = this.history.filter((event) => event.kind === 'result')
    return priceEvents(timeline, this.#billingModel(), this.createdAt)
  }

  /**
   * Send one user turn.
   *
   * Returns false when the child is gone OR a turn is already running. The CLI would
   * happily queue a second message, but the UI shows one turn at a time, so silently
   * accepting it would put the transcript out of step with what the model actually saw.
   */
  send(text) {
    if (!this.child || !this.child.stdin.writable) return false
    if (this.turnActive) return false
    this.turnActive = true
    this.status = 'busy'
    const payload = {
      type: 'user',
      message: { role: 'user', content: [{ type: 'text', text }] },
    }
    this.child.stdin.write(JSON.stringify(payload) + '\n')
    this.#pushEvent({ sessionId: this.id, kind: 'user', text, at: Date.now() })
    return true
  }

  /** Close stdin so the CLI finishes its current turn and exits cleanly. */
  stop() {
    this.stopping = true
    if (this.child && !this.child.killed) {
      try {
        this.child.stdin.end()
      } catch {
        /* already gone */
      }
      // Grace period, then force.
      const child = this.child
      setTimeout(() => {
        if (child.exitCode === null && !child.killed) child.kill()
      }, 2500).unref?.()
    }
    return true
  }

  /**
   * Terminate now, without waiting for the current turn.
   *
   * Used when a session is being REMOVED rather than merely stopped: the user has decided it
   * should be gone, so a two-second grace period would only leave a zombie holding the port.
   */
  kill() {
    this.stopping = true
    try {
      this.child?.removeAllListeners()
      this.child?.kill()
    } catch {
      /* already gone */
    }
    this.child = null
    this.status = 'closed'
    return true
  }

  toJSON() {
    return {
      id: this.id,
      claudeSessionId: this.claudeSessionId,
      status: this.status,
      cwd: this.options.cwd ?? null,
      model: this.options.model ?? this.initialModel ?? null,
      /** What the CLI reports it is actually running, for the model picker's marker. */
      resolvedModel: this.resolvedModel,
      permissionMode: this.options.permissionMode ?? null,
      /**
       * Reasoning effort this session's child was spawned with, or null for the model default.
       *
       * Reported because it is a SESSION property, not a settings one: the composer lets the user
       * change it at any moment, and a control that cannot show the current level would be asking
       * the user to remember what they last picked.
       */
      effort: this.options.effort ?? null,
      baseUrl: this.options.baseUrl ?? DEFAULT_BASE_URL,
      /**
       * Which endpoint this session's child process is talking to. The UI compares it against
       * the chosen provider's URL to know whether a model switch is in-session or needs a
       * restart.
       */
      endpoint: this.options.baseUrl ?? DEFAULT_BASE_URL,
      /**
       * Whether this session holds a credential, as a BOOLEAN — never the value.
       *
       * The UI needs it to tell two states apart that used to look identical: a session whose model
       * is simply absent from the local provider list (still callable, because the child process
       * carries its own endpoint and key), versus one with nothing to authenticate with (a call will
       * genuinely fail). Without this the client could only say "未配置", which is a claim about the
       * list dressed up as a claim about capability.
       */
      hasCredential: Boolean(this.options.authToken || this.options.apiKey),
      historyLength: this.history.length,
      createdAt: this.createdAt,
      pendingPermissions: this.listPendingPermissions().map((pending) => ({
        requestId: pending.requestId,
        toolName: pending.toolName,
        displayName: pending.displayName,
        description: pending.description,
        toolUseId: pending.toolUseId,
      })),
      pendingDialogs: [...this.pendingDialogs.values()].map((pending) => ({
        requestId: pending.requestId,
        dialogKind: pending.dialogKind,
        toolUseId: pending.toolUseId,
      })),
      capabilities: this.initializeResult
        ? {
            dialogKinds: this.initializeResult.supportedDialogKinds ?? null,
            subagentText: this.initializeResult.forwardSubagentText ?? null,
          }
        : null,
    }
  }
}
