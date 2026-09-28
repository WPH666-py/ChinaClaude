/**
 * Cost accounting.
 *
 * Two facts make this more than a multiply:
 *
 *  1. RATES ARE TIME-DEPENDENT. DeepSeek bills peak and off-peak separately, and off-peak is
 *     exactly half. Peak is Beijing time 09:00-12:00 and 14:00-18:00 on weekdays. A session that
 *     spans a boundary has turns billed at two different rates, so each turn is priced at the
 *     rate in force WHEN IT RAN rather than at the rate in force when you look at it.
 *
 *  2. CACHED INPUT IS A THIRD BUCKET. Cache hits are 50x cheaper than misses on flash, and Claude
 *     Code reports `cache_read_input_tokens` separately — folding it into "input" would overstate
 *     cost by an order of magnitude. Measured on a real turn: 10,831 miss + 68,736 hit.
 *
 * Chinese public holidays are NOT modelled: the official calendar changes yearly and shipping a
 * stale holiday list would silently misprice. Weekday hours are used as the proxy, and the UI
 * says so rather than implying exactness it does not have.
 *
 * Source: https://api-docs.deepseek.com/zh-cn/quick_start/pricing (2026-09)
 */

/** CNY per 1M tokens. `peak` is the weekday-business-hours rate; `offPeak` is half. */
const DEEPSEEK_RATES = {
  'deepseek-flash': {
    label: 'DeepSeek-V4.1-Flash',
    offPeak: { cacheHit: 0.02, cacheMiss: 1, output: 4 },
    peak: { cacheHit: 0.04, cacheMiss: 2, output: 8 },
  },
  'deepseek-v4-pro': {
    label: 'DeepSeek-V4-Pro',
    offPeak: { cacheHit: 0.15, cacheMiss: 4.5, output: 13.5 },
    peak: { cacheHit: 0.3, cacheMiss: 9, output: 27 },
  },
}

/**
 * WHY USER-SUPPLIED TABLES EXIST
 *
 * The built-in table only covers DeepSeek, because that is the one endpoint this client ships
 * against. Measured consequence for anyone else: 16 of 16 common Qwen / GLM / Kimi / 阶跃星辰 /
 * 讯飞星火 model names come back unpriced, so the cost row disappears entirely.
 *
 * The fix is NOT to hardcode five more vendors. Published prices differ per model tier, per region,
 * per billing mode (on-demand vs. batch vs. cached), and they change; a table shipped in an
 * installer would be confidently wrong within months, which is worse than showing nothing. A table
 * the USER fills in with rates they can verify against their own bill is right on the day it is
 * typed and obvious when it is stale.
 *
 * Shape of one table:
 *   { id, match, label, cacheMiss, cacheHit, output, peakMultiplier? }
 *
 * `match` is a case-insensitive substring of the model name ('' or '*' matches anything), so one
 * row covers a family. `peakMultiplier` defaults to 1, meaning "this vendor does not price by time
 * of day" — only DeepSeek's table distinguishes peak from off-peak.
 */

/** Whether a table's `match` covers a model name. */
function tableMatches(table, name) {
  const needle = String(table?.match ?? '').trim().toLowerCase()
  if (needle === '' || needle === '*') return Boolean(table?.id)
  return name.includes(needle)
}

/**
 * Rates for one model: a user table if one matches, else the built-in DeepSeek mapping.
 *
 * User tables win on purpose, so a user on DeepSeek can correct our numbers without waiting for a
 * release, and so a relay that renames models can be described locally.
 *
 * @returns {{key:string,label:string,rate:object,peakRate:object,source:'custom'|'builtin'}|null}
 */
function resolveRates(reportedModel, tables) {
  const name = String(reportedModel ?? '').toLowerCase()
  if (!name) return null

  for (const table of tables ?? []) {
    if (!tableMatches(table, name)) continue
    const rate = {
      cacheHit: Number(table.cacheHit) || 0,
      cacheMiss: Number(table.cacheMiss) || 0,
      output: Number(table.output) || 0,
    }
    // A multiplier of 1 means the same rate all day, which is how most vendors bill.
    const multiplier = Number(table.peakMultiplier)
    const peakRate = Number.isFinite(multiplier) && multiplier > 1
      ? { cacheHit: rate.cacheHit * multiplier, cacheMiss: rate.cacheMiss * multiplier, output: rate.output * multiplier }
      : rate
    return {
      key: table.id || `custom:${table.match}`,
      label: table.label || table.match || '自定义价目',
      rate,
      peakRate,
      source: 'custom',
    }
  }

  const billed = billedModel(reportedModel)
  if (!billed) return null
  const rates = DEEPSEEK_RATES[billed]
  if (!rates) return null
  return { key: billed, label: rates.label, rate: rates.offPeak, peakRate: rates.peak, source: 'builtin' }
}

/**
 * Claude model names are mapped to DeepSeek models SERVER-SIDE by the relay, so the model the CLI
 * reports is not the model being billed. This mirrors the endpoint's documented mapping:
 *   claude-opus*              -> deepseek-v4-pro
 *   claude-sonnet* / haiku*   -> deepseek-flash
 */
export function billedModel(reportedModel) {
  const name = String(reportedModel ?? '').toLowerCase()
  if (!name) return null
  if (name.startsWith('deepseek-v4-pro') || name.startsWith('deepseek-reasoner')) return 'deepseek-v4-pro'
  if (name.startsWith('deepseek')) return 'deepseek-flash'
  if (name.includes('opus')) return 'deepseek-v4-pro'
  if (name.includes('sonnet') || name.includes('haiku') || name.includes('fable')) return 'deepseek-flash'
  return null
}

/** Whether `at` falls inside DeepSeek's peak window, in Beijing time. */
export function isPeak(at = Date.now()) {
  // Beijing is UTC+8 with no DST, so shifting the epoch is exact and avoids locale database
  // differences between machines.
  const beijing = new Date(at + 8 * 60 * 60 * 1000)
  const day = beijing.getUTCDay() // 0 = Sunday
  if (day === 0 || day === 6) return false
  const hour = beijing.getUTCHours()
  const minute = beijing.getUTCMinutes()
  const minutes = hour * 60 + minute
  const inMorning = minutes >= 9 * 60 && minutes < 12 * 60
  const inAfternoon = minutes >= 14 * 60 && minutes < 18 * 60
  return inMorning || inAfternoon
}

/**
 * Price one turn.
 *
 * @param {{inputTokens:number, outputTokens:number, cacheReadTokens:number, cacheCreationTokens:number}} usage
 * @param {string|null} model   the model the CLI reported
 * @param {number} at           when the turn ran
 * @param {{tables?: Array<object>}} [options]  user-supplied rate tables, which win over built-ins
 * @returns {{cny:number, model:string|null, peak:boolean, breakdown:object}|null} null when unpriced
 */
export function priceTurn(usage, model, at = Date.now(), options = {}) {
  const resolved = resolveRates(model, options.tables)
  if (!resolved) return null

  /**
   * Time-of-day pricing applies ONLY to a table that says so.
   *
   * This matters for correctness, not tidiness: `isPeak()` describes DeepSeek's Beijing peak
   * window. Applying it to a vendor that bills flat would silently DOUBLE every price during
   * Chinese business hours.
   */
  const timeOfDay = resolved.peakRate !== resolved.rate
  const peak = timeOfDay ? isPeak(at) : false
  const rate = peak ? resolved.peakRate : resolved.rate

  const input = usage?.inputTokens ?? 0
  const output = usage?.outputTokens ?? 0
  const cacheHit = usage?.cacheReadTokens ?? 0
  const cacheWrite = usage?.cacheCreationTokens ?? 0

  // A cache write is billed as a miss on this endpoint (it is the first read of that prefix).
  const missTokens = input + cacheWrite

  const perMillion = 1_000_000
  const cny =
    (missTokens * rate.cacheMiss) / perMillion +
    (cacheHit * rate.cacheHit) / perMillion +
    (output * rate.output) / perMillion

  return {
    cny,
    model: resolved.key,
    label: resolved.label,
    peak,
    source: resolved.source,
    /** False when the rate does not vary by time of day, so the UI need not claim a basis. */
    timeOfDay,
    breakdown: {
      cacheMissTokens: missTokens,
      cacheHitTokens: cacheHit,
      outputTokens: output,
      rate,
    },
  }
}

/** Price a whole timeline of `result` events, honouring per-turn rate boundaries. */
export function priceEvents(events, model, fallbackAt, options = {}) {
  let totalCny = 0
  let pricedTurns = 0
  let unpricedTurns = 0
  /** Whether any priced turn used a time-of-day table, so the UI does not claim a false basis. */
  let usesTimeOfDay = false
  const perModel = new Map()

  for (const event of events) {
    if (event?.kind !== 'result') continue
    // A per-event model WINS over the session-level fallback. A session can switch models
    // mid-conversation, and repricing an earlier turn at the newer model's rate would rewrite a
    // bill that has already been incurred.
    const priced = priceTurn(event.usage ?? {}, event.model ?? model, event.at ?? fallbackAt, options)
    if (!priced) {
      unpricedTurns++
      continue
    }
    totalCny += priced.cny
    pricedTurns++
    if (priced.timeOfDay) usesTimeOfDay = true
    const entry = perModel.get(priced.model) ?? { model: priced.model, label: priced.label, cny: 0, turns: 0 }
    entry.cny += priced.cny
    entry.turns++
    perModel.set(priced.model, entry)
  }

  return {
    totalCny,
    pricedTurns,
    unpricedTurns,
    perModel: [...perModel.values()],
    /** False when nothing could be priced, so the UI can say "unknown" instead of "0.00". */
    priced: pricedTurns > 0,
    /** True only when a priced turn's rate actually varies by time of day. */
    usesTimeOfDay,
  }
}

export { DEEPSEEK_RATES }
