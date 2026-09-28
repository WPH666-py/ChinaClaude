<script setup lang="ts">
/**
 * One tool call, paired with its result.
 *
 * Collapsed by default — raw tool payloads are unreadable in a stream — but the header keeps
 * the call identifiable: tool name, a one-line argument summary, and a status word on the
 * right. Expanded, it shows the pretty-printed input and the result body.
 */
import { computed, ref } from 'vue'
import type { BridgeEvent } from '../types'

const props = defineProps<{
  use: BridgeEvent
  result?: BridgeEvent
  /**
   * True while the CLI is parked on an approval ask for THIS call. Without it the card would
   * claim "执行中" while nothing is running — the tool is blocked waiting on the user.
   */
  awaitingApproval?: boolean
}>()

const open = ref(false)

const status = computed(() => {
  if (props.result) return props.result.isError ? 'error' : 'ok'
  return props.awaitingApproval ? 'blocked' : 'pending'
})

const statusText = computed(() => {
  switch (status.value) {
    case 'blocked':
      return '等待授权'
    case 'pending':
      return '执行中'
    case 'error':
      return '失败'
    default:
      return '完成'
  }
})

/** The most informative argument, in the order tools usually put it. */
const summary = computed(() => {
  const input = props.use.input as Record<string, unknown> | undefined
  if (!input || typeof input !== 'object') return ''
  const preferred = ['command', 'file_path', 'path', 'pattern', 'url', 'query', 'prompt', 'description', 'skill']
  for (const key of preferred) {
    const value = input[key]
    if (typeof value === 'string' && value.length > 0) {
      return value.length > 96 ? value.slice(0, 96) + '…' : value
    }
  }
  const first = Object.values(input).find((value) => typeof value === 'string')
  return typeof first === 'string' ? first.slice(0, 96) : ''
})

const inputText = computed(() => {
  try {
    return JSON.stringify(props.use.input ?? {}, null, 2)
  } catch {
    return String(props.use.input)
  }
})

const resultText = computed(() => {
  const content = props.result?.content ?? ''
  return content.length > 8000 ? content.slice(0, 8000) + '\n… (截断)' : content
})

/** A rough "lines changed" hint for edit-like tools, shown instead of a raw diff. */
const changeHint = computed(() => {
  const input = props.use.input as Record<string, unknown> | undefined
  if (!input) return null
  const oldText = input.old_string
  const newText = input.new_string
  if (typeof oldText === 'string' && typeof newText === 'string') {
    const removed = oldText.split('\n').length
    const added = newText.split('\n').length
    return { removed, added }
  }
  if (typeof input.content === 'string') {
    return { removed: 0, added: input.content.split('\n').length }
  }
  return null
})
</script>

<template>
  <div class="tool" :class="{ 'tool--error': status === 'error' }">
    <button class="tool__head" type="button" @click="open = !open">
      <span class="tool__icon">{{ (use.name ?? '?').slice(0, 1).toUpperCase() }}</span>
      <span class="tool__name">{{ use.name }}</span>
      <span class="tool__summary">{{ summary }}</span>
      <span v-if="changeHint" class="tool__diff">
        <span class="tool__diffAdd">+{{ changeHint.added }}</span>
        <span v-if="changeHint.removed" class="tool__diffDel">-{{ changeHint.removed }}</span>
      </span>
      <span class="tool__status" :class="`tool__status--${status}`">{{ statusText }}</span>
    </button>

    <div v-if="open" class="tool__body">
      <div class="tool__label">输入</div>
      <pre class="tool__pre">{{ inputText }}</pre>
      <div class="tool__label">结果</div>
      <pre class="tool__pre">{{ result ? resultText || '(空)' : '等待返回…' }}</pre>
    </div>
  </div>
</template>

<style scoped>
.tool__diff {
  display: inline-flex;
  flex: none;
  gap: 4px;
  font-family: var(--dsw-font-family-code);
  font-size: 11px;
}

.tool__diffAdd {
  color: var(--dsw-alias-state-success-primary);
}

.tool__diffDel {
  color: var(--dsw-alias-state-error-primary);
}

/* Blocked on the user, not on work: the global sheet covers pending/ok/error, and this state
   is distinct enough to deserve its own tone rather than reusing the running amber. */
.tool__status--blocked {
  color: var(--dsw-alias-state-business-primary);
}
</style>
