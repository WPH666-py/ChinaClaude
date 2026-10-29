<script setup lang="ts">
/**
 * 费用统计 — what every session has cost, and the rates that produced those numbers.
 *
 * WHY IT ASKS THE BRIDGE INSTEAD OF FOLDING THE EVENTS ITSELF: the sidebar already prices the OPEN
 * session locally (so its number moves with the transcript). This window answers a different
 * question — "what did everything cost" — and only the bridge can answer it for sessions this page
 * is not streaming. `GET /api/sessions/:id/cost` prices each session's own replay log, so a session
 * that was closed an hour ago still reports what it spent.
 *
 * THE TWO NUMBERS CAN LEGITIMATELY DIFFER, and the 计价依据 block says so: the route prices with the
 * built-in DeepSeek table only (`session.cost()` passes no `options.tables`), while the sidebar adds
 * the user's custom tables from settings. Rather than hide that, the panel states which table its own
 * numbers came from — a total that disagrees with the sidebar for a stated reason is a feature; a
 * silent disagreement is a bug report.
 */
import { computed, onMounted, ref } from 'vue'
import ShellDialog from './ShellDialog.vue'
/**
 * `../../../bridge/src/pricing.mjs` and not the `../../bridge/src/pricing.mjs` App.vue uses: App.vue
 * sits at `src/`, this file one level deeper in `src/components/`. The shallower specifier would
 * resolve to `packages/web/bridge/src/pricing.mjs`, which does not exist.
 *
 * The rates and the peak/off-peak rule come from that module rather than being retyped here, which is
 * the whole point: a second copy of the price table would drift from the one the bridge bills with.
 */
import { DEEPSEEK_RATES, isPeak } from '../../../bridge/src/pricing.mjs'
import type { SessionView } from '../types'

const props = defineProps<{
  /** 由设置页内嵌时不给遮罩。 */
  inline?: boolean
  /** The sidebar's list: every session the bridge knows about. */
  sessions: SessionView[]
  /** Highlighted row, and the session a click would go back to. */
  activeId?: string | null
}>()

const emit = defineEmits<{
  (e: 'close'): void
  /** Switch the app to this session. The caller owns the switch; this window only nominates. */
  (e: 'select', id: string): void
}>()

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

/* ------------------------------------------------------------------------- loading -- */

interface CostRow {
  id: string
  /** Last path segment of the working directory — the table has one line per session. */
  label: string
  cwd: string | null
  model: string | null
  /** null when nothing could be priced; the reason is in `note`, never a ¥0. */
  cny: number | null
  pricedTurns: number
  unpricedTurns: number
  /** Labels of the priced models this session used, for the 计价模型数 count. */
  models: string[]
  note: string | null
  status: SessionView['status']
}

/** What `GET /api/sessions/:id/cost` answers (see `server.mjs`), with every field optional. */
interface CostAnswer {
  cost?: {
    totalCny?: number
    pricedTurns?: number
    unpricedTurns?: number
    priced?: boolean
    perModel?: Array<{ model?: string; label?: string; cny?: number; turns?: number }>
  }
  model?: string | null
  currency?: string
}

/** Last segment of a cwd, so a long Windows path still fits one table cell. */
function shortName(cwd: string | null): string {
  if (!cwd) return '（未知目录）'
  const parts = cwd.split(/[\\/]/).filter((part) => part.length > 0)
  return parts.length > 0 ? parts[parts.length - 1] : cwd
}

/**
 * CNY at the precision the number actually needs — the SAME rule the sidebar uses, so one amount is
 * never shown two ways: under one cent needs four decimals (a short session costs a fraction of a
 * fen), anything larger is noise past two.
 */
function money(value: number): string {
  if (value > 0 && value < 0.01) return `¥${value.toFixed(4)}`
  return `¥${value.toFixed(2)}`
}

async function readOne(session: SessionView): Promise<CostRow> {
  const base = {
    id: session.id,
    label: shortName(session.cwd),
    cwd: session.cwd,
    model: session.model ?? session.resolvedModel ?? null,
    status: session.status,
  }
  try {
    const response = await fetch(`${baseUrl}/api/sessions/${encodeURIComponent(session.id)}/cost`)
    if (!response.ok) {
      // Per-session failure is contained here on purpose: one dead session must not empty a table
      // that has nine live ones in it.
      return { ...base, cny: null, pricedTurns: 0, unpricedTurns: 0, models: [], note: `未计价：读取失败（HTTP ${response.status}）` }
    }
    const answer = (await response.json()) as CostAnswer
    const cost = answer.cost ?? {}
    const model = answer.model ?? base.model
    const pricedTurns = cost.pricedTurns ?? 0
    const unpricedTurns = cost.unpricedTurns ?? 0

    if (cost.priced === true) {
      return {
        ...base,
        model,
        cny: cost.totalCny ?? 0,
        pricedTurns,
        unpricedTurns,
        models: (cost.perModel ?? []).map((entry) => entry.label ?? entry.model ?? model ?? '未知模型'),
        note: null,
      }
    }
    // `priced: false` covers two different situations and they deserve different sentences: a session
    // that never finished a turn has nothing to price, while one whose model is missing from the
    // table was billed by the endpoint and simply is not in our arithmetic.
    const note = pricedTurns + unpricedTurns === 0 ? '未计价：还没有已完成的回合' : '该模型不在价目表内，未计入合计'
    return { ...base, model, cny: null, pricedTurns, unpricedTurns, models: [], note }
  } catch (problem) {
    const message = problem instanceof Error ? problem.message : String(problem)
    return { ...base, cny: null, pricedTurns: 0, unpricedTurns: 0, models: [], note: `未计价：无法连接桥接（${message}）` }
  }
}

const rows = ref<CostRow[]>([])
const loading = ref(false)

/** The peak/off-peak label is a reading taken when the table was loaded, not a live clock. */
const peakNow = ref(isPeak())

async function load(): Promise<void> {
  loading.value = true
  peakNow.value = isPeak()
  // One request per session, in parallel: the list is small (the sidebar's own list), and a serial
  // loop would make 刷新 take a round-trip per session.
  rows.value = await Promise.all(props.sessions.map((session) => readOne(session)))
  loading.value = false
}

onMounted(() => void load())

/* ------------------------------------------------------------------------ summary -- */

const priced = computed(() => rows.value.filter((row) => row.cny !== null))
const unpriced = computed(() => rows.value.filter((row) => row.cny === null))
const totalCny = computed(() => priced.value.reduce((sum, row) => sum + (row.cny ?? 0), 0))
const pricedModelCount = computed(() => new Set(priced.value.flatMap((row) => row.models)).size)

/* --------------------------------------------------------------------------- sort -- */

const sortDir = ref<'desc' | 'asc'>('desc')

const sortedRows = computed(() =>
  [...rows.value].sort((a, b) => {
    // Unpriced rows sink in BOTH directions. An absent price is not a small one, so it must not lead
    // the table when the user asks for the cheapest — that would read as "this session is free".
    if (a.cny === null && b.cny === null) return a.label < b.label ? -1 : a.label > b.label ? 1 : 0
    if (a.cny === null) return 1
    if (b.cny === null) return -1
    return sortDir.value === 'desc' ? b.cny - a.cny : a.cny - b.cny
  }),
)

const sortArrow = computed(() => (sortDir.value === 'desc' ? '↓' : '↑'))

/* ------------------------------------------------------------------- rates block -- */

/** The current period's rates per model, read from the shipped table — never retyped here. */
const rateLines = computed(() =>
  Object.entries(DEEPSEEK_RATES).map(([key, rates]) => {
    const row = peakNow.value ? rates.peak : rates.offPeak
    return {
      key,
      label: rates.label,
      hit: row.cacheHit,
      miss: row.cacheMiss,
      out: row.output,
      // Derived, not asserted: flash discounts hits 50x and pro 30x, so a hardcoded "50x" would be
      // wrong for half the table.
      multiple: row.cacheHit > 0 ? Math.round(row.cacheMiss / row.cacheHit) : 0,
    }
  }),
)

/** Session status as a dot plus a word; `awaiting_*` is why the dot is not just busy/idle. */
const STATUS: Record<string, { label: string; tone: string }> = {
  starting: { label: '启动中', tone: 'warn' },
  ready: { label: '就绪', tone: 'ok' },
  busy: { label: '运行中', tone: 'busy' },
  awaiting_approval: { label: '待确认', tone: 'warn' },
  awaiting_dialog: { label: '待回答', tone: 'warn' },
  closed: { label: '已关闭', tone: 'off' },
  failed: { label: '失败', tone: 'bad' },
}
</script>

<template>
  <ShellDialog
    :inline="inline"
    title="费用统计"
    :meta="sessions.length > 0 ? `${sessions.length} 个会话` : '未打开会话'"
    :width="800"
    @close="emit('close')"
  >
    <template #actions>
      <button class="btnGhost" type="button" :disabled="loading" @click="load">
        {{ loading ? '读取中…' : '刷新' }}
      </button>
    </template>

    <!-- ------------------------------------------------------------------ strip -- -->
    <div class="cost__strip">
      <div class="cost__stat">
        <span class="cost__statLabel">会话数</span>
        <span class="cost__statValue">{{ rows.length }}</span>
      </div>
      <div class="cost__stat">
        <span class="cost__statLabel">合计</span>
        <span class="cost__statValue cost__statValue--money">{{ money(totalCny) }}</span>
      </div>
      <div class="cost__stat">
        <span class="cost__statLabel">计价模型数</span>
        <span class="cost__statValue">{{ pricedModelCount }}</span>
      </div>
    </div>

    <div v-if="loading && rows.length === 0" class="cost__waiting"><span class="spinner" />正在逐个会话取价…</div>

    <div v-else-if="rows.length === 0" class="cost__waiting">侧边栏里还没有会话，没有可统计的对象。</div>

    <template v-else>
      <table class="cost__table">
        <thead>
          <tr>
            <th scope="col">工作目录</th>
            <th scope="col">模型</th>
            <th scope="col" class="cost__amountHead">
              <button class="cost__sort" type="button" @click="sortDir = sortDir === 'desc' ? 'asc' : 'desc'">
                金额 {{ sortArrow }}
              </button>
            </th>
            <th scope="col">状态</th>
          </tr>
        </thead>
        <tbody>
          <tr
            v-for="row in sortedRows"
            :key="row.id"
            class="cost__row"
            :class="{ 'cost__row--active': row.id === activeId }"
            @click="emit('select', row.id)"
          >
            <th scope="row" class="cost__dir" :title="row.cwd ?? '会话没有报告工作目录'">
              <button class="cost__link" type="button" @click.stop="emit('select', row.id)">{{ row.label }}</button>
              <span v-if="row.id === activeId" class="cost__tag">当前</span>
            </th>
            <td class="cost__model" :title="row.model ?? '会话未报告模型'">{{ row.model ?? '—' }}</td>
            <td class="cost__amount">
              <span v-if="row.cny !== null" class="cost__money">{{ money(row.cny) }}</span>
              <span v-else class="cost__unpriced">{{ row.note ?? '未计价' }}</span>
              <span v-if="row.unpricedTurns > 0 && row.cny !== null" class="cost__turns">
                含 {{ row.unpricedTurns }} 轮未计价
              </span>
            </td>
            <td class="cost__status">
              <span class="cost__dot" :class="`cost__dot--${STATUS[row.status]?.tone ?? 'off'}`" />
              <span>{{ STATUS[row.status]?.label ?? row.status }}</span>
            </td>
          </tr>
        </tbody>
        <tfoot>
          <tr>
            <td colspan="2" class="cost__footLabel">合计</td>
            <td class="cost__amount cost__footTotal">{{ money(totalCny) }}</td>
            <td class="cost__footNote">
              {{ priced.length }} 个会话已计价<template v-if="unpriced.length > 0">，{{ unpriced.length }} 个未计入</template>
            </td>
          </tr>
        </tfoot>
      </table>

      <p class="cost__lead">
        金额来自桥接的逐会话取价，按每个回合自己的时间戳与模型计算。点任意一行可以切回那个会话。
      </p>
    </template>

    <!-- ------------------------------------------------------------------ basis -- -->
    <section class="cost__basis">
      <h3 class="cost__basisTitle">计价依据</h3>

      <p class="cost__basisLine">
        价目表：内置 DeepSeek 表（{{ rateLines.length }} 个模型）。本窗口取桥接的 <code>/cost</code>，桥接只按内置表计价；
        设置里的自定义价目只作用于侧边栏的本地计算 —— 两处数字因此可以合法地不一致。
      </p>

      <p class="cost__basisLine">
        当前时段：<strong>{{ peakNow ? '高峰时段' : '空闲时段' }}</strong>
        <template v-if="peakNow">（工作日 09:00–12:00 / 14:00–18:00，北京时间，单价翻倍）</template>
        <template v-else>（约为高峰价的一半）</template>
        · 按刷新时刻判定。中国法定节假日不建模：官方日历逐年变，宁可近似也不要一份过期的假日表。
      </p>

      <ul class="cost__rates">
        <li v-for="line in rateLines" :key="line.key" class="cost__rate">
          <span class="cost__rateName">{{ line.label }}</span>
          <span class="cost__rateNums">
            命中 ¥{{ line.hit.toFixed(2) }}/M · 未命中 ¥{{ line.miss.toFixed(2) }}/M · 输出 ¥{{ line.out.toFixed(2) }}/M
          </span>
          <span class="cost__rateNote">命中便宜 {{ line.multiple }}×</span>
        </li>
      </ul>

      <p class="cost__basisLine cost__basisLine--dim">
        缓存写入按未命中计价（它就是那段前缀的第一次读），而命中是服务端 KV 缓存生效后才出现的折扣栏 ——
        端点忽略显式的 cache_control，所以这一栏省下的钱是白拿的，不是客户端要来的。
      </p>
    </section>

    <template #footer>
      <span>一次请求一个会话；某个会话读不到时只把那一行标成未计价，不会让整张表失败。</span>
    </template>
  </ShellDialog>
</template>

<style scoped>
.cost__strip {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 8px;
  margin-bottom: 14px;
}

.cost__stat {
  display: flex;
  flex-direction: column;
  gap: 3px;
  padding: 9px 11px;
  border: 0.5px solid var(--dsw-alias-border-l1);
  border-radius: 9px;
  background: var(--dsw-alias-bg-layer-1);
}

.cost__statLabel {
  color: var(--dsw-alias-label-secondary);
  font-size: 11px;
}

.cost__statValue {
  color: var(--dsw-alias-label-primary);
  font-family: var(--dsw-font-family-code);
  font-size: 17px;
  font-weight: 600;
}

.cost__statValue--money {
  color: var(--dsw-alias-state-business-primary);
}

.cost__waiting {
  display: flex;
  align-items: center;
  gap: 9px;
  padding: 24px 4px;
  color: var(--dsw-alias-label-caption);
  font-size: 12.5px;
}

.cost__table {
  width: 100%;
  border-collapse: collapse;
  font-size: 12px;
}

.cost__table th {
  padding: 6px 7px;
  border-bottom: 0.5px solid var(--dsw-alias-border-l2);
  color: var(--dsw-alias-label-caption);
  font-size: 10.5px;
  font-weight: 500;
  text-align: left;
}

.cost__table td {
  padding: 7px;
  border-bottom: 0.5px solid var(--dsw-alias-border-l1);
}

.cost__row {
  cursor: pointer;
}

.cost__row:hover td,
.cost__row:hover th {
  background: var(--dsw-alias-interactive-bg-hover);
}

.cost__row--active td,
.cost__row--active th {
  background: var(--dsw-alias-interactive-bg-hover-solid);
}

.cost__dir {
  display: flex;
  align-items: center;
  gap: 7px;
  font-weight: 500;
  text-align: left;
}

.cost__link {
  max-width: 220px;
  overflow: hidden;
  color: var(--dsw-alias-label-primary);
  font-size: 12.5px;
  text-align: left;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.cost__link:hover {
  color: var(--dsw-alias-state-business-primary);
}

.cost__tag {
  flex: none;
  padding: 1px 6px;
  border-radius: 4px;
  background: var(--dsw-alias-bg-layer-3);
  color: var(--dsw-alias-label-tertiary);
  font-size: 10px;
}

.cost__model {
  max-width: 200px;
  overflow: hidden;
  color: var(--dsw-alias-label-secondary);
  font-family: var(--dsw-font-family-code);
  font-size: 11px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.cost__amountHead {
  text-align: right;
}

.cost__sort {
  color: var(--dsw-alias-label-caption);
  font-size: 10.5px;
}

.cost__sort:hover {
  color: var(--dsw-alias-label-primary);
}

.cost__amount {
  text-align: right;
}

.cost__money {
  color: var(--dsw-alias-label-primary);
  font-family: var(--dsw-font-family-code);
  font-size: 12.5px;
}

.cost__unpriced {
  color: var(--dsw-alias-label-caption);
  font-size: 10.5px;
}

.cost__turns {
  display: block;
  color: var(--dsw-alias-state-warn-secondary);
  font-size: 10px;
}

.cost__status {
  display: flex;
  align-items: center;
  gap: 6px;
  color: var(--dsw-alias-label-secondary);
  font-size: 11px;
  white-space: nowrap;
}

.cost__dot {
  width: 6px;
  height: 6px;
  flex: none;
  border-radius: 999px;
}

.cost__dot--ok {
  background: var(--dsw-alias-state-success-primary);
}

.cost__dot--busy {
  background: var(--dsw-alias-state-business-primary);
}

.cost__dot--warn {
  background: var(--dsw-alias-state-warn-primary);
}

.cost__dot--bad {
  background: var(--dsw-alias-state-error-primary);
}

.cost__dot--off {
  background: var(--dsw-alias-label-caption);
}

.cost__footLabel {
  color: var(--dsw-alias-label-secondary);
  font-size: 11.5px;
  text-align: right;
}

.cost__footTotal {
  color: var(--dsw-alias-label-primary);
  font-family: var(--dsw-font-family-code);
  font-size: 13px;
  font-weight: 600;
}

.cost__footNote {
  color: var(--dsw-alias-label-caption);
  font-size: 10.5px;
}

.cost__lead {
  margin: 10px 0 0;
  color: var(--dsw-alias-label-tertiary);
  font-size: 11.5px;
  line-height: 18px;
}

.cost__basis {
  margin-top: 16px;
  padding: 12px 13px;
  border: 0.5px solid var(--dsw-alias-border-l1);
  border-radius: 10px;
  background: var(--dsw-alias-bg-layer-1);
}

.cost__basisTitle {
  margin: 0 0 8px;
  font-size: 12.5px;
  font-weight: 600;
}

.cost__basisLine {
  margin: 0 0 7px;
  color: var(--dsw-alias-label-secondary);
  font-size: 11.5px;
  line-height: 18px;
}

.cost__basisLine--dim {
  margin-bottom: 0;
  color: var(--dsw-alias-label-caption);
}

.cost__basisLine code {
  color: var(--dsw-alias-label-tertiary);
  font-family: var(--dsw-font-family-code);
  font-size: 11px;
}

.cost__rates {
  margin: 4px 0 7px;
  padding: 0;
  list-style: none;
}

.cost__rate {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 10px;
  padding: 4px 0;
  border-bottom: 0.5px solid var(--dsw-alias-border-l1);
}

.cost__rateName {
  flex: none;
  min-width: 160px;
  font-family: var(--dsw-font-family-code);
  font-size: 11px;
}

.cost__rateNums {
  color: var(--dsw-alias-label-secondary);
  font-family: var(--dsw-font-family-code);
  font-size: 11px;
}

.cost__rateNote {
  margin-left: auto;
  color: var(--dsw-alias-state-success-secondary);
  font-size: 10.5px;
}
</style>
