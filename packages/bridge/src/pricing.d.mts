/**
 * Types for the bridge's pricing module, which the sidebar imports directly so the UI and
 * `GET /api/sessions/:id/cost` can never disagree about the arithmetic.
 *
 * The module itself is plain ESM JavaScript (`packages/bridge/src/pricing.mjs`) because the bridge
 * runs it unbundled under node. Declaring its surface here is what lets `vue-tsc` check the call
 * sites without converting the bridge to TypeScript.
 */

/** CNY per 1M tokens for one rate window. */
export interface RateRow {
  cacheHit: number
  cacheMiss: number
  output: number
}

export interface ModelRates {
  label: string
  offPeak: RateRow
  peak: RateRow
}

export interface TurnBreakdown {
  cacheMissTokens: number
  cacheHitTokens: number
  outputTokens: number
  rate: RateRow
}

export interface PricedTurn {
  cny: number
  model: string
  label: string
  peak: boolean
  /** 'custom' when a user-supplied table priced this turn, 'builtin' for the shipped table. */
  source: 'custom' | 'builtin'
  /** False when the rate does not vary by time of day, so a UI need not claim a basis. */
  timeOfDay: boolean
  breakdown: TurnBreakdown
}

export interface PricedModelTotal {
  model: string
  label: string
  cny: number
  turns: number
}

export interface PricedTimeline {
  totalCny: number
  pricedTurns: number
  unpricedTurns: number
  perModel: PricedModelTotal[]
  /** False when nothing could be priced, so the UI says "unknown" instead of "0.00". */
  priced: boolean
  /** True only when a priced turn's rate actually varies by time of day. */
  usesTimeOfDay: boolean
}

/**
 * A user-supplied price row, in CNY per 1,000,000 tokens.
 *
 * `match` is a case-insensitive substring of the model name; empty matches everything. Custom rows
 * are consulted BEFORE the built-in table, so they can also override DeepSeek's numbers.
 */
export interface CustomPriceTable {
  id: string
  match: string
  label: string
  cacheMiss: number
  cacheHit: number
  output: number
  peakMultiplier?: number
}

export interface PriceOptions {
  tables?: CustomPriceTable[]
}

export interface Usage {
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheCreationTokens: number
}

/** A minimal event shape: only what pricing reads. */
export interface PriceableEvent {
  kind: string
  at?: number
  usage?: Partial<Usage>
  model?: string | null
}

export declare const DEEPSEEK_RATES: Record<string, ModelRates>

/** Map a CLI-reported model name to the DeepSeek model the relay actually bills. */
export declare function billedModel(reportedModel: string | null | undefined): string | null

/** Whether `at` falls inside DeepSeek's peak window, in Beijing time. */
export declare function isPeak(at?: number): boolean

/** Price one turn; null when no table covers the model. */
export declare function priceTurn(
  usage: Partial<Usage> | undefined,
  model: string | null | undefined,
  at?: number,
  options?: PriceOptions,
): PricedTurn | null

/** Price a whole timeline, honouring per-turn rate and model boundaries. */
export declare function priceEvents(
  events: PriceableEvent[],
  model?: string | null,
  fallbackAt?: number,
  options?: PriceOptions,
): PricedTimeline
