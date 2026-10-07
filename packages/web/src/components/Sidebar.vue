<script setup lang="ts">
/**
 * Sidebar column, following the upstream shell geometry:
 * logo row (60px) -> New Session (38px, r12) -> nav rows (36px) -> scroll region -> foot.
 *
 * Session grouping mirrors the workspace browser's shape: sessions are grouped by their
 * working directory, and the current workspace is expanded by default.
 */
import { computed, ref } from 'vue'
import type { SessionView } from '../types'

const props = defineProps<{
  sessions: SessionView[]
  activeId: string | null
  connected: boolean
  binaryPath: string | null
  totals: { input: number; output: number; cacheRead: number }
  /**
   * Priced session cost, or null when nothing could be priced (no turn yet, or a model whose
   * rates are unknown). Null renders as an explanation, never as a bare ¥0.00 — a zero would be a
   * claim we cannot support.
   */
  cost: {
    totalCny: number
    pricedTurns: number
    unpricedTurns: number
    priced: boolean
    perModel: Array<{ model: string; label: string; cny: number; turns: number }>
  } | null
  /**
   * 'peak' / 'offPeak' when the rate genuinely varies by time of day, null otherwise.
   *
   * Null matters: most vendors bill one flat rate, and labelling that "空闲时段价" would invent a
   * reason for the number that is not true.
   */
  costBasis: string | null
  /**
   * The model and provider the open session is pointed at.
   *
   * Kept separate from cost on purpose: a session with no turns has no cost but does have a provider,
   * and the balance row belongs to that provider — so this must render before the first priced turn.
   */
  modelContext: { model: string; provider: string; unmapped: boolean } | null
  /** Formatted provider balance, or null when it could not be read. */
  balanceText: string | null
  /** Why the balance is unavailable, shown instead of hiding the row. */
  balanceError: string | null
  balanceLoading: boolean
}>()

const emit = defineEmits<{
  (e: 'new'): void
  (e: 'open', id: string): void
  (e: 'settings'): void
  (e: 'toggle-collapse'): void
  /** Remove one session. A workspace disappears with its last session. */
  (e: 'remove-session', id: string): void
  /** Remove every session under one working directory. */
  (e: 'remove-workspace', cwd: string): void
  /** Re-read the provider's account balance. */
  (e: 'refresh-balance'): void
}>()

const query = ref('')
const collapsed = ref<Set<string>>(new Set())
/** Working directory pending a delete confirmation, so a workspace cannot be wiped by one click. */
const confirmWorkspace = ref<string | null>(null)

/** Sessions that would be removed by the pending confirmation. */
const confirmCount = computed(() => {
  if (!confirmWorkspace.value) return 0
  return props.sessions.filter((session) => (session.cwd ?? '未指定目录') === confirmWorkspace.value).length
})

function confirmRemoveWorkspace() {
  if (!confirmWorkspace.value) return
  emit('remove-workspace', confirmWorkspace.value)
  confirmWorkspace.value = null
}

/** Last path segment: a full path does not fit the narrow column. */
function shortName(path: string | null): string {
  if (!path) return '未命名'
  const parts = path.split(/[\\/]/).filter(Boolean)
  return parts[parts.length - 1] ?? path
}

function statusLabel(status: SessionView['status']): string {
  switch (status) {
    case 'ready':
      return '就绪'
    case 'busy':
      return '运行中'
    case 'awaiting_approval':
      return '等待授权'
    case 'awaiting_dialog':
      return '等待选择'
    case 'starting':
      return '启动中'
    case 'failed':
      return '失败'
    default:
      return '已结束'
  }
}

/**
 * Distinguishes sessions inside one workspace.
 *
 * The CLI does not title sessions, so every row in a workspace would otherwise read the same —
 * which makes "delete this one" impossible to aim at. The creation time is the honest
 * differentiator; the ordinal makes the ordering explicit when two share a minute.
 */
function sessionLabel(group: { items: SessionView[] }, index: number, session: SessionView): string {
  const created = session.createdAt ? new Date(session.createdAt) : null
  const time = created
    ? created.toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
    : '—'
  return group.items.length > 1 ? `#${index + 1} · ${time}` : `会话 · ${time}`
}

/** Group by working directory; sessions sharing a cwd belong to one workspace. */
const groups = computed(() => {
  const needle = query.value.trim().toLowerCase()
  const byCwd = new Map<string, SessionView[]>()

  for (const session of props.sessions) {
    const key = session.cwd ?? '未指定目录'
    if (needle && !key.toLowerCase().includes(needle)) continue
    const list = byCwd.get(key)
    if (list) list.push(session)
    else byCwd.set(key, [session])
  }

  return [...byCwd.entries()].map(([cwd, items]) => ({
    cwd,
    label: shortName(cwd === '未指定目录' ? null : cwd),
    items,
  }))
})

function toggle(cwd: string) {
  const next = new Set(collapsed.value)
  if (next.has(cwd)) next.delete(cwd)
  else next.add(cwd)
  collapsed.value = next
}

function isCollapsed(cwd: string) {
  return collapsed.value.has(cwd)
}

const totalTokens = computed(() => props.totals.input + props.totals.output)

/** CNY with enough precision to be useful: a single cheap turn is well under one cent. */
const costText = computed(() => {
  const cny = props.cost?.totalCny ?? 0
  if (!props.cost?.priced) return null
  if (cny > 0 && cny < 0.01) return `¥${cny.toFixed(4)}`
  return `¥${cny.toFixed(2)}`
})

/**
 * Which vendor/model the money went to.
 *
 * Always shown, not just when a time-of-day basis applies: a bare "¥0.03" answers nothing a user
 * actually asks, and this client supports switching providers mid-session — so "which model is this
 * bill for" is a real question, not decoration.
 *
 * With more than one model in play the subtotals are listed, because a single averaged number would
 * hide exactly the thing the user is looking for: which vendor cost what.
 */
const costVendors = computed(() => {
  const rows = props.cost?.perModel ?? []
  if (rows.length === 0) return null
  const money = (cny: number) => (cny > 0 && cny < 0.01 ? `¥${cny.toFixed(4)}` : `¥${cny.toFixed(2)}`)
  if (rows.length === 1) return rows[0].label
  return rows.map((row) => `${row.label} ${money(row.cny)}`).join(' · ')
})

/** Tooltip for the balance row, naming which account it is and where it came from. */
const balanceTitle = computed(() =>
  props.modelContext
    ? `${props.modelContext.provider} 的账户余额；按需读取，不随时间自动刷新`
    : '来自当前会话所属服务商的账户余额，按需读取，不随时间自动刷新',
)

/**
 * Name the provider in the balance LABEL, not only in a tooltip.
 *
 * A bare "账户余额 ¥107.53" does not say whose money it is, and this client supports several
 * providers at once — with more than one configured, an unlabelled figure is ambiguous.
 */
const balanceLabel = computed(() => (props.modelContext ? `${props.modelContext.provider} 余额` : '账户余额'))
</script>

<template>
  <aside class="sidebar">
    <!-- logo row -->
    <div class="sidebar__logoRow">
      <div class="brand">
        <span class="brand__mark">C</span>
        <span class="brand__name">ChinaClaude</span>
      </div>
      <button class="iconButton" type="button" title="折叠侧栏" @click="$emit('toggle-collapse')">
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <rect x="2" y="3" width="12" height="10" rx="2" stroke="currentColor" stroke-width="1.4" />
          <path d="M6.5 3v10" stroke="currentColor" stroke-width="1.4" />
        </svg>
      </button>
    </div>

    <!-- new session -->
    <button class="newSession" type="button" @click="$emit('new')">
      <svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true">
        <path d="M8 3v10M3 8h10" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" />
      </svg>
      新建会话
    </button>

    <!-- nav -->
    <nav class="panelList">
      <button class="panelRow" type="button" @click="$emit('new')">
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <path d="M3 4.5h10M3 8h10M3 11.5h6" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" />
        </svg>
        <span class="panelRow__title">对话</span>
      </button>
    </nav>

    <!-- workspace / session region -->
    <div class="sectionHead">
      <span class="sectionHead__label">工作区</span>
      <div class="sectionHead__actions">
        <button class="tinyButton" type="button" title="搜索">
          <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <circle cx="7" cy="7" r="4.2" stroke="currentColor" stroke-width="1.4" />
            <path d="M10.2 10.2L13 13" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" />
          </svg>
        </button>
        <button class="tinyButton" type="button" title="排序">
          <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <path d="M4 3v10M4 13l-2-2M4 13l2-2M12 13V3M12 3l-2 2M12 3l2 2" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" />
          </svg>
        </button>
      </div>
    </div>

    <div class="region">
      <input v-model="query" class="field__input" style="margin: 0 12px 6px 4px; width: auto" placeholder="筛选会话…" spellcheck="false" />

      <div class="sessionList">
        <div v-for="group in groups" :key="group.cwd">
          <button class="panelRow" type="button" @click="toggle(group.cwd)">
            <span class="reason__caret" :class="{ 'reason__caret--open': !isCollapsed(group.cwd) }" />
            <span class="panelRow__title">{{ group.label }}</span>
            <span class="panelRow__count">{{ group.items.length }}</span>
            <!-- Removing a workspace means removing every session in it; confirm first. -->
            <span
              class="rowAction"
              role="button"
              tabindex="0"
              title="删除该工作区的全部会话"
              @click.stop="confirmWorkspace = group.cwd"
              @keydown.enter.stop="confirmWorkspace = group.cwd"
            >
              <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                <path d="M3 5h10M6.5 5V3.6h3V5M4.6 5l.6 8h5.6l.6-8" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" />
              </svg>
            </span>
          </button>

          <template v-if="!isCollapsed(group.cwd)">
            <button
              v-for="(session, index) in group.items"
              :key="session.id"
              type="button"
              class="sessionItem"
              :class="{ 'sessionItem--active': session.id === activeId }"
              @click="$emit('open', session.id)"
            >
              <div class="sessionItem__top">
                <span class="dot" :class="`dot--${session.status}`" />
                <span class="sessionItem__title">{{ sessionLabel(group, index, session) }}</span>
                <span
                  class="rowAction rowAction--tight"
                  role="button"
                  tabindex="0"
                  title="删除此会话"
                  @click.stop="$emit('remove-session', session.id)"
                  @keydown.enter.stop="$emit('remove-session', session.id)"
                >
                  <svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                    <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" />
                  </svg>
                </span>
              </div>
              <div class="sessionItem__meta">
                <span>{{ statusLabel(session.status) }}</span>
                <span class="statsPills__sep" />
                <span>{{ session.historyLength }} 事件</span>
              </div>
            </button>
          </template>
        </div>

        <div v-if="groups.length === 0" class="empty" style="padding: 28px 12px">
          {{ query ? '无匹配会话' : '暂无会话' }}
        </div>
      </div>
    </div>

    <!-- foot: usage + settings -->
    <div class="footArea">
      <div class="usageCard">
        <div class="usageCard__row">
          <span class="usageCard__label">本会话用量</span>
          <span class="usageCard__value">{{ totalTokens.toLocaleString('zh-CN') }}</span>
        </div>
        <div class="usageCard__sub">
          <span>入 {{ totals.input.toLocaleString('zh-CN') }}</span>
          <span class="statsPills__sep" />
          <span>出 {{ totals.output.toLocaleString('zh-CN') }}</span>
          <template v-if="totals.cacheRead > 0">
            <span class="statsPills__sep" />
            <span class="usageCard__accent">缓存 {{ totals.cacheRead.toLocaleString('zh-CN') }}</span>
          </template>
        </div>

        <!--
          Which model and which provider, shown as soon as a session is open.
          Deliberately NOT part of the cost block: a session that has not run a turn has no cost but
          still has a provider, and the balance below belongs to that provider — so hiding this until
          the first priced turn left a balance with no stated owner.
        -->
        <div v-if="modelContext" class="usageCard__sub usageCard__sub--wrap usageCard__model">
          <span v-if="modelContext.unmapped" class="composer__warn" title="该模型不属于任何已配置的服务商，将由端点决定">!</span>
          <span class="usageCard__vendor">{{ modelContext.model }}</span>
          <span class="statsPills__sep" />
          <span>{{ modelContext.provider }}</span>
        </div>

        <!--
          Cost. Deliberately absent until there is a priced turn: an unpriced session shows the
          reason instead of ¥0.00, because zero is a claim this client cannot back up.
        -->
        <div v-if="costText" class="usageCard__row usageCard__row--cost" :title="`按价目表计算：${costVendors ?? '内置'}`">
          <span class="usageCard__label">费用</span>
          <span class="usageCard__value usageCard__value--cost">{{ costText }}</span>
        </div>
        <div v-if="costText" class="usageCard__sub usageCard__sub--wrap">
          <!--
            The BILLED model, which the relay may have remapped: a session on `claude-sonnet-5` is
            invoiced as `DeepSeek-V4.1-Flash`. Shown whenever a cost exists, because the line above
            names what was REQUESTED and this names what was CHARGED.
          -->
          <span v-if="costVendors" class="usageCard__vendor">{{ costVendors }}</span>
          <!--
            The basis is shown ONLY when the rate really varies by time of day. Most vendors bill
            one flat rate, and calling that "空闲时段价" would invent a reason for the number.
          -->
          <template v-if="costBasis">
            <span class="statsPills__sep" />
            <span :class="{ usageCard__accent: costBasis === 'peak' }">
              {{ costBasis === 'peak' ? '高峰时段价' : '空闲时段价' }}
            </span>
          </template>
          <template v-if="cost && cost.unpricedTurns > 0">
            <span class="statsPills__sep" />
            <span style="color: var(--dsw-alias-state-warn-primary)">
              {{ cost.unpricedTurns }} 轮未计价
            </span>
          </template>
        </div>

        <!-- Provider balance, when the endpoint exposes one. -->
        <div v-if="balanceText" class="usageCard__row" :title="balanceTitle">
          <span class="usageCard__label">{{ balanceLabel }}</span>
          <span class="usageCard__value usageCard__value--balance">{{ balanceText }}</span>          <button
            class="usageCard__refresh"
            type="button"
            title="重新读取余额"
            :disabled="balanceLoading"
            @click="emit('refresh-balance')"
          >
            {{ balanceLoading ? '…' : '刷新' }}
          </button>
        </div>
        <div v-else-if="balanceError" class="usageCard__sub usageCard__sub--wrap">
          <span style="color: var(--dsw-alias-state-warn-primary)">余额不可读：{{ balanceError }}</span>
          <button class="usageCard__refresh" type="button" :disabled="balanceLoading" @click="emit('refresh-balance')">
            重试
          </button>
        </div>
      </div>

      <button class="settingsRow" type="button" @click="$emit('settings')">
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <circle cx="8" cy="8" r="2.2" stroke="currentColor" stroke-width="1.4" />
          <path d="M8 1.8v1.6M8 12.6v1.6M14.2 8h-1.6M3.4 8H1.8M12.4 3.6l-1.1 1.1M4.7 11.3l-1.1 1.1M12.4 12.4l-1.1-1.1M4.7 4.7L3.6 3.6" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" />
        </svg>
        设置
      </button>

      <div class="usageCard__sub" style="padding: 4px 8px 2px">
        <span class="dot" :class="{ 'dot--ready': connected, 'dot--failed': !connected }" />
        <span>{{ connected ? '桥接已连接' : '桥接未连接' }}</span>
        <template v-if="!binaryPath">
          <span class="statsPills__sep" />
          <span style="color: var(--dsw-alias-state-error-primary)">无 claude.exe</span>
        </template>
      </div>
    </div>

    <!-- Delete confirmation: a workspace is several sessions, so one click must not wipe it. -->
    <div v-if="confirmWorkspace" class="wsConfirm">
      <div class="wsConfirm__scrim" @click="confirmWorkspace = null" />
      <div class="wsConfirm__panel">
        <h4 class="wsConfirm__title">删除该工作区？</h4>
        <p class="wsConfirm__desc">
          将移除 <strong>{{ confirmCount }}</strong> 个会话。会话记录不再出现在列表里，磁盘上的
          <code>~/.claude</code> 历史不受影响。
        </p>
        <p class="wsConfirm__path">{{ confirmWorkspace }}</p>
        <div class="wsConfirm__actions">
          <button class="btnGhost" type="button" @click="confirmWorkspace = null">取消</button>
          <button class="wsConfirm__danger" type="button" @click="confirmRemoveWorkspace">删除工作区</button>
        </div>
      </div>
    </div>
  </aside>
</template>

<style scoped>
/* Row actions appear on hover so the list stays quiet at rest. */
.rowAction {
  display: inline-flex;
  flex: none;
  align-items: center;
  justify-content: center;
  width: 20px;
  height: 20px;
  margin-left: auto;
  border-radius: 5px;
  color: var(--dsw-alias-label-caption);
  opacity: 0;
  transition: opacity 100ms ease;
}

.rowAction--tight {
  width: 18px;
  height: 18px;
  margin-left: 4px;
}

.panelRow:hover .rowAction,
.sessionItem:hover .rowAction,
.rowAction:focus-visible {
  opacity: 1;
}

.rowAction:hover {
  background: var(--dsw-alias-interactive-bg-hover-danger);
  color: var(--dsw-alias-state-error-primary);
}

.panelRow__count {
  flex: none;
  margin-left: auto;
  color: var(--dsw-alias-label-caption);
  font-size: 11.5px;
}

/* With a delete affordance present the count no longer needs the free space. */
.panelRow:hover .panelRow__count {
  margin-left: auto;
}

.wsConfirm {
  position: fixed;
  inset: 0;
  z-index: 80;
  display: grid;
  place-items: center;
  padding: 32px;
}

.wsConfirm__scrim {
  position: absolute;
  inset: 0;
  background: rgba(0, 0, 0, 0.6);
}

.wsConfirm__panel {
  position: relative;
  width: 100%;
  max-width: 400px;
  padding: 18px 20px;
  border: 0.5px solid var(--dsw-alias-border-l2);
  border-radius: 14px;
  background: var(--dsw-alias-bg-layer-2);
  box-shadow: 0 16px 48px rgba(0, 0, 0, 0.6);
}

.wsConfirm__title {
  margin: 0 0 8px;
  font-size: 14px;
  font-weight: 600;
}

.wsConfirm__desc {
  margin: 0 0 8px;
  color: var(--dsw-alias-label-secondary);
  font-size: 12.5px;
  line-height: 19px;
}

.wsConfirm__path {
  margin: 0;
  overflow: hidden;
  color: var(--dsw-alias-label-caption);
  font-family: var(--dsw-font-family-code);
  font-size: 11px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.wsConfirm__actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 16px;
}

.wsConfirm__danger {
  padding: 7px 15px;
  border-radius: 8px;
  background: var(--dsw-alias-state-error-primary);
  color: #fff;
  font-size: 12.5px;
  font-weight: 600;
}
</style>
