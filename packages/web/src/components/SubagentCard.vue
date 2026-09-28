<script setup lang="ts">
/**
 * Subagent card.
 *
 * A subagent is a `Task` (or `Agent`/`Workflow`) tool call whose own transcript arrives on the
 * same stream, marked with `parent_tool_use_id` pointing at the launching tool_use. Those
 * child events are rendered here, indented, so the main timeline stays readable while the
 * subagent's work is still inspectable.
 *
 * Collapsed by default: a subagent can emit dozens of blocks, and the point of the card is to
 * show THAT it ran and what it concluded.
 */
import { computed, ref } from 'vue'
import type { BridgeEvent } from '../types'
import { formatNumber } from '../composables/useBridge'
import ToolCard from './ToolCard.vue'

const props = defineProps<{
  use: BridgeEvent
  result?: BridgeEvent
  children: BridgeEvent[]
}>()

const open = ref(false)

const status = computed(() => {
  if (!props.result) return 'running'
  return props.result.isError ? 'error' : 'done'
})

const statusText = computed(() => {
  switch (status.value) {
    case 'running':
      return '运行中'
    case 'error':
      return '失败'
    default:
      return '已完成'
  }
})

/** The subagent type, which is what tells the user which agent did the work. */
const agentType = computed(() => {
  const input = props.use.input as Record<string, unknown> | undefined
  const value = input?.subagent_type ?? input?.agent ?? input?.agentType
  return typeof value === 'string' ? value : 'subagent'
})

/** What the agent was asked to do. */
const brief = computed(() => {
  const input = props.use.input as Record<string, unknown> | undefined
  const value = input?.description ?? input?.prompt ?? input?.task
  if (typeof value !== 'string') return ''
  return value.length > 110 ? value.slice(0, 110) + '…' : value
})

/** Nesting: child events that themselves launched a subagent are rendered as cards, not rows. */
const nestedToolResults = computed(() => {
  const map = new Map<string, BridgeEvent>()
  for (const event of props.children) {
    if (event.kind === 'tool_result' && event.toolUseId) map.set(event.toolUseId, event)
  }
  return map
})

const rows = computed(() =>
  props.children.filter((event) => event.kind !== 'tool_result' && event.kind !== 'thinking_tokens'),
)

/** Token spend attributable to this subagent, summed from its own result frames if present. */
const childTokens = computed(() => {
  let input = 0
  let output = 0
  for (const event of props.children) {
    if (event.kind !== 'result' || !event.usage) continue
    input += event.usage.inputTokens
    output += event.usage.outputTokens
  }
  return { input, output }
})

/** Last thing the subagent said, shown on the collapsed header as its conclusion. */
const conclusion = computed(() => {
  const texts = props.children.filter((event) => event.kind === 'text')
  const last = texts[texts.length - 1]
  if (!last?.text) return ''
  const flat = last.text.replace(/\s+/g, ' ').trim()
  return flat.length > 120 ? flat.slice(0, 120) + '…' : flat
})
</script>

<template>
  <div class="sub" :class="{ 'sub--error': status === 'error' }">
    <button class="sub__head" type="button" @click="open = !open">
      <span class="reason__caret" :class="{ 'reason__caret--open': open }" />
      <span class="sub__badge">子代理</span>
      <span class="sub__agent">{{ agentType }}</span>
      <span class="sub__brief" :title="brief">{{ brief }}</span>
      <span class="sub__count">{{ children.length }} 事件</span>
      <span class="sub__status" :class="`sub__status--${status}`">{{ statusText }}</span>
    </button>

    <div v-if="conclusion && !open" class="sub__conclusion">{{ conclusion }}</div>

    <div v-if="open" class="sub__body">
      <div v-if="rows.length === 0" class="sub__empty">子代理尚未产生输出</div>

      <template v-for="(event, index) in rows" :key="`sub-${event.kind}-${event.at}-${index}`">
        <div v-if="event.kind === 'thinking'" class="sub__thinking">{{ event.text }}</div>

        <div v-else-if="event.kind === 'text'" class="sub__text">{{ event.text }}</div>

        <ToolCard
          v-else-if="event.kind === 'tool_use'"
          :use="event"
          :result="event.id ? nestedToolResults.get(event.id) : undefined"
        />

        <div v-else-if="event.kind === 'permission_request'" class="sub__note">
          子代理请求授权：{{ event.displayName ?? event.name }}
        </div>

        <div v-else-if="event.kind === 'result'" class="sub__note">
          子代理结束 · {{ event.stopReason }}
          <template v-if="event.usage">
            · 输入 {{ formatNumber(event.usage.inputTokens) }} 输出 {{ formatNumber(event.usage.outputTokens) }}
          </template>
        </div>
      </template>

      <div v-if="childTokens.input > 0" class="sub__tokens">
        子代理用量：输入 {{ formatNumber(childTokens.input) }} · 输出 {{ formatNumber(childTokens.output) }}
      </div>
    </div>
  </div>
</template>

<style scoped>
.sub {
  margin-bottom: 10px;
  border: 0.5px solid var(--dsw-alias-border-l2);
  border-radius: 12px;
  /* A left accent marks nested work without indenting the whole card out of alignment. */
  border-left: 2px solid var(--dsw-alias-state-business-primary);
  background: var(--dsw-alias-bg-layer-1);
  overflow: hidden;
}

.sub--error {
  border-left-color: var(--dsw-alias-state-error-primary);
}

.sub__head {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 8px 12px;
  text-align: left;
}

.sub__head:hover {
  background: var(--dsw-alias-interactive-bg-hover);
}

.sub__badge {
  flex: none;
  padding: 2px 7px;
  border-radius: 5px;
  background: var(--dsw-alias-state-business-tertiary);
  color: var(--dsw-static-deepseek-400);
  font-size: 10.5px;
  font-weight: 600;
}

.sub__agent {
  flex: none;
  font-size: var(--dsh-content-font-size-secondary);
  font-weight: 600;
}

.sub__brief {
  min-width: 0;
  overflow: hidden;
  color: var(--dsw-alias-label-tertiary);
  font-size: 12px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.sub__count {
  flex: none;
  margin-left: auto;
  color: var(--dsw-alias-label-caption);
  font-size: 11.5px;
}

.sub__status {
  flex: none;
  font-size: 11.5px;
  font-weight: 500;
}

.sub__status--running {
  color: var(--dsw-alias-state-warn-primary);
}
.sub__status--done {
  color: var(--dsw-alias-state-success-primary);
}
.sub__status--error {
  color: var(--dsw-alias-state-error-primary);
}

.sub__conclusion {
  padding: 0 12px 9px 28px;
  color: var(--dsw-alias-label-tertiary);
  font-size: 12px;
  line-height: 18px;
}

.sub__body {
  padding: 8px 12px 10px;
  border-top: 0.5px solid var(--dsw-alias-border-l1);
}

.sub__empty {
  color: var(--dsw-alias-label-caption);
  font-size: 12px;
}

.sub__thinking {
  margin-bottom: 8px;
  padding-left: 10px;
  border-left: 2px solid var(--dsw-alias-border-l3);
  color: var(--dsw-alias-label-caption);
  font-size: 12px;
  font-style: italic;
  line-height: 20px;
  white-space: pre-wrap;
  word-break: break-word;
}

.sub__text {
  margin-bottom: 8px;
  color: var(--dsw-alias-label-secondary);
  font-size: var(--dsh-content-font-size-secondary);
  line-height: 21px;
  white-space: pre-wrap;
  word-break: break-word;
}

.sub__note {
  margin-bottom: 6px;
  color: var(--dsw-alias-label-caption);
  font-size: 11.5px;
}

.sub__tokens {
  margin-top: 6px;
  padding-top: 6px;
  border-top: 0.5px solid var(--dsw-alias-border-l1);
  color: var(--dsw-alias-label-caption);
  font-size: 11.5px;
}
</style>
