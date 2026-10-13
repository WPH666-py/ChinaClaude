/**
 * Types for the bridge's context summariser, which the page imports directly.
 *
 * Same reason as `pricing.d.mts`: the module is plain ESM JavaScript because the bridge runs it
 * unbundled under node, and the page imports THE SAME FILE so the window and the sidebar cannot
 * count tokens differently. Declaring the surface here is what lets `vue-tsc` check that import
 * without converting the bridge to TypeScript.
 */

/** Display default used only until a real window size is known; the advice says so out loud. */
export declare const DEFAULT_CONTEXT_WINDOW: number

/** One event, as far as counting cares: a result frame carries the usage numbers. */
export interface ContextEvent {
  kind: string
  at?: number
  /** The per-turn identity used for de-duplication; absent on older frames. */
  seq?: number
  model?: string | null
  usage?: {
    inputTokens?: number
    outputTokens?: number
    cacheReadTokens?: number
    cacheCreationTokens?: number
  } | null
}

export interface ContextSummary {
  /** `turns > 0`: false means there was nothing to count, not that the count is zero. */
  ok: boolean
  turns: number
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  total: number
  lastModel: string | null
  /** The largest single turn, because an average hides the one 60k-token paste. */
  peaks: { input: number; output: number; cacheRead: number }
  firstAt: number | null
  lastAt: number | null
}

export interface ContextPressure {
  ok: boolean
  /** Newest turn's input + cache-read tokens; cache WRITE is excluded (see the module). */
  used: number
  window: number
  /** Not clamped: a prompt over the window stays visible as over 1. */
  ratio: number
  level: 'calm' | 'watch' | 'tight'
  advice: string
}

/** `1234` -> `'1.2k'`; hand-rolled rather than `Intl`, and total for non-finite input. */
export declare function formatTokens(value: number): string

/** Fold a session's event timeline into token totals, de-duplicating re-delivered frames. */
export declare function summarizeEvents(events: ContextEvent[] | undefined | null): ContextSummary

/** How full the window looks, with a Chinese sentence saying what to do about it. */
export declare function estimateContextPressure(options?: {
  events?: ContextEvent[] | null
  contextWindow?: number | null
}): ContextPressure
