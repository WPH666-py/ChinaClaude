/** Wire types shared with the Node bridge. Kept dependency-free so both sides can differ. */

export type EventKind =
  | 'init'
  | 'status'
  | 'thinking_tokens'
  | 'thinking'
  | 'thinking_delta'
  | 'text'
  | 'text_delta'
  | 'tool_use'
  | 'tool_result'
  | 'user'
  | 'result'
  | 'assistant_other'
  | 'permission_request'
  | 'permission_settled'
  | 'permission_denied'
  | 'dialog_request'
  | 'dialog_settled'
  | 'notice'
  | 'log'
  | 'error'
  | 'closed'

export interface BridgeEvent {
  sessionId: string
  kind: EventKind
  at: number
  /** Monotonic per-session cursor backing SSE resumption; absent on bridge-side notices. */
  seq?: number

  // init
  claudeSessionId?: string
  /**
   * The model attached to this event.
   *
   * Two producers share this field and both are load-bearing. On `init` it is the model the CLI
   * reports it is running. On `result` it is stamped by the bridge as the turn completes, recording
   * which model ACTUALLY RAN that turn — the user can switch models mid-conversation, so pricing an
   * earlier turn from the session's current model would rewrite a bill already incurred.
   */
  model?: string | null
  tools?: string[]
  skills?: string[]
  slashCommands?: string[]
  agents?: string[]
  /** Loaded plugins, as the CLI reports them in its init frame. */
  plugins?: Array<{ name: string; path: string | null; source: string | null }>
  /** Connected MCP servers, as the CLI reports them. */
  mcpServers?: string[]
  permissionMode?: string
  capabilities?: string[]
  claudeCodeVersion?: string
  cwd?: string

  // thinking_tokens
  estimated?: number
  /** How much the latest progress frame added, for a counter that accumulates rather than re-reads. */
  estimatedDelta?: number

  // status: the CLI's own lifecycle reporting (e.g. 'requesting'), earlier than the first token.
  status?: string

  /**
   * Streaming content, forwarded because the child runs with `--include-partial-messages`.
   *
   * These are EPHEMERAL: they never enter the bridge's replay log, so a reconnecting client will not
   * see them again, and they carry no `seq` for the same reason.
   */
  transient?: boolean
  /** Content-block index a delta belongs to, so fragments of one block stay distinguishable. */
  index?: number

  // thinking / text / user
  text?: string

  // tool_use
  id?: string
  name?: string
  input?: unknown

  // tool_result
  toolUseId?: string
  isError?: boolean
  content?: string

  // result
  subtype?: string
  durationMs?: number
  stopReason?: string
  reportedCostUsd?: number
  usage?: Usage
  // `model` for a result event is declared once, on the shared field above: it carries the model
  // that ran THIS turn, which is what per-turn pricing reads.

  // permission_request / permission_settled / permission_denied
  requestId?: string
  displayName?: string
  description?: string
  suggestions?: Array<Record<string, unknown>>
  decisionReason?: string
  decisionReasonType?: string
  defaultToNo?: boolean
  suppressAlwaysAllowRule?: boolean
  requiresUserInteraction?: boolean
  blockedPath?: string
  decision?: 'allow' | 'deny' | 'expired'
  scope?: 'once' | 'session'

  // dialog_request / dialog_settled
  dialogKind?: string
  payload?: Record<string, unknown>
  behavior?: 'completed' | 'cancelled' | 'expired'

  // subagent lineage: the tool_use that started the agent, or null at top level
  parentToolUseId?: string | null

  // log / error / closed
  level?: string
  message?: string
  code?: number | null
  reason?: string | null
}

export interface Usage {
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheCreationTokens: number
}

export interface SessionView {
  id: string
  claudeSessionId: string | null
  status:
    | 'starting'
    | 'ready'
    | 'busy'
    | 'closed'
    | 'failed'
    | 'awaiting_approval'
    | 'awaiting_dialog'
  cwd: string | null
  model: string | null
  /** What the CLI reports it is actually running, which may differ from `model`. */
  resolvedModel?: string | null
  permissionMode: string | null
  /**
   * Reasoning effort the CLI child was spawned with, or null for the model default.
   *
   * Session state rather than a setting: the composer switches it live, and an effort change
   * relaunches the child (it is a `--effort` argument) while resuming the same conversation.
   */
  effort?: string | null
  baseUrl: string
  /**
   * The endpoint this session's child process was started against.
   *
   * Distinct from `baseUrl`: the UI compares it with the chosen provider's URL to decide whether a
   * model switch can happen in-session or needs a restart. It was being sent by the bridge but was
   * missing from this type, so anything reading it had to go through an untyped escape hatch.
   */
  endpoint?: string
  /** Whether the session holds a credential. A boolean, never the value. */
  hasCredential?: boolean
  historyLength: number
  /** Epoch ms the session was created, used to tell siblings in one workspace apart. */
  createdAt?: number
  pendingPermissions?: Array<{
    requestId: string
    toolName: string
    displayName: string
    description: string
    toolUseId: string
  }>
  pendingDialogs?: Array<{
    requestId: string
    dialogKind: string
    toolUseId: string
  }>
  capabilities?: {
    dialogKinds: string[] | null
    subagentText: boolean | null
  } | null
}

export interface Discovery {
  binary: { path: string; source: string } | null
  baseUrl: string | null
  hasCredential: boolean
  claude: {
    home: string
    configPath: string | null
    settingsPath: string | null
    installMethod: string | null
    firstStartTime: string | null
    userId: string | null
    projectCount: number
    hasSettings: boolean
    mcpServers: string[]
  }
  runtime: {
    node: string
    platform: string
    arch: string
    execPath: string
    isPackaged: boolean
  }
  projects: Array<{ path: string; lastUsed: string | null; turns: number }>
}

/** One component the installer shipped. */
export interface BundledComponent {
  id: string
  name: string
  kind: 'core' | 'skill' | 'plugin' | 'mcp'
  package?: string
  version: string
  homepage?: string
  license?: string
  author?: string
  summary: string
  /** How the CLI reports it once loaded; cross-checked against the session's own lists. */
  loadedAs?: { kind: string; name: string }
  setupHint?: string
  vendored?: boolean
  /** Whether the evidence file is actually on disk. Null when the root is unknown. */
  present: boolean | null
  absolutePath?: string | null
}

/** A component that was deliberately left out, with the measured reason. */
export interface NotBundledComponent {
  name: string
  reason: string
  portable: string
}

export interface BundledInventory {
  sidecarRoot: string | null
  bundled: BundledComponent[]
  notBundled: NotBundledComponent[]
}

// ---- existing Claude Code transcripts (import panel) ------------------------

export interface TranscriptSummary {
  path: string
  project: string
  /** Equals the filename; used verbatim with the CLI's `--resume`. */
  sessionId: string
  bytes: number
  mtime: number
  cwd: string | null
  version: string | null
  /** The first real user prompt, so it is never a tool result. */
  title: string | null
  preview: string | null
  /** User prompts plus assistant messages. Tool results and sidechains are NOT counted. */
  turns: number
  userTurns: number
  assistantTurns: number
  /** User-shaped records that were only tool results, tracked so the counts reconcile. */
  toolResultRecords: number
  /** Subagent traffic, excluded from `turns` because the user never saw it as their own turn. */
  sidechainRecords: number
  startedAt: string | null
  endedAt: string | null
  gitBranch: string | null
  /** Set when the file was too large to read fully, so only metadata is known. */
  oversized?: boolean
}

export interface TranscriptGroup {
  cwd: string
  items: TranscriptSummary[]
}

export interface TranscriptListing {
  root: string
  total: number
  matched: number
  truncatedByCount: boolean
  transcripts: TranscriptSummary[]
  groups: TranscriptGroup[]
}

// ---- directory security audit (vet panel) -----------------------------------

export type VetSeverity = 'critical' | 'high' | 'medium' | 'info'

export interface VetFinding {
  rule: string
  severity: VetSeverity
  message: string
  evidence: string
  file?: string
  line?: number
  confidence: 'certain' | 'likely' | 'heuristic'
  /** Set when the hit was recovered from an encoded literal. */
  decodedFrom?: 'base64' | 'hex' | 'charCode' | 'concat' | 'template'
}

export interface VetCapabilities {
  hosts: string[]
  fsPaths: string[]
  spawnCmds: string[]
  imports: string[]
  hasNetwork: boolean
  hasExec: boolean
  esmNamedBuiltins?: boolean
  ghostDeps?: string[]
  zombieDeps?: string[]
  hasNativeBinary?: boolean
  nativeBinaries?: string[]
}

export interface VetReport {
  /** The rule set that produced the verdict, so a result is attributable. */
  engine: string | null
  sourceCount: number
  findings: VetFinding[]
  /** A HEALTH score: `100 - Σ(severity weight × confidence)`. Higher is better. */
  staticScore: number
  verdict: 'critical' | 'suspicious' | 'clean'
  capabilities?: VetCapabilities
  /** Findings pre-grouped by severity in descending order. */
  groups?: Array<{ severity: VetSeverity; items: VetFinding[] }>
}

export interface VetStatus {
  available: boolean
  reason: string | null
  engine: string | null
}

// ---- provider account balance ----------------------------------------------

/**
 * A balance reading, normalised across vendors.
 *
 * `available: false` with an `error` is a normal outcome, not an exception: most providers have no
 * balance API at all, and the ones that do may reject the key or change shape. The sidebar shows the
 * reason rather than hiding the row, so "no balance" and "balance is zero" stay distinguishable.
 */
export interface ProviderBalance {
  available: boolean
  currency: string | null
  total: number | null
  granted: number | null
  toppedUp: number | null
  detail: string | null
  /** Why the balance could not be read. Present only when `available` is false. */
  error?: string | null
  /** Which adapter answered: 'deepseek' or 'custom'. */
  adapter?: string | null
  /** The URL actually queried, for the tooltip — makes a misconfigured endpoint diagnosable. */
  url?: string
}

export interface Health {
  ok: boolean
  version: number
  binary: string
  baseUrl: string
  hasCredential: boolean
  sessions: number
}

/** One skill / slash command as the CLI reports it in its initialize reply. */
export interface CatalogCommand {
  name: string
  description: string
  argumentHint: string
  builtin: boolean
}

/** One subagent type the CLI can launch. */
export interface CatalogAgent {
  name: string
  description: string
  builtin: boolean
}

/** One selectable model, with the capabilities the CLI advertises for it. */
export interface CatalogModel {
  value: string
  displayName: string
  resolvedModel: string | null
  description: string
  supportsEffort: boolean
  effortLevels: string[]
  supportsFastMode: boolean
}

/**
 * The session catalog, sourced from the CLI's `initialize` reply.
 *
 * `ready` is false until that handshake lands, which is why the panel shows a waiting state
 * rather than an empty list.
 */
export interface Catalog {
  ready: boolean
  commands: CatalogCommand[]
  agents: CatalogAgent[]
  models: CatalogModel[]
  account: { tokenSource: string | null; apiProvider: string | null } | null
  permissionMode: string | null
  /** Model explicitly selected for this session, or null when it is on the session default. */
  model?: string | null
  /** The concrete model the CLI reports it is running, even when none was selected. */
  resolvedModel?: string | null
  sessionState?: string | null
  outputStyle?: string | null
}

// ---- updates ----------------------------------------------------------------

/**
 * The installer a check found.
 *
 * There is deliberately NO `url` here: the bridge keeps it, so a page can never nominate a file for
 * that process to fetch and then execute. The page gets the name, the size and the digest — enough to
 * show what will be downloaded and to verify it afterwards.
 */
export interface UpdateAsset {
  name: string
  size: number | null
  sha256: string
}

export interface UpdateCheck {
  /** False when NO source could be reached. That is a normal outcome, not an error state. */
  ok: boolean
  current: string
  latest?: string
  available: boolean
  /** True only when a source actually supplied a file. A host can know the version without it. */
  installable?: boolean
  notes?: string
  page?: string
  source?: string
  /** Sources that answered, and those that did not — both are shown, so a silent mirror is visible. */
  checked?: string[]
  errors?: string[]
  asset?: UpdateAsset | null
}

export interface UpdateProgress {
  phase: 'idle' | 'downloading' | 'verifying' | 'ready' | 'installing' | 'error'
  received: number
  total: number
  path: string | null
  error: string | null
  /** `null` means the source supplied no digest, so the download could not be checked at all. */
  verified: boolean | null
}
