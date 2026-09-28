/**
 * What happens to cost accounting when the endpoint is NOT DeepSeek?
 *
 * The question was concrete — qwen / glm / kimi / 阶跃星辰 / 讯飞星火 — so this measures the answer
 * instead of reasoning about it. Two things are checked:
 *
 *   1. whether a turn on such a model is priced at all, and
 *   2. what the UI is told, because "shows nothing" and "shows ¥0.00" are very different claims.
 *
 * Run: node _probe/pricing-other-vendors.mjs
 */
import { billedModel, priceTurn, priceEvents, DEEPSEEK_RATES } from '../packages/bridge/src/pricing.mjs'

/** Model names a user would plausibly type for each vendor, in the vendors' own naming. */
const VENDORS = [
  ['阿里通义千问', ['qwen-max', 'qwen-plus', 'qwen3-max', 'qwen-turbo']],
  ['智谱 GLM', ['glm-4.6', 'glm-4-plus', 'glm-z1-air']],
  ['月之暗面 Kimi', ['kimi-k2-0905-preview', 'moonshot-v1-128k', 'kimi-latest']],
  ['阶跃星辰', ['step-2-16k', 'step-3', 'step-1v-8k']],
  ['讯飞星火', ['spark-4.0-ultra', 'generalv3.5', '4.0Ultra']],
  ['DeepSeek（对照）', ['deepseek-chat', 'deepseek-v4-pro', 'deepseek-flash']],
]

const MEASURED = { inputTokens: 10831, outputTokens: 536, cacheReadTokens: 68736, cacheCreationTokens: 0 }
const AT = Date.parse('2026-09-25T14:00:00Z') // off-peak, so the comparison is rate-only

console.log('built-in rate tables:', Object.keys(DEEPSEEK_RATES).join(', '))
console.log('')

let unpriced = 0
let priced = 0

for (const [vendor, models] of VENDORS) {
  console.log(`${vendor}`)
  for (const model of models) {
    const billed = billedModel(model)
    const turn = priceTurn(MEASURED, model, AT)
    if (turn) priced++
    else unpriced++
    console.log(
      `  ${model.padEnd(26)} billedModel=${String(billed).padEnd(16)} ${
        turn ? `¥${turn.cny.toFixed(6)}` : '未计价 (null)'
      }`,
    )
  }
}

console.log('')
console.log(`priced: ${priced}   unpriced: ${unpriced}`)

// The UI-facing consequence: what does a whole session look like when nothing can be priced?
const events = [
  { kind: 'result', at: AT, usage: MEASURED, model: 'qwen-max' },
  { kind: 'result', at: AT, usage: MEASURED, model: 'glm-4.6' },
]
const timeline = priceEvents(events, 'qwen-max')
console.log('')
console.log('a session on qwen-max + glm-4.6 reports:')
console.log(`  priced=${timeline.priced}  pricedTurns=${timeline.pricedTurns}  unpricedTurns=${timeline.unpricedTurns}  totalCny=${timeline.totalCny}`)
console.log('')
console.log('=> the sidebar hides the 费用 row and, if any turn WAS priced, appends "N 轮未计价".')
console.log('=> it never shows ¥0.00 for these, because zero would be a claim we cannot support.')
