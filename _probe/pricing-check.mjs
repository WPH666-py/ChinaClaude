/**
 * Pricing regression probe.
 *
 * Every assertion here is a falsifiable claim about the cost model. The two that matter most:
 *
 *  - CACHE HITS MUST BE A SEPARATE BUCKET. On the measured real turn (10,831 miss + 68,736 hit +
 *    536 output) folding cache reads into "input" would multiply the bill by ~7x. The probe
 *    asserts the actual number so a future refactor that loses the bucket fails loudly.
 *  - THE SAME TURN MUST PRICE DIFFERENTLY IN PEAK AND OFF-PEAK. If these ever come out equal, the
 *    time-dependence of the rate table has been silently dropped.
 *
 * Run: node _probe/pricing-check.mjs
 */
import assert from 'node:assert/strict'
import { priceTurn, priceEvents, billedModel, isPeak, DEEPSEEK_RATES } from '../packages/bridge/src/pricing.mjs'

let passed = 0
const check = (label, fn) => {
  try {
    fn()
    passed++
    console.log(`  ok   ${label}`)
  } catch (error) {
    console.log(`  FAIL ${label}\n       ${error.message}`)
    process.exitCode = 1
  }
}

/** The real measured turn, reused everywhere so the numbers stay comparable. */
const MEASURED = { inputTokens: 10831, outputTokens: 536, cacheReadTokens: 68736, cacheCreationTokens: 0 }

// Beijing 2026-09-25 is a Friday. 10:00 Beijing = 02:00Z (peak), 22:00 Beijing = 14:00Z (off-peak).
const PEAK_AT = Date.parse('2026-09-25T02:00:00Z')
const OFF_PEAK_AT = Date.parse('2026-09-25T14:00:00Z')

console.log('peak window (Beijing time, weekdays)')
check('10:00 Beijing is peak', () => assert.equal(isPeak(PEAK_AT), true))
check('22:00 Beijing is off-peak', () => assert.equal(isPeak(OFF_PEAK_AT), false))
check('13:00 Beijing is off-peak (lunch gap)', () => assert.equal(isPeak(Date.parse('2026-09-25T05:00:00Z')), false))
check('08:59 Beijing is off-peak', () => assert.equal(isPeak(Date.parse('2026-09-25T00:59:00Z')), false))
check('09:00 Beijing is peak (boundary in)', () => assert.equal(isPeak(Date.parse('2026-09-25T01:00:00Z')), true))
check('12:00 Beijing is off-peak (boundary out)', () => assert.equal(isPeak(Date.parse('2026-09-25T04:00:00Z')), false))
check('18:00 Beijing is off-peak (boundary out)', () => assert.equal(isPeak(Date.parse('2026-09-25T10:00:00Z')), false))
check('Saturday is never peak', () => assert.equal(isPeak(Date.parse('2026-09-26T02:00:00Z')), false))
check('Sunday is never peak', () => assert.equal(isPeak(Date.parse('2026-09-27T02:00:00Z')), false))
check('Beijing offset is applied, not local time', () => {
  // 2026-09-25T01:30:00Z is 09:30 Beijing (peak) but 01:30 UTC / 18:30 PDT (would read off-peak
  // under any local-time implementation). The shifted-epoch approach must be timezone-independent.
  const at = Date.parse('2026-09-25T01:30:00Z')
  const previous = process.env.TZ
  process.env.TZ = 'America/Los_Angeles'
  const west = isPeak(at)
  process.env.TZ = 'Asia/Shanghai'
  const east = isPeak(at)
  if (previous === undefined) delete process.env.TZ
  else process.env.TZ = previous
  assert.equal(west, true)
  assert.equal(east, true)
})

console.log('model mapping (relay bills a different model than the CLI reports)')
check('claude-opus* -> deepseek-v4-pro', () => assert.equal(billedModel('claude-opus-5-5[1m]'), 'deepseek-v4-pro'))
check('claude-sonnet* -> deepseek-flash', () => assert.equal(billedModel('claude-sonnet-5'), 'deepseek-flash'))
check('claude-haiku* -> deepseek-flash', () => assert.equal(billedModel('claude-haiku-4-5'), 'deepseek-flash'))
check('claude-fable* -> deepseek-flash', () => assert.equal(billedModel('claude-fable-5'), 'deepseek-flash'))
check('explicit deepseek-v4-pro stays pro', () => assert.equal(billedModel('deepseek-v4-pro'), 'deepseek-v4-pro'))
check('deepseek-reasoner -> pro', () => assert.equal(billedModel('deepseek-reasoner'), 'deepseek-v4-pro'))
check('deepseek-chat -> flash', () => assert.equal(billedModel('deepseek-chat'), 'deepseek-flash'))
check('unknown model is unpriced, not guessed', () => assert.equal(billedModel('gpt-9'), null))
check('empty model is unpriced', () => assert.equal(billedModel(''), null))
check('undefined model is unpriced', () => assert.equal(billedModel(undefined), null))

console.log('per-turn pricing against the measured turn')
const peakTurn = priceTurn(MEASURED, 'claude-opus-5-5[1m]', PEAK_AT)
const offTurn = priceTurn(MEASURED, 'claude-opus-5-5[1m]', OFF_PEAK_AT)

check('measured turn prices at peak', () => assert.ok(peakTurn && peakTurn.cny > 0))
check('peak is flagged', () => assert.equal(peakTurn.peak, true))
check('off-peak is flagged', () => assert.equal(offTurn.peak, false))
check('off-peak is exactly half of peak', () => {
  // The published table is a clean 2x, so this catches a typo in either column.
  assert.ok(Math.abs(peakTurn.cny - offTurn.cny * 2) < 1e-9, `${peakTurn.cny} vs ${offTurn.cny}`)
})
check('cache reads are their own bucket, not input', () => {
  assert.equal(peakTurn.breakdown.cacheHitTokens, 68736)
  assert.equal(peakTurn.breakdown.cacheMissTokens, 10831)
  // pro peak: 10831*9 + 68736*0.3 + 536*27 = 97,479 + 20,620.8 + 14,472 = 132,571.8 / 1e6
  assert.ok(Math.abs(peakTurn.cny - 0.1325718) < 1e-9, `got ${peakTurn.cny}`)
})
check('folding cache into input would overstate by >5x', () => {
  // Measured ratio is 5.4x on this turn (0.7161 naive vs 0.1326 real): the cache bucket is what
  // keeps a long-context turn affordable, so a refactor that merges it is a real regression.
  const naive = (10831 + 68736) * DEEPSEEK_RATES['deepseek-v4-pro'].peak.cacheMiss / 1e6
  assert.ok(naive / peakTurn.cny > 5, `naive ${naive} vs real ${peakTurn.cny}`)
})
check('cache write is billed as a miss', () => {
  const withWrite = priceTurn({ ...MEASURED, cacheCreationTokens: 1000 }, 'claude-opus-5-5[1m]', PEAK_AT)
  const expected = peakTurn.cny + (1000 * 9) / 1e6
  assert.ok(Math.abs(withWrite.cny - expected) < 1e-9, `${withWrite.cny} vs ${expected}`)
})
check('flash is cheaper than pro for the same turn', () => {
  const flash = priceTurn(MEASURED, 'claude-sonnet-5', PEAK_AT)
  assert.ok(flash.cny < peakTurn.cny, `${flash.cny} !< ${peakTurn.cny}`)
})
check('zero usage costs zero', () => {
  const free = priceTurn({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 }, 'claude-sonnet-5', PEAK_AT)
  assert.equal(free.cny, 0)
})
check('missing usage object does not throw', () => {
  assert.equal(priceTurn(undefined, 'claude-sonnet-5', PEAK_AT).cny, 0)
})
check('unpriced model returns null, not zero', () => assert.equal(priceTurn(MEASURED, 'gpt-9', PEAK_AT), null))

console.log('timeline pricing honours per-turn rate boundaries')
const events = [
  { kind: 'text', at: PEAK_AT },
  { kind: 'result', at: PEAK_AT, usage: MEASURED },
  { kind: 'result', at: OFF_PEAK_AT, usage: MEASURED },
  { kind: 'result', at: PEAK_AT, usage: { inputTokens: 5, outputTokens: 5, cacheReadTokens: 0 } },
]
const timeline = priceEvents(events, 'claude-opus-5-5[1m]')
check('non-result events are ignored', () => assert.equal(timeline.pricedTurns, 3))
check('total is the sum of per-turn rates', () => {
  // ONE peak measured turn, ONE off-peak measured turn, ONE tiny peak turn.
  const small = (5 * 9 + 5 * 27) / 1e6
  const expected = peakTurn.cny + offTurn.cny + small
  assert.ok(Math.abs(timeline.totalCny - expected) < 1e-9, `${timeline.totalCny} vs ${expected}`)
})
check('a boundary-spanning session is NOT priced at one rate', () => {
  const small = (5 * 9 + 5 * 27) / 1e6
  const allAtPeak = peakTurn.cny * 2 + small
  assert.ok(timeline.totalCny < allAtPeak, `off-peak turn was billed at the peak rate: ${timeline.totalCny} !< ${allAtPeak}`)
})
check('per-model totals are reported', () => {
  assert.equal(timeline.perModel.length, 1)
  assert.equal(timeline.perModel[0].model, 'deepseek-v4-pro')
  assert.equal(timeline.perModel[0].turns, 3)
})
check('unpriced turns are counted, not silently dropped', () => {
  const mixed = priceEvents(
    [{ kind: 'result', at: PEAK_AT, usage: MEASURED }],
    'gpt-9',
  )
  assert.equal(mixed.pricedTurns, 0)
  assert.equal(mixed.unpricedTurns, 1)
  assert.equal(mixed.priced, false)
})
check('empty timeline is unpriced, not zero-cost', () => {
  const empty = priceEvents([], 'claude-opus-5-5[1m]')
  assert.equal(empty.priced, false)
  assert.equal(empty.totalCny, 0)
})

console.log('mid-session model switch does not rewrite an earlier turn')
// A session starts on opus (pro), the user switches to a sonnet-class model (flash), then runs
// another turn. The bridge stamps each turn with the model that ran it, so the first turn must stay
// at pro rates no matter what the session's CURRENT model is.
const sonnetTurn = priceTurn(MEASURED, 'claude-sonnet-5', PEAK_AT)
const switched = [
  { kind: 'result', at: PEAK_AT, usage: MEASURED, model: 'claude-opus-5-5[1m]' },
  { kind: 'result', at: PEAK_AT, usage: MEASURED, model: 'claude-sonnet-5' },
]
check('per-event models are priced independently', () => {
  // The session-level fallback is deliberately the CHEAP model: if the per-event stamp were
  // ignored, the total would come out as 2x flash and this assertion would fail.
  const mixed = priceEvents(switched, 'claude-sonnet-5')
  const expected = peakTurn.cny + sonnetTurn.cny
  assert.ok(Math.abs(mixed.totalCny - expected) < 1e-9, `${mixed.totalCny} vs ${expected}`)
})
check('per-model totals split across the switch', () => {
  const mixed = priceEvents(switched, 'claude-sonnet-5')
  assert.equal(mixed.perModel.length, 2)
  const byModel = Object.fromEntries(mixed.perModel.map((entry) => [entry.model, entry.turns]))
  assert.deepEqual(byModel, { 'deepseek-v4-pro': 1, 'deepseek-flash': 1 })
})
check('a switch is not priced at the newest model alone', () => {
  const mixed = priceEvents(switched, 'claude-sonnet-5')
  assert.ok(mixed.totalCny > sonnetTurn.cny * 2, 'earlier pro turn was repriced at flash rates')
})
check('an unstamped turn still falls back to the session model', () => {
  const legacy = priceEvents([{ kind: 'result', at: PEAK_AT, usage: MEASURED }], 'claude-opus-5-5[1m]')
  assert.ok(Math.abs(legacy.totalCny - peakTurn.cny) < 1e-9)
})

console.log('user-supplied rate tables (other vendors)')
// Measured before this existed: 16 of 16 common qwen / glm / kimi / step / spark names were
// unpriced, so the cost row vanished for anyone not on DeepSeek.
const QWEN = {
  id: 'qwen',
  match: 'qwen',
  label: '通义千问',
  cacheMiss: 2.4,
  cacheHit: 0.24,
  output: 9.6,
}

check('a vendor with no table stays unpriced', () => {
  assert.equal(priceTurn(MEASURED, 'qwen-max', OFF_PEAK_AT), null)
  assert.equal(priceTurn(MEASURED, 'qwen-max', OFF_PEAK_AT, { tables: [] }), null)
})
check('a matching table prices the model', () => {
  const priced = priceTurn(MEASURED, 'qwen-max', OFF_PEAK_AT, { tables: [QWEN] })
  // 10831*2.4 + 68736*0.24 + 536*9.6 = 25,994.4 + 16,496.64 + 5,145.6 = 47,636.64 / 1e6
  assert.ok(Math.abs(priced.cny - 0.04763664) < 1e-9, `got ${priced.cny}`)
})
check('matching is case-insensitive and substring-based', () => {
  for (const name of ['qwen-max', 'QWEN-Plus', 'qwen3-max', 'aliyun/qwen-turbo']) {
    assert.ok(priceTurn(MEASURED, name, OFF_PEAK_AT, { tables: [QWEN] }), `${name} was not matched`)
  }
})
check('a non-matching model is still unpriced', () => {
  assert.equal(priceTurn(MEASURED, 'glm-4.6', OFF_PEAK_AT, { tables: [QWEN] }), null)
})
check('a flat-rate table does NOT get peak pricing', () => {
  // This is the correctness point: isPeak() describes DeepSeek's window. Applying it to a vendor
  // that bills flat would silently DOUBLE every price during Chinese business hours.
  const atPeak = priceTurn(MEASURED, 'qwen-max', PEAK_AT, { tables: [QWEN] })
  const atOff = priceTurn(MEASURED, 'qwen-max', OFF_PEAK_AT, { tables: [QWEN] })
  assert.equal(atPeak.cny, atOff.cny)
  assert.equal(atPeak.peak, false)
  assert.equal(atPeak.timeOfDay, false)
})
check('a table can opt into a peak multiplier', () => {
  const withPeak = { ...QWEN, peakMultiplier: 2 }
  const atPeak = priceTurn(MEASURED, 'qwen-max', PEAK_AT, { tables: [withPeak] })
  const atOff = priceTurn(MEASURED, 'qwen-max', OFF_PEAK_AT, { tables: [withPeak] })
  assert.ok(Math.abs(atPeak.cny - atOff.cny * 2) < 1e-9)
  assert.equal(atPeak.peak, true)
  assert.equal(atPeak.timeOfDay, true)
})
check('a user table overrides the built-in DeepSeek rates', () => {
  const override = { id: 'mine', match: 'deepseek-flash', label: '我的价目', cacheMiss: 0, cacheHit: 0, output: 0 }
  const priced = priceTurn(MEASURED, 'deepseek-flash', OFF_PEAK_AT, { tables: [override] })
  assert.equal(priced.cny, 0)
  assert.equal(priced.source, 'custom')
})
check('built-in pricing is marked as built-in', () => {
  assert.equal(priceTurn(MEASURED, 'claude-sonnet-5', OFF_PEAK_AT).source, 'builtin')
})
check('a table with an empty match applies to everything', () => {
  const catchAll = { id: 'any', match: '', label: '兜底', cacheMiss: 1, cacheHit: 0.1, output: 1 }
  assert.ok(priceTurn(MEASURED, 'some-unknown-model', OFF_PEAK_AT, { tables: [catchAll] }))
})
check('custom tables flow through a whole timeline', () => {
  const timeline = priceEvents(
    [
      { kind: 'result', at: OFF_PEAK_AT, usage: MEASURED, model: 'qwen-max' },
      { kind: 'result', at: OFF_PEAK_AT, usage: MEASURED, model: 'glm-4.6' },
    ],
    'qwen-max',
    undefined,
    { tables: [QWEN, { id: 'glm', match: 'glm', label: '智谱', cacheMiss: 1, cacheHit: 0.1, output: 2 }] },
  )
  assert.equal(timeline.pricedTurns, 2)
  assert.equal(timeline.priced, true)
  assert.equal(timeline.usesTimeOfDay, false)
  assert.deepEqual(
    timeline.perModel.map((m) => m.model).sort(),
    ['glm', 'qwen'],
  )
})
check('usesTimeOfDay is true only when a rate really varies', () => {
  const flat = priceEvents([{ kind: 'result', at: PEAK_AT, usage: MEASURED, model: 'qwen-max' }], 'qwen-max', undefined, { tables: [QWEN] })
  const timed = priceEvents([{ kind: 'result', at: PEAK_AT, usage: MEASURED }], 'claude-sonnet-5')
  assert.equal(flat.usesTimeOfDay, false)
  assert.equal(timed.usesTimeOfDay, true)
})

console.log(`\n${passed} checks passed, exit=${process.exitCode ?? 0}`)
console.log(`measured turn: peak CNY ${peakTurn.cny.toFixed(4)} / off-peak CNY ${offTurn.cny.toFixed(4)}`)
