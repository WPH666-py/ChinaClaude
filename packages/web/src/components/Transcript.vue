<script setup lang="ts">
/**
 * Conversation timeline.
 *
 * Layout follows the upstream chat view: user turns are right-aligned r22 bubbles, assistant
 * turns are unbubbled full-width blocks, reasoning is a collapsible disclosure row, and each
 * completed turn ends in a stats pill row.
 *
 * `mode` switches between the readable transcript ("对话") and the raw event trace ("轨迹").
 */
import { computed, nextTick, ref, watch } from 'vue'
import type { BridgeEvent } from '../types'
import { formatDuration, formatNumber, formatTime } from '../composables/useBridge'
import ToolCard from './ToolCard.vue'
import PermissionCard from './PermissionCard.vue'
import DialogCard from './DialogCard.vue'
import SubagentCard from './SubagentCard.vue'

const props = defineProps<{
  events: BridgeEvent[]
  busy: boolean
  mode: 'chat' | 'trace'
  /** Child events keyed by the launching tool_use id; a subagent's own transcript. */
  subagents?: Map<string, BridgeEvent[]>
  /** Tool names that launch a subagent. */
  isSubagentLauncher?: (event: BridgeEvent) => boolean
}>()

const emit = defineEmits<{
  (e: 'decide', payload: { requestId: string; behavior: 'allow' | 'deny'; scope?: 'once' | 'session' }): void
  (e: 'answer', payload: { requestId: string; behavior: 'completed' | 'cancelled'; result?: unknown }): void
}>()

/** Child events of a subagent, or an empty list. */
function childrenOf(id: string | undefined): BridgeEvent[] {
  if (!id || !props.subagents) return []
  return props.subagents.get(id) ?? []
}

function launchesSubagent(event: BridgeEvent): boolean {
  return props.isSubagentLauncher ? props.isSubagentLauncher(event) : event.name === 'Task'
}

/**
 * True when this tool call is the one currently parked on an approval ask. Without this the
 * card would read "执行中" while nothing is executing — the CLI is waiting on the user.
 */
const blockedToolUseIds = computed(() => {
  const ids = new Set<string>()
  for (const requestId of openPermissionIds.value) {
    const ask = props.events.find(
      (event) => event.kind === 'permission_request' && event.requestId === requestId,
    )
    if (ask?.toolUseId) ids.add(ask.toolUseId)
  }
  return ids
})

function isBlockedOnApproval(event: BridgeEvent): boolean {
  return Boolean(event.id && blockedToolUseIds.value.has(event.id))
}

const scroller = ref<HTMLElement | null>(null)
const openReasoning = ref<Set<string>>(new Set())

/** Pair each tool_use with its tool_result so a card renders once. */
const toolResults = computed(() => {
  const map = new Map<string, BridgeEvent>()
  for (const event of props.events) {
    if (event.kind === 'tool_result' && event.toolUseId) map.set(event.toolUseId, event)
  }
  return map
})

/** Timeline rows: tool results fold into their card, settlements fold into the ask. */
const items = computed(() =>
  props.events.filter(
    (event) =>
      event.kind !== 'tool_result' &&
      event.kind !== 'thinking_tokens' &&
      event.kind !== 'permission_settled' &&
      event.kind !== 'dialog_settled' &&
      // Subagent child events render inside their launcher's card, not on the main timeline.
      !event.parentToolUseId,
  ),
)

/**
 * The content still arriving, or null.
 *
 * A delta stream is live only until the CLI's assembled block for it lands — it sends the completed
 * `thinking` / `text` frame right after the last fragment, and THAT is what the timeline keeps. So
 * this exists purely to fill the gap before it: the gap that used to be a blank screen for the whole
 * duration of a long answer.
 */
const streaming = computed(() => {
  let live: BridgeEvent | null = null
  for (const event of props.events) {
    if (event.kind === 'thinking_delta' || event.kind === 'text_delta') live = event
    else if (event.kind === 'thinking' || event.kind === 'text' || event.kind === 'tool_use') live = null
  }
  return live
})

/**
 * The newest thinking-token estimate for the turn in flight.
 *
 * Retired by a `result`: the estimate describes work in progress, and leaving the last number on
 * screen after the turn ends would present a mid-thought count as if it were the turn's size.
 */
const thinkingProgress = computed(() => {
  const events = props.events
  let latestIndex = -1
  let resultIndex = -1
  for (let i = 0; i < events.length; i++) {
    if (events[i].kind === 'thinking_tokens') latestIndex = i
    else if (events[i].kind === 'result') resultIndex = i
  }
  if (latestIndex < 0 || latestIndex < resultIndex) return null
  return events[latestIndex]
})

/** The opening init frame becomes a header strip rather than a timeline row. */
const initEvent = computed(() => props.events.find((event) => event.kind === 'init') ?? null)

/** Tool uses by id, so a permission ask can show what it belongs to. */
const toolUses = computed(() => {
  const map = new Map<string, BridgeEvent>()
  for (const event of props.events) {
    if (event.kind === 'tool_use' && event.id) map.set(event.id, event)
  }
  return map
})

/**
 * Asks that were raised but never settled, plus a lookup for settled ones so a resolved
 * card can be swapped for a one-line outcome instead of disappearing.
 */
const openPermissionIds = computed(() => {
  const settled = new Set(
    props.events
      .filter((event) => event.kind === 'permission_settled')
      .map((event) => event.requestId ?? ''),
  )
  return new Set(
    props.events
      .filter((event) => event.kind === 'permission_request' && event.requestId && !settled.has(event.requestId))
      .map((event) => event.requestId as string),
  )
})

const settledPermissions = computed(() => {
  const map = new Map<string, BridgeEvent>()
  for (const event of props.events) {
    if (event.kind === 'permission_settled' && event.requestId) map.set(event.requestId, event)
  }
  return map
})

/** Host dialogs still awaiting an answer, and the record of those already answered. */
const openDialogIds = computed(() => {
  const settled = new Set(
    props.events.filter((event) => event.kind === 'dialog_settled').map((event) => event.requestId ?? ''),
  )
  return new Set(
    props.events
      .filter((event) => event.kind === 'dialog_request' && event.requestId && !settled.has(event.requestId))
      .map((event) => event.requestId as string),
  )
})

const settledDialogs = computed(() => {
  const map = new Map<string, BridgeEvent>()
  for (const event of props.events) {
    if (event.kind === 'dialog_settled' && event.requestId) map.set(event.requestId, event)
  }
  return map
})

function toggleReasoning(key: string) {
  const next = new Set(openReasoning.value)
  if (next.has(key)) next.delete(key)
  else next.add(key)
  openReasoning.value = next
}

function isThinkingOpen(key: string) {
  return openReasoning.value.has(key)
}

/** Keep the newest content in view unless the reader scrolled up. */
function nearBottom(): boolean {
  const element = scroller.value
  if (!element) return true
  return element.scrollHeight - element.scrollTop - element.clientHeight < 140
}

watch(
  () => props.events.length,
  async () => {
    const shouldStick = nearBottom()
    await nextTick()
    if (shouldStick && scroller.value) {
      scroller.value.scrollTop = scroller.value.scrollHeight
    }
  },
)

/** A compact one-line rendering of any event, for the trace tab. */
function traceLine(event: BridgeEvent): string {
  switch (event.kind) {
    case 'init':
      return `init · model=${event.model} tools=${event.tools?.length ?? 0} commands=${event.slashCommands?.length ?? 0}`
    case 'thinking':
      return `thinking · ${(event.text ?? '').slice(0, 160)}`
    case 'text':
      return `text · ${(event.text ?? '').slice(0, 160)}`
    case 'tool_use':
      return `tool_use · ${event.name} ${JSON.stringify(event.input ?? {}).slice(0, 140)}${event.parentToolUseId ? ` [sub:${event.parentToolUseId.slice(0, 10)}]` : ''}`
    case 'tool_result':
      return `tool_result · ${event.isError ? 'ERROR ' : ''}${(event.content ?? '').slice(0, 140)}`
    case 'dialog_request':
      return `dialog_request · ${event.dialogKind} ${JSON.stringify(event.payload ?? {}).slice(0, 120)}`
    case 'dialog_settled':
      return `dialog_settled · ${event.dialogKind} · ${event.behavior}`
    case 'result':
      return `result · ${event.stopReason} · in=${event.usage?.inputTokens} out=${event.usage?.outputTokens} · ${formatDuration(event.durationMs)}`
    case 'user':
      return `user · ${(event.text ?? '').slice(0, 160)}`
    case 'log':
      return `log[${event.level}] · ${event.message}`
    case 'error':
      return `error · ${event.message}`
    case 'closed':
      return `closed · exit ${event.code ?? '—'}`
    default:
      return event.kind
  }
}

// --- trace disclosure --------------------------------------------------------

/**
 * Which trace rows are open.
 *
 * A SET, not a single id: a trace is read by opening several rows and comparing them, and a view
 * that closed the previous one on every click would make that impossible.
 */
const openTrace = ref<Set<string>>(new Set())

/**
 * Row key.
 *
 * `at` alone is not unique — the CLI emits several frames inside one millisecond, which is exactly
 * what the trace exists to show — so the index disambiguates them.
 */
function traceKey(event: BridgeEvent, index: number): string {
  return `${event.at}-${event.kind}-${index}`
}

function toggleTrace(key: string) {
  const next = new Set(openTrace.value)
  if (next.has(key)) next.delete(key)
  else next.add(key)
  openTrace.value = next
}

function isTraceOpen(key: string): boolean {
  return openTrace.value.has(key)
}

/**
 * Human labels for the event fields.
 *
 * The alternative — rendering the raw JSON — shows the same data in a shape nobody reads: escaped
 * quotes inside a string, and keys named after the wire format. Labels cost one table and make the
 * panel legible without hiding anything, because a key with no label still renders under its own
 * name rather than being dropped.
 */
const TRACE_LABELS: Record<string, string> = {
  at: '时间',
  seq: '序号',
  text: '内容',
  message: '内容',
  level: '级别',
  model: '模型',
  resolvedModel: '实际模型',
  tools: '工具',
  skills: '技能',
  slashCommands: '斜杠命令',
  agents: '子代理',
  plugins: '插件',
  mcpServers: 'MCP 服务',
  permissionMode: '权限模式',
  capabilities: '能力',
  claudeCodeVersion: '版本',
  cwd: '工作目录',
  claudeSessionId: 'CLI 会话 ID',
  id: '调用 ID',
  name: '工具',
  input: '参数',
  toolUseId: '调用 ID',
  isError: '错误',
  content: '内容',
  subtype: '子类型',
  stopReason: '结束原因',
  durationMs: '耗时(ms)',
  usage: '用量',
  reportedCostUsd: 'CLI 报告费用',
  estimated: '估算 token',
  requestId: '请求 ID',
  displayName: '名称',
  description: '说明',
  suggestions: '建议',
  decisionReason: '决定原因',
  decisionReasonType: '原因类型',
  defaultToNo: '默认拒绝',
  suppressAlwaysAllowRule: '抑制总是允许',
  requiresUserInteraction: '需要交互',
  blockedPath: '阻断路径',
  decision: '决定',
  scope: '范围',
  dialogKind: '对话框类型',
  payload: '负载',
  behavior: '结果',
  parentToolUseId: '所属子代理',
  code: '退出码',
  reason: '原因',
}

/**
 * Fields the row header already shows.
 *
 * `kind` has its own column and `sessionId` is identical on every row of a stream, so repeating
 * either in the panel is noise. Everything else is shown, including keys this file has never heard
 * of — that is the point of driving the list off the event itself.
 */
const TRACE_HIDDEN = new Set(['sessionId', 'kind'])

/**
 * Every field of an event, in wire order, ready to render.
 *
 * Driven off `Object.entries` rather than a per-kind switch so a field the bridge adds later shows up
 * on its own. A hand-written list is how a trace view silently stops showing the thing you need.
 */
function traceFields(event: BridgeEvent): Array<{ key: string; label: string; value: string; code: boolean }> {
  const rows: Array<{ key: string; label: string; value: string; code: boolean }> = []
  for (const [key, value] of Object.entries(event)) {
    if (TRACE_HIDDEN.has(key)) continue
    if (value === undefined || value === null || value === '') continue
    if (Array.isArray(value) && value.length === 0) continue

    let text: string
    if (key === 'at' && typeof value === 'number') text = new Date(value).toLocaleString('zh-CN')
    else if (typeof value === 'string') text = value
    else if (Array.isArray(value) && value.every((entry) => typeof entry === 'string')) text = value.join(', ')
    else text = JSON.stringify(value, null, 2)

    rows.push({
      key,
      label: TRACE_LABELS[key] ?? key,
      value: text,
      // Structured values keep their own line breaks, so they render in a <pre>.
      code: typeof value !== 'string' && !(Array.isArray(value) && value.every((entry) => typeof entry === 'string')),
    })
  }
  return rows
}
</script>

<template>
  <div ref="scroller" class="transcript">
    <!-- ------------------------------------------------------------- trace -- -->
    <div v-if="mode === 'trace'" class="transcript__inner">
      <div v-if="events.length === 0" class="empty">
        <div class="empty__title">暂无事件</div>
        <div>发送一条消息后，这里会显示原始事件流。</div>
      </div>
      <div
        v-for="(event, index) in events"
        :key="`trace-${index}`"
        class="traceRow"
      >
        <!--
          The whole row is the disclosure control: the one-line summary stays visible so the trace
          keeps its shape while rows are opened, and what is truncated in that summary — a warning's
          full JSON, a tool's whole input — is what the panel below shows.
        -->
        <button
          class="traceRow__head"
          type="button"
          :aria-expanded="isTraceOpen(traceKey(event, index))"
          @click="toggleTrace(traceKey(event, index))"
        >
          <span class="traceRow__caret" :class="{ 'traceRow__caret--open': isTraceOpen(traceKey(event, index)) }" />
          <span class="traceRow__time">{{ formatTime(event.at) }}</span>
          <span class="traceRow__kind" :data-kind="event.kind">{{ event.kind }}</span>
          <span class="traceRow__body">{{ traceLine(event) }}</span>
        </button>

        <div v-if="isTraceOpen(traceKey(event, index))" class="traceRow__detail">
          <div v-for="field in traceFields(event)" :key="field.key" class="traceField">
            <span class="traceField__label">{{ field.label }}</span>
            <pre v-if="field.code" class="traceField__code">{{ field.value }}</pre>
            <span v-else class="traceField__text">{{ field.value }}</span>
          </div>
        </div>
      </div>
    </div>

    <!-- -------------------------------------------------------------- chat -- -->
    <div v-else class="transcript__inner">
      <div v-if="initEvent" class="sessionBanner">
        <span>会话已就绪</span>
        <span class="statsPills__sep" />
        <span>模型 {{ initEvent.model }}</span>
        <span class="statsPills__sep" />
        <span>{{ initEvent.tools?.length ?? 0 }} 个工具</span>
        <span class="statsPills__sep" />
        <span>{{ initEvent.slashCommands?.length ?? 0 }} 个命令</span>
        <span class="statsPills__sep" />
        <span>{{ initEvent.claudeCodeVersion ?? '2.x' }}</span>
      </div>

      <div v-if="items.length === 0" class="empty">
        <div class="empty__title">开始对话</div>
        <div>描述你要做的事，Claude Code 会读写文件、执行命令并给出结果。</div>
      </div>

      <template v-for="(event, index) in items" :key="`${event.kind}-${event.at}-${index}`">
        <!-- user turn: right-aligned r22 bubble -->
        <div v-if="event.kind === 'user'" class="userRow">
          <div class="userBubble">{{ event.text }}</div>
        </div>

        <!-- reasoning disclosure -->
        <div v-else-if="event.kind === 'thinking'" class="reason">
          <button class="reason__head" type="button" @click="toggleReasoning(`${event.at}-${index}`)">
            <span class="reason__caret" :class="{ 'reason__caret--open': isThinkingOpen(`${event.at}-${index}`) }" />
            <span>思考</span>
            <span class="reason__summary">{{ (event.text ?? '').slice(0, 70) }}</span>
          </button>
          <div v-if="isThinkingOpen(`${event.at}-${index}`)" class="reason__body">{{ event.text }}</div>
        </div>

        <!-- assistant text: no bubble -->
        <div v-else-if="event.kind === 'text'" class="turnBlock">
          <div class="assistant">{{ event.text }}</div>
        </div>

        <!-- permission ask: inline at the point the tool is blocked -->
        <PermissionCard
          v-else-if="event.kind === 'permission_request' && event.requestId && openPermissionIds.has(event.requestId)"
          :request="event"
          :tool-use="event.toolUseId ? toolUses.get(event.toolUseId) : undefined"
          @decide="(payload) => emit('decide', payload)"
        />

        <!-- a settled ask collapses to its outcome -->
        <div v-else-if="event.kind === 'permission_request' && event.requestId" class="statsPills">
          <span
            class="statsPills__item"
            :style="{
              color:
                settledPermissions.get(event.requestId)?.decision === 'allow'
                  ? 'var(--dsw-alias-state-success-primary)'
                  : 'var(--dsw-alias-state-error-primary)',
            }"
          >
            {{ settledPermissions.get(event.requestId)?.decision === 'allow' ? '已允许' : '已拒绝' }}
            {{ event.displayName ?? event.name }}
            <template v-if="settledPermissions.get(event.requestId)?.scope === 'session'">（本会话）</template>
          </span>
        </div>

        <!-- auto-denied without ever prompting (deny rule / dontAsk) -->
        <div v-else-if="event.kind === 'permission_denied'" class="statsPills">
          <span class="statsPills__item" style="color: var(--dsw-alias-state-warn-secondary)">
            自动拒绝 {{ event.name }} · {{ event.message }}
          </span>
        </div>

        <!-- host dialog (request_user_dialog) -->
        <DialogCard
          v-else-if="event.kind === 'dialog_request' && event.requestId && openDialogIds.has(event.requestId)"
          :request="event"
          @answer="(payload) => emit('answer', payload)"
        />

        <div v-else-if="event.kind === 'dialog_request' && event.requestId" class="statsPills">
          <span class="statsPills__item">
            对话框已处理：{{ event.dialogKind }}
            <template v-if="settledDialogs.get(event.requestId)?.behavior === 'cancelled'">（已取消）</template>
          </span>
        </div>

        <!-- subagent: its child transcript renders inside this card -->
        <SubagentCard
          v-else-if="event.kind === 'tool_use' && launchesSubagent(event)"
          :use="event"
          :result="event.id ? toolResults.get(event.id) : undefined"
          :children="childrenOf(event.id)"
        />

        <!-- tool call card -->
        <ToolCard
          v-else-if="event.kind === 'tool_use'"
          :use="event"
          :result="event.id ? toolResults.get(event.id) : undefined"
          :awaiting-approval="isBlockedOnApproval(event)"
        />

        <!-- per-turn stats -->
        <div v-else-if="event.kind === 'result'" class="statsPills">
          <span class="statsPills__item" :style="{ color: event.isError ? 'var(--dsw-alias-state-error-primary)' : 'var(--dsw-alias-state-success-primary)' }">
            {{ event.isError ? '本轮失败' : '本轮完成' }}
          </span>
          <span v-if="event.stopReason" class="statsPills__sep" />
          <span v-if="event.stopReason" class="statsPills__item">{{ event.stopReason }}</span>
          <span v-if="event.durationMs" class="statsPills__sep" />
          <span v-if="event.durationMs" class="statsPills__item">{{ formatDuration(event.durationMs) }}</span>
          <template v-if="event.usage">
            <span class="statsPills__sep" />
            <span class="statsPills__item">输入 {{ formatNumber(event.usage.inputTokens) }}</span>
            <span class="statsPills__sep" />
            <span class="statsPills__item">输出 {{ formatNumber(event.usage.outputTokens) }}</span>
            <template v-if="event.usage.cacheReadTokens > 0">
              <span class="statsPills__sep" />
              <span class="statsPills__item">缓存命中 {{ formatNumber(event.usage.cacheReadTokens) }}</span>
            </template>
          </template>
        </div>

        <!-- bridge diagnostics -->
        <div v-else-if="event.kind === 'log'" class="statsPills">
          <span class="statsPills__item">[{{ event.level }}] {{ event.message }}</span>
        </div>

        <!-- bridge notice, e.g. "switched endpoint, resuming the conversation" -->
        <div v-else-if="event.kind === 'notice'" class="noticeRow">
          <span class="noticeRow__mark" />
          <span>{{ event.message }}</span>
        </div>

        <div v-else-if="event.kind === 'error'" class="banner banner--error">{{ event.message }}</div>

        <div v-else-if="event.kind === 'closed'" class="statsPills">
          <span class="statsPills__item" style="color: var(--dsw-alias-state-error-primary)">
            会话已结束（exit {{ event.code ?? '—' }}）
          </span>
        </div>
      </template>

      <!--
        Live reasoning. Rendered from the endpoint's own deltas while they arrive, then replaced by
        the assembled block the CLI sends afterwards — which is what the timeline keeps.
      -->
      <div v-if="streaming" class="reason reason--live">
        <div class="reason__head reason__head--live">
          <span class="reason__pulse" />
          <span>{{ streaming.kind === 'thinking_delta' ? '思考中' : '输出中' }}</span>
          <span v-if="thinkingProgress" class="reason__summary">
            约 {{ formatNumber(thinkingProgress.estimated ?? 0) }} tokens
          </span>
        </div>
        <div class="reason__body reason__body--live">{{ streaming.text }}</div>
      </div>

      <div v-if="busy" class="statsPills">
        <span class="statsPills__item"><span class="spinner" /> 处理中</span>
      </div>
    </div>
  </div>
</template>

<style scoped>
.traceRow {
  border-bottom: 0.5px solid var(--dsw-alias-border-l1);
}

/* The disclosure control is the row itself, so the summary keeps its shape while rows are opened. */
.traceRow__head {
  display: grid;
  grid-template-columns: 10px 64px 92px minmax(0, 1fr);
  gap: 10px;
  align-items: baseline;
  width: 100%;
  padding: 3px 0;
  background: transparent;
  color: inherit;
  font-family: var(--dsw-font-family-code);
  font-size: 11.5px;
  line-height: 18px;
  text-align: left;
  cursor: pointer;
}

.traceRow__head:hover {
  background: var(--dsw-alias-interactive-bg-hover-solid);
}

.traceRow__caret {
  align-self: center;
  width: 0;
  height: 0;
  border-top: 3.5px solid transparent;
  border-bottom: 3.5px solid transparent;
  border-left: 4px solid var(--dsw-alias-label-caption);
  transition: transform 0.12s ease;
}

.traceRow__caret--open {
  transform: rotate(90deg);
}

/*
 * The expanded detail. Indented to the body column and rule-marked so it reads as belonging to the
 * row above rather than as another row.
 */
.traceRow__detail {
  margin: 2px 0 8px 20px;
  padding: 8px 10px;
  border-left: 2px solid var(--dsw-alias-border-l2);
  border-radius: 0 8px 8px 0;
  background: var(--dsw-alias-bg-layer-2);
}

.traceField {
  display: grid;
  grid-template-columns: 84px minmax(0, 1fr);
  gap: 8px;
  padding: 2px 0;
}

.traceField__label {
  color: var(--dsw-alias-label-caption);
  font-size: 11px;
}

.traceField__text {
  min-width: 0;
  color: var(--dsw-alias-label-primary);
  font-size: 11.5px;
  line-height: 17px;
  white-space: pre-wrap;
  word-break: break-word;
}

.traceField__code {
  min-width: 0;
  max-height: 320px;
  margin: 0;
  overflow: auto;
  color: var(--dsw-alias-label-secondary);
  font-family: var(--dsw-font-family-code);
  font-size: 11px;
  line-height: 16px;
  white-space: pre-wrap;
  word-break: break-word;
}

.traceRow__time {
  color: var(--dsw-alias-label-caption);
}

.traceRow__kind {
  overflow: hidden;
  color: var(--dsw-alias-label-tertiary);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.traceRow__kind[data-kind='tool_use'],
.traceRow__kind[data-kind='tool_result'] {
  color: var(--dsw-alias-state-business-primary);
}

.traceRow__kind[data-kind='error'],
.traceRow__kind[data-kind='closed'] {
  color: var(--dsw-alias-state-error-primary);
}

.traceRow__body {
  min-width: 0;
  overflow: hidden;
  color: var(--dsw-alias-label-secondary);
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* A bridge notice marks a state change that is not part of the conversation, so it reads as a
   quiet interstitial rather than a message from either side. */
.noticeRow {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 10px;
  padding: 7px 12px;
  border: 0.5px dashed var(--dsw-alias-border-l2);
  border-radius: 10px;
  color: var(--dsw-alias-label-tertiary);
  font-size: 12px;
}

.noticeRow__mark {
  flex: none;
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--dsw-alias-state-business-primary);
}
</style>
