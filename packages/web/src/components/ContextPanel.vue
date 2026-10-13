<script setup lang="ts">
/**
 * 上下文管理 — token totals, the live window pressure, and the one action that fixes it.
 *
 * WHY THIS IS A WINDOW RATHER THAN A SIDEBAR ROW: the sidebar can afford one number ("¥0.42"), but
 * the decision this feature exists for needs four columns at once — how much came IN, how much went
 * OUT, how much was served from cache, and which single turn was the expensive one. Compressing on
 * the wrong reading wastes the cache prefix; compressing on the right one is the cheapest action in
 * the app. So the numbers and the 压缩上下文 button live together, and the panel says out loud what
 * the numbers mean rather than leaving the user to infer it.
 *
 * The fold itself is `../../bridge/src/context.mjs` — the same module the bridge could use, so the
 * page and the bridge can never disagree about how full a conversation is.
 */
import { computed, onMounted, ref, watch } from 'vue'
import ShellDialog from './ShellDialog.vue'
/**
 * `../../../bridge/src/...` and not the `../../bridge/src/...` App.vue uses: App.vue sits at `src/`,
 * this file one level deeper in `src/components/`. The same relative specifier here would resolve to
 * `packages/web/bridge/src/...`, which does not exist — and it fails for `pricing.mjs` too, which is
 * how the depth was confirmed rather than assumed.
 *
 * `context.mjs` now ships a `.d.mts` companion (`packages/bridge/src/context.d.mts`), exactly like
 * `pricing.mjs`, so the import below is typed rather than suppressed. The typed seam further down
 * (`ContextSummary`, `ContextPressure`) is kept because the declaration file is a plain surface
 * description: it cannot know that this panel's own narrow reads are the only ones it performs.
 */
import { DEFAULT_CONTEXT_WINDOW, estimateContextPressure, formatTokens, summarizeEvents } from '../../../bridge/src/context.mjs'
import { isPeak, priceTurn } from '../../../bridge/src/pricing.mjs'
import type { BridgeEvent } from '../types'

const props = defineProps<{
  /** The session timeline the app is rendering, in arrival order. */
  events: BridgeEvent[]
  /**
   * The priced session total the sidebar shows, normalised to one number plus its basis.
   *
   * Passed in rather than recomputed so this window and the sidebar agree by construction; null
   * means nothing has been priced yet, which renders as "还没有用量" and never as ¥0.00.
   */
  cost: { cost: number; currency?: string; usesTimeOfDay?: boolean } | null
  sessionId: string | null
  /** Model context from the session: `window` when a real context size is known, `model` as fallback. */
  modelContext?: { window?: number; model?: string } | null
}>()

const emit = defineEmits<{ (e: 'close'): void }>()

/* ------------------------------------------------------------------ bridge client -- */

/**
 * Bridge base URL, resolved the same way `composables/useBridge.ts` resolves it: an injected shell
 * value wins, then the `?bridge=` override, then the dev proxy (empty base) or the packaged default.
 *
 * Duplicated instead of imported on purpose: `useBridge` owns the SSE stream and the session list,
 * so calling it here would start a SECOND stream and a second copy of the app's state just to learn
 * one URL.
 */
function resolveBaseUrl(): string {
  const injected = (globalThis as Record<string, unknown>).__CCCN_BRIDGE_URL__
  if (typeof injected === 'string' && injected.length > 0) return injected.replace(/\/$/, '')
  const param = new URLSearchParams(location.search).get('bridge')
  if (param) return param.replace(/\/$/, '')
  // vite dev proxies /api, so an empty base is correct there.
  return import.meta.env.DEV ? '' : 'http://127.0.0.1:43130'
}

const baseUrl = resolveBaseUrl()

/** The `error` string a bridge rejection carries, falling back to the raw body. */
function errorFrom(body: string): string {
  try {
    const parsed = JSON.parse(body) as { error?: unknown }
    if (typeof parsed.error === 'string' && parsed.error.length > 0) return parsed.error
  } catch {
    // Not JSON — the raw body is the only thing the bridge said, so report that.
  }
  return body.slice(0, 200).trim()
}

/* ----------------------------------------------------------------------- the fold -- */

/**
 * The surface of `context.mjs` this panel reads, declared here because the import above had to be
 * suppressed: with no `.d.mts` beside the module, TypeScript would otherwise treat every result as
 * `any` and a typo like `summary.peaks.inpt` would sail through the template unchecked.
 *
 * Only the fields the panel uses are named — a second complete copy of the module's shapes would be
 * one more thing to keep in step.
 */
interface ContextSummary {
  ok: boolean
  turns: number
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  total: number
  lastModel: string | null
  peaks: { input: number; output: number; cacheRead: number }
  firstAt: number | null
  lastAt: number | null
}

interface ContextPressure {
  ok: boolean
  used: number
  window: number
  ratio: number
  level: 'calm' | 'watch' | 'tight'
  advice: string
}

const summary = computed<ContextSummary>(() => summarizeEvents(props.events) as ContextSummary)

const pressure = computed<ContextPressure>(() =>
  estimateContextPressure({
    events: props.events,
    contextWindow: props.modelContext?.window,
  }) as ContextPressure,
)

/** Whether the window size is a real reading or the display default. */
const windowKnown = computed(() => {
  const value = Number(props.modelContext?.window)
  return Number.isFinite(value) && value > 0
})

/**
 * Whether a turn is in flight, read from the timeline rather than from session state.
 *
 * The bridge pushes a `user` event when it hands a message to the CLI child and a `result` event
 * when the turn ends, so "the newest of those two is a `user`" means the CLI has not answered yet.
 * `closed`/`error`/`init` also end the wait: nothing more is coming from that turn. This is an
 * inference from data the panel already has, so it costs no extra request and stays correct for a
 * session opened in another window.
 */
const turnRunning = computed(() => {
  for (let i = props.events.length - 1; i >= 0; i -= 1) {
    const kind = props.events[i]?.kind
    if (kind === 'user') return true
    if (kind === 'result' || kind === 'closed' || kind === 'error' || kind === 'init') return false
  }
  return false
})

const LEVEL_LABEL: Record<string, string> = { calm: '宽松', watch: '注意', tight: '紧张' }

/** The gauge never draws past its track, but `ratio` stays unclamped so an overflow is visible. */
const barWidth = computed(() => `${Math.min(100, Math.max(0, pressure.value.ratio * 100))}%`)

/** Local clock time; `toLocaleTimeString` would answer differently per machine and per locale. */
function clock(at: number | undefined): string {
  if (typeof at !== 'number' || !Number.isFinite(at)) return '—'
  const date = new Date(at)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
}

/**
 * Per-turn CNY with enough precision to be TRUE.
 *
 * Four decimals, because a turn costs a fraction of a jiao: at flash's off-peak miss rate a 400-token
 * turn is ¥0.0004, and rounding to cents would print ¥0.00 — a rounding artefact that reads as "this
 * turn was free", which is the opposite of what the column is for.
 */
function cny(value: number): string {
  return `¥${value.toFixed(4)}`
}

/**
 * A SESSION-level amount, at the precision the sidebar uses for the same number: four decimals only
 * while it is under one cent, else two. Mirroring that rule is what stops one amount from being
 * shown two ways in two windows.
 */
function money(value: number): string {
  if (value > 0 && value < 0.01) return `¥${value.toFixed(4)}`
  return `¥${value.toFixed(2)}`
}

/**
 * The priced total, read from EITHER shape the caller can hand over.
 *
 * This prop is specified as `{ cost: number }`, but App.vue's own computed is the sidebar's
 * `PricedTimeline` (`{ totalCny, priced, usesTimeOfDay, … }`), and that is what actually arrives
 * through PluginManagerPanel today — typecheck reports it as a mismatch in App.vue. Reading only
 * `cost.cost` would then be `undefined`, and calling `.toFixed` on it would throw inside the render
 * and blank the window. So: accept both, and return null (which renders as 尚未计价) when neither is
 * a number, because "no price" is a claim this panel can support and a crash is not.
 */
const pricedTotal = computed<number | null>(() => {
  const value = props.cost as { cost?: unknown; totalCny?: unknown; priced?: unknown } | null
  // A priced timeline that explicitly says nothing could be priced must not render as ¥0.00.
  if (value?.priced === false) return null
  for (const candidate of [value?.cost, value?.totalCny]) {
    const n = Number(candidate)
    if (Number.isFinite(n)) return n
  }
  return null
})

/**
 * The identity `context.mjs` folds by, repeated here: `seq` when the bridge stamped one (it is the
 * monotonic per-session cursor), else the frame's own fingerprint.
 *
 * Repeated rather than exported because the module publishes only the aggregates — but it MUST match,
 * or the table would list a re-delivered turn twice while the totals above it counted it once.
 */
function turnIdentity(event: BridgeEvent): string {
  if (typeof event.seq === 'number' && event.seq > 0) return `s${event.seq}`
  const usage = event.usage
  return [
    'f',
    event.at ?? '',
    usage?.inputTokens ?? '',
    usage?.outputTokens ?? '',
    usage?.cacheReadTokens ?? '',
    usage?.cacheCreationTokens ?? '',
    event.model ?? '',
  ].join('|')
}

interface TurnRow {
  /** 1-based position in the session, so a sliced table still numbers turns absolutely. */
  n: number
  at: number
  model: string | null
  input: number
  output: number
  cacheRead: number
  /** null when no table covers the model — shown as 未计价, never as ¥0. */
  cny: number | null
}

const turnRows = computed<TurnRow[]>(() => {
  const seen = new Set<string>()
  const rows: TurnRow[] = []
  for (const event of props.events) {
    if (event.kind !== 'result') continue
    const key = turnIdentity(event)
    if (seen.has(key)) continue
    seen.add(key)
    // Priced per turn and at the turn's own timestamp: DeepSeek's peak window makes the TIME part of
    // the rate, and a mid-session model switch makes the MODEL part of it.
    const model = event.model ?? props.modelContext?.model ?? null
    const priced = priceTurn(event.usage, model, event.at)
    rows.push({
      n: rows.length + 1,
      at: event.at,
      model,
      input: event.usage?.inputTokens ?? 0,
      output: event.usage?.outputTokens ?? 0,
      cacheRead: event.usage?.cacheReadTokens ?? 0,
      cny: priced === null ? null : priced.cny,
    })
  }
  return rows
})

/** Newest first, capped: a 300-turn session would otherwise push the totals off the screen. */
const SHOWN_TURNS = 40
const visibleTurns = computed(() => turnRows.value.slice(-SHOWN_TURNS).reverse())
const hiddenTurns = computed(() => Math.max(0, turnRows.value.length - SHOWN_TURNS))

/** The basis label, gated on `usesTimeOfDay` exactly like App.vue's `costBasis`. */
const basisLabel = computed(() => {
  if (!props.cost?.usesTimeOfDay) return '单价不随时段变化'
  return isPeak() ? '高峰时段价' : '空闲时段价'
})

/* ----------------------------------------------------------- the two bridge actions -- */

/** What the bridge answered the last time we asked, verbatim. */
const compactAnswer = ref<{ ok: boolean; text: string; hint: string } | null>(null)
const sending = ref(false)

/** Why 压缩上下文 is unavailable, or null when it can be pressed. */
const compactBlocked = computed(() => {
  if (!props.sessionId) return '需要先打开一个会话：压缩指令要发给那个会话的 CLI 子进程。'
  if (turnRunning.value) return '当前有回合在跑，桥接会用 409 拒绝；等这一轮结束再点。'
  return null
})

async function compact(): Promise<void> {
  const sessionId = props.sessionId
  if (!sessionId || compactBlocked.value !== null) return
  sending.value = true
  compactAnswer.value = null
  try {
    const response = await fetch(`${baseUrl}/api/sessions/${encodeURIComponent(sessionId)}/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: '/compact' }),
    })
    const body = await response.text().catch(() => '')
    if (response.status === 202) {
      compactAnswer.value = {
        ok: true,
        text: `桥接已受理（HTTP 202）：/compact 已交给会话，压缩过程会作为事件出现在时间线里。`,
        hint: '',
      }
      return
    }
    // The bridge's own words, not a guess: 409 means it refused, and WHY matters — a turn still
    // running is the common case and the fix is "wait", not "retry harder".
    const reason = errorFrom(body)
    const hints: Record<number, string> = {
      400: '被拒原因：指令为空（本面板固定发送 /compact，出现即说明桥接版本不匹配）。',
      404: '被拒原因：会话已不存在——它可能已被关闭或删除。',
      409: '被拒原因：会话正在跑一轮，桥接不排队。等这一轮结束再点一次。',
    }
    compactAnswer.value = {
      ok: false,
      text: `桥接拒绝（HTTP ${response.status}）：${reason || '未给出原因'}`,
      hint: hints[response.status] ?? '',
    }
  } catch (problem) {
    compactAnswer.value = {
      ok: false,
      text: `无法连接桥接：${problem instanceof Error ? problem.message : String(problem)}`,
      hint: '桥接进程可能没有在运行；这个窗口读到的数字仍来自本地事件流。',
    }
  } finally {
    sending.value = false
  }
}

interface BridgeCost {
  cost?: { totalCny?: number; pricedTurns?: number; unpricedTurns?: number; priced?: boolean }
  model?: string | null
  currency?: string
}

/**
 * The bridge's own priced reading of this session, fetched by 刷新 (and once on open).
 *
 * WHY IT IS WORTH A SECOND OPINION: the panel folds the array it was handed, which is the SSE
 * timeline — a client that reconnected in the middle, or a window opened late, can be missing turns
 * the bridge still has in its replay log. Fetching `/cost` compares the two, so a discrepancy is
 * visible instead of being silently averaged into one number.
 */
const bridgeCost = ref<{ total: number | null; pricedTurns: number; unpricedTurns: number; model: string | null; error: string | null } | null>(null)
const costLoading = ref(false)

async function refreshBridgeCost(): Promise<void> {
  const sessionId = props.sessionId
  if (!sessionId) {
    bridgeCost.value = null
    return
  }
  costLoading.value = true
  try {
    const response = await fetch(`${baseUrl}/api/sessions/${encodeURIComponent(sessionId)}/cost`)
    if (!response.ok) {
      bridgeCost.value = { total: null, pricedTurns: 0, unpricedTurns: 0, model: null, error: `HTTP ${response.status}` }
      return
    }
    const answer = (await response.json()) as BridgeCost
    bridgeCost.value = {
      total: answer.cost?.priced === true ? (answer.cost.totalCny ?? 0) : null,
      pricedTurns: answer.cost?.pricedTurns ?? 0,
      unpricedTurns: answer.cost?.unpricedTurns ?? 0,
      model: answer.model ?? null,
      error: null,
    }
  } catch (problem) {
    bridgeCost.value = {
      total: null,
      pricedTurns: 0,
      unpricedTurns: 0,
      model: null,
      error: problem instanceof Error ? problem.message : String(problem),
    }
  } finally {
    costLoading.value = false
  }
}

onMounted(() => void refreshBridgeCost())
// A session switch while this window is open (the cost panel can switch sessions under it) would
// otherwise leave the previous session's cross-check on screen next to the new session's numbers.
watch(() => props.sessionId, () => void refreshBridgeCost())
</script>

<template>
  <ShellDialog title="上下文" :meta="sessionId ? `会话 ${sessionId.slice(0, 8)}` : '未打开会话'" :width="760" @close="emit('close')">
    <template #actions>
      <button class="btnGhost" type="button" :disabled="costLoading" @click="refreshBridgeCost">
        {{ costLoading ? '读取中…' : '刷新' }}
      </button>
    </template>

    <!-- ------------------------------------------------------------- token bar -- -->
    <section class="ctx__block">
      <div class="ctx__blockHead">
        <h3 class="ctx__blockTitle">用量</h3>
        <span class="ctx__blockMeta">
          {{ summary.turns }} 轮 · 合计 {{ formatTokens(summary.total) }}
          <template v-if="summary.lastModel"> · {{ summary.lastModel }}</template>
        </span>
      </div>

      <div v-if="!summary.ok" class="ctx__waiting">
        这个会话还没有已完成的回合，用量为空。跑一轮之后这里会出现四个分栏。
      </div>

      <div v-else class="ctx__bar">
        <div class="ctx__cell">
          <span class="ctx__cellLabel">输入<em>（未命中缓存）</em></span>
          <span class="ctx__cellValue">{{ formatTokens(summary.input) }}</span>
          <span class="ctx__cellPeak">单轮峰值 {{ formatTokens(summary.peaks.input) }}</span>
        </div>
        <div class="ctx__cell">
          <span class="ctx__cellLabel">输出</span>
          <span class="ctx__cellValue">{{ formatTokens(summary.output) }}</span>
          <span class="ctx__cellPeak">单轮峰值 {{ formatTokens(summary.peaks.output) }}</span>
        </div>
        <div class="ctx__cell ctx__cell--cache">
          <span class="ctx__cellLabel">缓存命中</span>
          <span class="ctx__cellValue">{{ formatTokens(summary.cacheRead) }}</span>
          <span class="ctx__cellPeak">单轮峰值 {{ formatTokens(summary.peaks.cacheRead) }}</span>
        </div>
        <div class="ctx__cell">
          <span class="ctx__cellLabel">缓存写入</span>
          <span class="ctx__cellValue">{{ formatTokens(summary.cacheWrite) }}</span>
          <span class="ctx__cellPeak">按未命中计价</span>
        </div>
      </div>

      <p class="ctx__note">
        DeepSeek 端点忽略显式 cache_control，但服务端 KV 缓存照常生效 —— 所以「缓存命中」才是省钱的那一栏。
        单轮峰值比平均值有用：一次粘进来的六万 token 文件，账单和窗口都是它顶起来的。
      </p>

      <div class="ctx__priced">
        <span>本会话计价</span>
        <strong v-if="pricedTotal !== null">{{ money(pricedTotal) }}</strong>
        <strong v-else class="ctx__dim">尚未计价</strong>
        <span class="ctx__dim">{{ cost?.currency ?? 'CNY' }} · {{ basisLabel }}</span>
      </div>
    </section>

    <!-- -------------------------------------------------------------- pressure -- -->
    <section class="ctx__block">
      <div class="ctx__blockHead">
        <h3 class="ctx__blockTitle">上下文压力</h3>
        <span class="ctx__level" :class="`ctx__level--${pressure.level}`">{{ LEVEL_LABEL[pressure.level] }}</span>
      </div>

      <div class="ctx__track">
        <div class="ctx__fill" :class="`ctx__fill--${pressure.level}`" :style="{ width: barWidth }" />
      </div>

      <div class="ctx__gaugeMeta">
        <span>{{ formatTokens(pressure.used) }} / {{ formatTokens(pressure.window) }}</span>
        <span class="ctx__dim">
          最近一轮的输入 + 缓存命中 · 窗口
          {{ windowKnown ? '来自模型目录' : `未上报，按默认 ${formatTokens(DEFAULT_CONTEXT_WINDOW)} 估算` }}
        </span>
      </div>

      <p class="ctx__advice" :class="`ctx__advice--${pressure.level}`">{{ pressure.advice }}</p>

      <div class="ctx__cta">
        <button class="btnPrimary" type="button" :disabled="compactBlocked !== null || sending" @click="compact">
          {{ sending ? '发送中…' : '压缩上下文' }}
        </button>
        <span class="ctx__ctaHint">{{ compactBlocked ?? '发送 /compact 给这个会话：保留结论，丢掉已经不需要的过程。' }}</span>
      </div>

      <p v-if="compactAnswer" class="ctx__answer" :class="compactAnswer.ok ? 'ctx__answer--ok' : 'ctx__answer--bad'">
        {{ compactAnswer.text }}
        <span v-if="compactAnswer.hint" class="ctx__answerHint">{{ compactAnswer.hint }}</span>
      </p>
    </section>

    <!-- ----------------------------------------------------------- bridge check -- -->
    <section v-if="sessionId" class="ctx__block ctx__block--tight">
      <div class="ctx__blockHead">
        <h3 class="ctx__blockTitle">桥接侧核对</h3>
        <span class="ctx__blockMeta">GET /api/sessions/:id/cost</span>
      </div>
      <p v-if="bridgeCost?.error" class="ctx__dim">读取失败：{{ bridgeCost.error }}（本地折叠的数字不受影响）</p>
      <p v-else-if="bridgeCost" class="ctx__cross">
        <template v-if="bridgeCost.total !== null">
          端点计价 <strong>{{ money(bridgeCost.total) }}</strong> ·
          {{ bridgeCost.pricedTurns }} 轮已计价<template v-if="bridgeCost.unpricedTurns > 0">、{{ bridgeCost.unpricedTurns }} 轮未计价</template>
        </template>
        <template v-else>端点未能计价（模型 {{ bridgeCost.model ?? '未知' }} 不在价目表内）</template>
        <span class="ctx__dim">
          · 事件流折叠 {{ summary.turns }} 轮<template v-if="bridgeCost.pricedTurns + bridgeCost.unpricedTurns !== summary.turns">
            （与端点不一致：历史是 4000 条上限的环，或本窗口是在中途接上来的）</template>
        </span>
      </p>
    </section>

    <!-- ---------------------------------------------------------- per-turn table -- -->
    <section class="ctx__block">
      <div class="ctx__blockHead">
        <h3 class="ctx__blockTitle">逐轮明细</h3>
        <span class="ctx__blockMeta">
          最近 {{ visibleTurns.length }} 轮<template v-if="hiddenTurns > 0">（更早的 {{ hiddenTurns }} 轮未显示）</template>
        </span>
      </div>

      <div v-if="visibleTurns.length === 0" class="ctx__waiting">还没有回合。</div>

      <table v-else class="ctx__table">
        <thead>
          <tr>
            <th scope="col">轮次</th>
            <th scope="col">时间</th>
            <th scope="col" class="ctx__num">输入</th>
            <th scope="col" class="ctx__num">输出</th>
            <th scope="col" class="ctx__num">缓存命中</th>
            <th scope="col">模型</th>
            <th scope="col" class="ctx__num">费用</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="row in visibleTurns" :key="row.n">
            <td class="ctx__turn">#{{ row.n }}</td>
            <td class="ctx__dim">{{ clock(row.at) }}</td>
            <td class="ctx__num">{{ formatTokens(row.input) }}</td>
            <td class="ctx__num">{{ formatTokens(row.output) }}</td>
            <td class="ctx__num ctx__num--cache">{{ formatTokens(row.cacheRead) }}</td>
            <td class="ctx__model" :title="row.model ?? '事件上没有模型标记'">{{ row.model ?? '—' }}</td>
            <td class="ctx__num">
              <span v-if="row.cny !== null">{{ cny(row.cny) }}</span>
              <span v-else class="ctx__dim" title="该模型不在价目表内，未计入合计">未计价</span>
            </td>
          </tr>
        </tbody>
      </table>

      <p class="ctx__note">
        逐轮费用按内置 DeepSeek 价目表估算，用每轮自己的时间戳与模型 —— 高峰窗口让「什么时候跑」也进了单价。
        设置里的自定义价目只作用于侧边栏的本地计算，不改变这里的数字。
      </p>
    </section>

    <template #footer>
      <span>
        用量来自本会话的事件流（result 帧的 usage）；重复投递的同一条帧按 seq 去重，压缩前后都会重新折叠。
      </span>
    </template>
  </ShellDialog>
</template>

<style scoped>
.ctx__block {
  margin-bottom: 16px;
  padding-bottom: 14px;
  border-bottom: 0.5px solid var(--dsw-alias-border-l1);
}

.ctx__block--tight {
  padding-bottom: 8px;
}

.ctx__blockHead {
  display: flex;
  align-items: baseline;
  gap: 8px;
  margin-bottom: 9px;
}

.ctx__blockTitle {
  margin: 0;
  font-size: 12.5px;
  font-weight: 600;
}

.ctx__blockMeta {
  min-width: 0;
  overflow: hidden;
  color: var(--dsw-alias-label-caption);
  font-size: 11px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.ctx__waiting {
  padding: 8px 2px;
  color: var(--dsw-alias-label-caption);
  font-size: 12px;
}

.ctx__bar {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 8px;
}

.ctx__cell {
  display: flex;
  flex-direction: column;
  gap: 3px;
  padding: 9px 10px;
  border: 0.5px solid var(--dsw-alias-border-l1);
  border-radius: 9px;
  background: var(--dsw-alias-bg-layer-1);
}

/* The cache hit column is the one that pays for itself, so it is the one that reads as a highlight. */
.ctx__cell--cache {
  border-color: var(--dsw-alias-state-success-tertiary);
  background: var(--dsw-alias-state-success-tertiary);
}

.ctx__cellLabel {
  color: var(--dsw-alias-label-secondary);
  font-size: 11px;
}

.ctx__cellLabel em {
  color: var(--dsw-alias-label-caption);
  font-style: normal;
}

.ctx__cellValue {
  color: var(--dsw-alias-label-primary);
  font-family: var(--dsw-font-family-code);
  font-size: 17px;
  font-weight: 600;
}

.ctx__cellPeak {
  color: var(--dsw-alias-label-caption);
  font-size: 10.5px;
}

.ctx__note {
  margin: 10px 0 0;
  color: var(--dsw-alias-label-tertiary);
  font-size: 11.5px;
  line-height: 18px;
}

.ctx__priced {
  display: flex;
  align-items: baseline;
  gap: 8px;
  margin-top: 8px;
  color: var(--dsw-alias-label-secondary);
  font-size: 11.5px;
}

.ctx__priced strong {
  color: var(--dsw-alias-label-primary);
  font-family: var(--dsw-font-family-code);
  font-size: 13px;
}

.ctx__dim {
  color: var(--dsw-alias-label-caption);
}

.ctx__level {
  flex: none;
  padding: 1px 8px;
  border-radius: 999px;
  background: var(--dsw-alias-bg-layer-3);
  font-size: 10.5px;
}

.ctx__level--calm {
  background: var(--dsw-alias-state-success-tertiary);
  color: var(--dsw-alias-state-success-secondary);
}

.ctx__level--watch {
  background: var(--dsw-alias-state-warn-tertiary);
  color: var(--dsw-alias-state-warn-label);
}

.ctx__level--tight {
  background: var(--dsw-alias-interactive-bg-hover-danger);
  color: var(--dsw-alias-state-error-primary);
}

.ctx__track {
  height: 8px;
  overflow: hidden;
  border-radius: 999px;
  background: var(--dsw-alias-bg-layer-3);
}

.ctx__fill {
  height: 100%;
  border-radius: 999px;
  transition: width 0.25s ease;
}

.ctx__fill--calm {
  background: var(--dsw-alias-state-success-primary);
}

.ctx__fill--watch {
  background: var(--dsw-alias-state-warn-primary);
}

.ctx__fill--tight {
  background: var(--dsw-alias-state-error-primary);
}

.ctx__gaugeMeta {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 10px;
  margin-top: 6px;
  color: var(--dsw-alias-label-secondary);
  font-family: var(--dsw-font-family-code);
  font-size: 11.5px;
}

.ctx__advice {
  margin: 8px 0 0;
  font-size: 12px;
  line-height: 18px;
}

.ctx__advice--calm {
  color: var(--dsw-alias-state-success-secondary);
}

.ctx__advice--watch {
  color: var(--dsw-alias-state-warn-secondary);
}

.ctx__advice--tight {
  color: var(--dsw-alias-state-error-primary);
}

.ctx__cta {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 10px;
  margin-top: 11px;
}

.ctx__ctaHint {
  color: var(--dsw-alias-label-caption);
  font-size: 11px;
}

.ctx__answer {
  margin: 9px 0 0;
  padding: 8px 10px;
  border-radius: 8px;
  font-size: 11.5px;
  line-height: 17px;
}

.ctx__answer--ok {
  background: var(--dsw-alias-state-success-tertiary);
  color: var(--dsw-alias-state-success-secondary);
}

.ctx__answer--bad {
  background: var(--dsw-alias-interactive-bg-hover-danger);
  color: var(--dsw-alias-state-error-primary);
}

.ctx__answerHint {
  display: block;
  margin-top: 3px;
  opacity: 0.85;
}

.ctx__cross {
  margin: 0;
  color: var(--dsw-alias-label-secondary);
  font-size: 11.5px;
  line-height: 18px;
}

.ctx__cross strong {
  color: var(--dsw-alias-label-primary);
  font-family: var(--dsw-font-family-code);
}

.ctx__table {
  width: 100%;
  border-collapse: collapse;
  font-size: 11.5px;
}

.ctx__table th {
  padding: 5px 6px;
  border-bottom: 0.5px solid var(--dsw-alias-border-l2);
  color: var(--dsw-alias-label-caption);
  font-size: 10.5px;
  font-weight: 500;
  text-align: left;
}

.ctx__table td {
  padding: 5px 6px;
  border-bottom: 0.5px solid var(--dsw-alias-border-l1);
  font-family: var(--dsw-font-family-code);
}

.ctx__table tr:hover td {
  background: var(--dsw-alias-interactive-bg-hover);
}

.ctx__num {
  text-align: right;
}

.ctx__num--cache {
  color: var(--dsw-alias-state-success-secondary);
}

.ctx__turn {
  color: var(--dsw-alias-label-tertiary);
}

.ctx__model {
  max-width: 190px;
  overflow: hidden;
  color: var(--dsw-alias-label-secondary);
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>
