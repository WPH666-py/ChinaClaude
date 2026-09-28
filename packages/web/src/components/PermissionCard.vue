<script setup lang="ts">
/**
 * Permission approval card.
 *
 * Rendered inline at the point in the transcript where the tool call is waiting, so the
 * decision is made in context rather than in a detached modal — the user can see what the
 * model was doing when it asked.
 *
 * The CLI blocks the tool call until this is answered, so the card is the only way forward;
 * it therefore always offers both outcomes and marks the safer one when the CLI says so
 * (`default_to_no`, set for asks that must not be approvable by a single stray click).
 */
import { computed } from 'vue'
import type { BridgeEvent } from '../types'

const props = defineProps<{
  request: BridgeEvent
  /** The tool_use this ask belongs to, when the transcript has it. */
  toolUse?: BridgeEvent
}>()

const emit = defineEmits<{
  (e: 'decide', payload: { requestId: string; behavior: 'allow' | 'deny'; scope?: 'once' | 'session' }): void
}>()

const requestId = computed(() => props.request.requestId ?? '')

/** The `can_use_tool` permission_suggestions the CLI offered (e.g. setMode acceptEdits). */
const suggestions = computed(() => (props.request.suggestions ?? []) as Array<Record<string, unknown>>)

/** A memorable one-liner for what is about to happen. */
const summary = computed(() => {
  const input = (props.request.input ?? {}) as Record<string, unknown>
  const preferred = ['command', 'file_path', 'path', 'pattern', 'url', 'query', 'prompt']
  for (const key of preferred) {
    const value = input[key]
    if (typeof value === 'string' && value.length > 0) return value
  }
  return props.request.description ?? ''
})

const inputText = computed(() => {
  try {
    return JSON.stringify(props.request.input ?? {}, null, 2)
  } catch {
    return String(props.request.input)
  }
})

/** Human wording for the mode a suggestion would switch the session into. */
function describeSuggestion(suggestion: Record<string, unknown>): string | null {
  if (suggestion.type === 'setMode' && typeof suggestion.mode === 'string') {
    const labels: Record<string, string> = {
      acceptEdits: '自动接受本会话的文件编辑',
      bypassPermissions: '本会话跳过全部权限检查',
      plan: '切换到计划模式',
      default: '恢复默认权限模式',
      auto: '切换到自动模式',
      dontAsk: '不再询问',
      manual: '手动确认每一步',
    }
    return labels[suggestion.mode] ?? `切换到 ${suggestion.mode}`
  }
  if (suggestion.type === 'addRules') {
    const rules = Array.isArray(suggestion.rules) ? suggestion.rules : []
    const names = rules
      .map((rule) => (rule && typeof rule === 'object' ? (rule as Record<string, unknown>).toolName : null))
      .filter((name): name is string => typeof name === 'string')
    return names.length > 0 ? `本会话始终允许 ${names.join('、')}` : '本会话始终允许此工具'
  }
  return null
}

const modeSuggestions = computed(() =>
  suggestions.value
    .map((suggestion) => ({ raw: suggestion, label: describeSuggestion(suggestion) }))
    .filter((entry): entry is { raw: Record<string, unknown>; label: string } => entry.label !== null),
)

/** The CLI's own reason for escalating, when it gave one. */
const reasonText = computed(() => {
  const reason = props.request.decisionReason
  return typeof reason === 'string' && reason.length > 0 ? reason.replace(/\u001b\[[0-9;]*m/g, '') : ''
})
</script>

<template>
  <div class="perm" :class="{ 'perm--caution': request.defaultToNo }">
    <div class="perm__head">
      <span class="perm__badge">需要授权</span>
      <span class="perm__tool">{{ request.displayName ?? request.name }}</span>
      <span v-if="summary" class="perm__summary" :title="summary">{{ summary }}</span>
    </div>

    <div v-if="reasonText" class="perm__reason">{{ reasonText }}</div>

    <pre class="perm__pre">{{ inputText }}</pre>

    <div class="perm__actions">
      <button
        class="perm__btn perm__btn--allow"
        type="button"
        :disabled="!requestId"
        @click="emit('decide', { requestId, behavior: 'allow', scope: 'once' })"
      >
        允许一次
      </button>

      <button
        v-for="suggestion in modeSuggestions"
        :key="suggestion.label"
        class="perm__btn"
        type="button"
        :disabled="!requestId"
        @click="emit('decide', { requestId, behavior: 'allow', scope: 'session' })"
      >
        {{ suggestion.label }}
      </button>

      <span class="perm__spacer" />

      <button
        class="perm__btn perm__btn--deny"
        type="button"
        :disabled="!requestId"
        @click="emit('decide', { requestId, behavior: 'deny' })"
      >
        拒绝
      </button>
    </div>

    <div v-if="request.defaultToNo" class="perm__note">
      此操作风险较高，默认不批准；请确认后手动选择。
    </div>
  </div>
</template>

<style scoped>
.perm {
  margin-bottom: 10px;
  border: 0.5px solid var(--dsw-alias-state-warn-primary);
  border-radius: 12px;
  background: var(--dsw-alias-bg-layer-1);
  overflow: hidden;
}

/* Asks the CLI flagged as unsafe-by-default read in the error tone instead. */
.perm--caution {
  border-color: var(--dsw-alias-state-error-primary);
}

.perm__head {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 9px 12px;
}

.perm__badge {
  flex: none;
  padding: 2px 7px;
  border-radius: 5px;
  background: var(--dsw-alias-state-warn-tertiary);
  color: var(--dsw-alias-state-warn-secondary);
  font-size: 10.5px;
  font-weight: 600;
}

.perm--caution .perm__badge {
  background: var(--dsw-alias-interactive-bg-hover-danger);
  color: var(--dsw-alias-state-error-primary);
}

.perm__tool {
  flex: none;
  font-size: var(--dsh-content-font-size-secondary);
  font-weight: 600;
}

.perm__summary {
  min-width: 0;
  overflow: hidden;
  color: var(--dsw-alias-label-tertiary);
  font-family: var(--dsw-font-family-code);
  font-size: 11.5px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.perm__reason {
  padding: 0 12px 6px;
  color: var(--dsw-alias-state-warn-secondary);
  font-size: 12px;
  line-height: 18px;
}

.perm__pre {
  max-height: 220px;
  margin: 0 12px 10px;
  padding: 9px 11px;
  border-radius: 8px;
  background: var(--dsw-alias-markdown-code-block);
  color: var(--dsw-alias-label-secondary);
  font-family: var(--dsw-font-family-code);
  font-size: 11.5px;
  line-height: 18px;
  overflow: auto;
  white-space: pre-wrap;
  word-break: break-word;
}

.perm__actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  padding: 0 12px 11px;
}

.perm__spacer {
  flex: 1;
}

.perm__btn {
  padding: 6px 13px;
  border: 0.5px solid var(--dsw-alias-border-l2);
  border-radius: 8px;
  background: var(--dsw-alias-bg-layer-2);
  color: var(--dsw-alias-label-primary);
  font-size: 12.5px;
  font-weight: 500;
}

.perm__btn:hover:not(:disabled) {
  background: var(--dsw-alias-interactive-bg-hover-solid);
}

.perm__btn--allow {
  border-color: transparent;
  background: var(--dsw-alias-button-info-fill);
  color: #fff;
}

.perm__btn--allow:hover:not(:disabled) {
  background: var(--dsw-alias-button-info-hover);
}

.perm__btn--deny {
  color: var(--dsw-alias-state-error-primary);
}

.perm__btn--deny:hover:not(:disabled) {
  background: var(--dsw-alias-interactive-bg-hover-danger);
}

.perm__note {
  padding: 0 12px 10px;
  color: var(--dsw-alias-label-caption);
  font-size: 11.5px;
}
</style>
