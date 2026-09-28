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
        <span class="traceRow__time">{{ formatTime(event.at) }}</span>
        <span class="traceRow__kind" :data-kind="event.kind">{{ event.kind }}</span>
        <span class="traceRow__body">{{ traceLine(event) }}</span>
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

      <div v-if="busy" class="statsPills">
        <span class="statsPills__item"><span class="spinner" /> 处理中</span>
      </div>
    </div>
  </div>
</template>

<style scoped>
.traceRow {
  display: grid;
  grid-template-columns: 64px 92px minmax(0, 1fr);
  gap: 10px;
  padding: 3px 0;
  border-bottom: 0.5px solid var(--dsw-alias-border-l1);
  font-family: var(--dsw-font-family-code);
  font-size: 11.5px;
  line-height: 18px;
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
