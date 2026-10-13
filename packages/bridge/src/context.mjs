/**
 * Context accounting: folds one session's event array into token totals and a pressure reading.
 *
 * WHY THIS IS A SHARED PURE MODULE. The page and the bridge must answer "how full is this
 * conversation" with the same number — the page renders the timeline it received over SSE, the
 * bridge keeps the same timeline in its replay log. Two implementations would drift the first time
 * either side learned a new usage field, and the visible symptom would be two different percentages
 * for one session. So: no imports, no I/O, no clock reads. Callers pass everything in, which is also
 * what makes the fold testable against a hand-built array.
 *
 * WHICH COLUMN COSTS MONEY. DeepSeek's endpoint ignores explicit `cache_control` markers, so a client
 * cannot choose what gets cached — but the server-side KV cache applies anyway, and every later turn
 * re-reads the shared prefix from it. Measured on one real turn: 10,831 miss + 68,736 hit. A hit
 * bills at 1/50 of a miss on flash (see pricing.mjs), so on a long conversation the 缓存命中 column
 * is where the bill lives; the MISS column is the part that grows the window and is therefore the
 * part worth compressing.
 *
 * SOURCE OF EACH FIELD. The bridge's `normalizeEvent` maps the CLI's raw `result` frame to
 * `usage.{inputTokens,outputTokens,cacheReadTokens,cacheCreationTokens}` from the wire names
 * `input_tokens`, `output_tokens`, `cache_read_input_tokens`, `cache_creation_input_tokens`, and
 * stamps `model` + `seq` on the way into history. Those mapped names are what this module reads.
 */

/**
 * The window a session is measured against when no real one is known, so a percentage can be drawn
 * at all.
 *
 * DISPLAY DEFAULT, never a measurement: the panel that uses it says the window is assumed rather
 * than observed. It exists because the failure mode on the other side is worse — with no number at
 * all there is nothing to compare against, and "you are 74% full" is the single fact that tells a
 * user whether to keep going or compact. Callers that do know the real window (a model's catalog
 * entry, a future `/context` route) pass it in, and the assumption is dropped.
 */
export const DEFAULT_CONTEXT_WINDOW = 128000

/** A finite, non-negative token count, else 0. Usage arrives absent, null, or stringified. */
function count(value) {
  const n = Number(value)
  return Number.isFinite(n) && n > 0 ? n : 0
}

/** A finite epoch-ms timestamp, else null — `at` is absent on a hand-built event. */
function stamp(value) {
  const n = Number(value)
  return Number.isFinite(n) && n > 0 ? n : null
}

/**
 * A token count as a short human string: `1234` -> `1.2k`, `1234567` -> `1.2M`.
 *
 * Hand-rolled rather than `Intl.NumberFormat` on purpose: the compact notation is locale-dependent
 * (`1.2万` under zh-CN), which would make this module's output differ per machine, and these strings
 * are also assembled into log lines and tooltips where a stable format matters more than a
 * localised one.
 */
export function formatTokens(n) {
  const value = Number(n)
  // A non-finite count means the caller folded something that was not a number. Returning '0' keeps
  // a broken input from throwing in the middle of a render, which would blank the whole panel.
  if (!Number.isFinite(value)) return '0'
  const abs = Math.abs(value)
  if (abs < 1000) return String(Math.round(value))
  // The 999_950 thresholds stop the rollover: 999_999 / 1000 rounds to "1000.0k", a unit that should
  // not exist because the next unit up already covers it.
  if (abs < 999_950) return `${(value / 1000).toFixed(1)}k`
  if (abs < 999_950_000) return `${(value / 1_000_000).toFixed(1)}M`
  return `${(value / 1_000_000_000).toFixed(1)}B`
}

/**
 * Identity of one turn, so a re-delivered frame is not counted (and billed) twice.
 *
 * `seq` is the bridge's own monotonic per-session cursor — every non-transient event carries one,
 * which makes it the real key; a client that reconnects and re-reads history would otherwise fold
 * the same turns again. A hand-built array (a test fixture, or a caller that mapped events down to
 * the fields pricing reads) has no `seq`, so the fallback is the frame's own fingerprint: a
 * re-delivery repeats all of it, and two genuinely different turns agreeing on timestamp AND all
 * four counts are indistinguishable for accounting anyway. `model` is in the fingerprint because a
 * mid-conversation model switch can otherwise produce two identical-looking turns.
 */
function turnKey(event) {
  const seq = Number(event?.seq)
  if (Number.isFinite(seq) && seq > 0) return `s${seq}`
  const usage = event?.usage ?? {}
  return [
    'f',
    event?.at ?? '',
    usage.inputTokens ?? '',
    usage.outputTokens ?? '',
    usage.cacheReadTokens ?? '',
    usage.cacheCreationTokens ?? '',
    event?.model ?? '',
  ].join('|')
}

/**
 * Fold the timeline once.
 *
 * Kept private so the two exports cannot disagree: `summarizeEvents` and `estimateContextPressure`
 * read the SAME last-turn usage, which is what stops "总计" and the pressure gauge from telling two
 * different stories about one session.
 */
function fold(events) {
  const seen = new Set()
  let turns = 0
  let input = 0
  let output = 0
  let cacheRead = 0
  let cacheWrite = 0
  const peaks = { input: 0, output: 0, cacheRead: 0 }
  let lastModel = null
  let firstAt = null
  let lastAt = null
  /** Usage of the newest turn — the only one whose prompt describes the live window. */
  let last = null

  for (const event of Array.isArray(events) ? events : []) {
    // Only `result` frames carry usage. Every other kind is content, not accounting, and an unknown
    // kind from a newer CLI must be skipped rather than throw: this fold runs on every render.
    if (event?.kind !== 'result') continue
    const key = turnKey(event)
    if (seen.has(key)) continue
    seen.add(key)
    // A result frame is evidence a turn happened even when it carries no usage (a relay that drops
    // the field, a turn killed mid-flight), so the count stays honest while its tokens read 0.
    turns += 1

    const usage = event.usage ?? {}
    const missed = count(usage.inputTokens)
    const produced = count(usage.outputTokens)
    const hits = count(usage.cacheReadTokens)
    const written = count(usage.cacheCreationTokens)

    input += missed
    output += produced
    cacheRead += hits
    cacheWrite += written

    // Peaks, not averages. An average hides the shape that actually costs money: one turn that
    // pasted a 60k-token file moves both the bill and the window far more than ten 2k turns, and it
    // is exactly the turn a user would compress away if they could see it.
    if (missed > peaks.input) peaks.input = missed
    if (produced > peaks.output) peaks.output = produced
    if (hits > peaks.cacheRead) peaks.cacheRead = hits

    // A turn with no model stamp (an older event, a hand-built array) leaves the previous answer in
    // place rather than clearing it: "the model we last saw" is more useful than null.
    if (typeof event.model === 'string' && event.model.length > 0) lastModel = event.model

    const at = stamp(event.at)
    if (at !== null) {
      if (firstAt === null) firstAt = at
      lastAt = at
    }

    last = { input: missed, cacheRead: hits, output: produced, at }
  }

  return { turns, input, output, cacheRead, cacheWrite, peaks, lastModel, firstAt, lastAt, last }
}

/**
 * Fold a session's timeline into token totals.
 *
 * @param {Array<{kind?:string, at?:number, model?:string|null, seq?:number, usage?:object}>} events
 * @returns {{ok:boolean, turns:number, input:number, output:number, cacheRead:number,
 *   cacheWrite:number, total:number, lastModel:string|null,
 *   peaks:{input:number, output:number, cacheRead:number},
 *   firstAt:number|null, lastAt:number|null}}
 */
export function summarizeEvents(events) {
  const folded = fold(events)
  return {
    /**
     * False when no turn has reported usage yet, so a caller can say "还没有用量" instead of
     * presenting a row of zeros as if it were a measurement.
     */
    ok: folded.turns > 0,
    turns: folded.turns,
    input: folded.input,
    output: folded.output,
    cacheRead: folded.cacheRead,
    cacheWrite: folded.cacheWrite,
    /** Everything the endpoint reported for this session, all four buckets. */
    total: folded.input + folded.output + folded.cacheRead + folded.cacheWrite,
    lastModel: folded.lastModel,
    peaks: folded.peaks,
    firstAt: folded.firstAt,
    lastAt: folded.lastAt,
  }
}

/**
 * One Chinese sentence saying what to DO about the current pressure.
 *
 * A percentage alone does not answer the question the user has ("can I paste this file, or should I
 * compact first?"), and the action differs by level. When the window is assumed rather than known,
 * the sentence says so — advice built on a guessed denominator that hides the guess is worse than no
 * advice.
 */
function adviceFor(used, window, ratio, level, windowKnown) {
  const assumed = windowKnown ? '' : `（窗口大小未知，按默认 ${formatTokens(DEFAULT_CONTEXT_WINDOW)} 估算）`
  if (used === 0) return `还没有可统计的用量，先跑一轮再判断上下文压力${assumed}`
  const size = `${formatTokens(used)} / ${formatTokens(window)}`
  if (level === 'tight') {
    return `上下文已用 ${Math.round(ratio * 100)}%（${size}）：现在压缩最划算，再追加内容会让之后每一轮都按更长的前缀计费${assumed}`
  }
  if (level === 'watch') {
    return `上下文已用 ${Math.round(ratio * 100)}%（${size}）：建议先 /compact 再贴长文件，别把整份文件顶进窗口${assumed}`
  }
  return `上下文已用 ${Math.round(ratio * 100)}%（${size}）：还能继续，压缩留到更接近上限时更划算${assumed}`
}

/**
 * How full the live context window is, and what to do about it.
 *
 * `used` is the MOST RECENT turn's prompt — misses plus cache hits — not the session total. A
 * session that has run for an hour does not hold an hour of tokens: every turn re-sends the
 * conversation, so the newest turn's prompt is the size of the window, while summing the timeline
 * would grow without bound and read "full" forever.
 *
 * Cache WRITES are deliberately excluded from `used`: on this endpoint a write is billed as a miss
 * because it is the first read of that prefix, and the same prefix is reported as a cache READ on
 * every following turn. Adding the write here would count the newest prefix twice once it is cached,
 * which is precisely the case this gauge exists to measure.
 *
 * @param {{events?:Array<object>, contextWindow?:number}} input
 * @returns {{ok:boolean, used:number, window:number, ratio:number,
 *   level:'calm'|'watch'|'tight', advice:string}}
 */
export function estimateContextPressure({ events, contextWindow } = {}) {
  const folded = fold(events)
  const used = folded.last === null ? 0 : folded.last.input + folded.last.cacheRead

  const declared = Number(contextWindow)
  const windowKnown = Number.isFinite(declared) && declared > 0
  const window = windowKnown ? declared : DEFAULT_CONTEXT_WINDOW

  // Left unclamped: a ratio above 1 means the last prompt was larger than the window, which is a
  // real state (the endpoint accepted it) and the one reading a gauge must not round away. The bar
  // clamps its own width; this number stays the truth.
  const ratio = window > 0 ? used / window : 0
  const level = ratio >= 0.75 ? 'tight' : ratio >= 0.5 ? 'watch' : 'calm'

  return {
    ok: folded.turns > 0,
    used,
    window,
    ratio,
    level,
    advice: adviceFor(used, window, ratio, level, windowKnown),
  }
}
