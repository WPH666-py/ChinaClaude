<script setup lang="ts">
/**
 * Host dialog card (`request_user_dialog`).
 *
 * `dialog_kind` is an OPEN string union — the protocol adds kinds without a version bump — so
 * this renders GENERICALLY rather than switching on a hardcoded list:
 *
 *   1. If the payload offers choices (fields named option(s)/choice(s) whose entries have a
 *      label or value), render one button per choice and answer `{behavior:'completed',
 *      result:{...selected}}`.
 *   2. Otherwise offer a single confirm, plus cancel.
 *
 * Cancel sends `{behavior:'cancelled'}`, which makes the CLI apply that dialog's own default
 * behaviour — so an unknown kind always has a safe, protocol-sanctioned way out.
 */
import { computed, ref } from 'vue'
import type { BridgeEvent } from '../types'

const props = defineProps<{
  request: BridgeEvent
}>()

const emit = defineEmits<{
  (e: 'answer', payload: { requestId: string; behavior: 'completed' | 'cancelled'; result?: unknown }): void
}>()

const expanded = ref(false)
const requestId = computed(() => props.request.requestId ?? '')
const kind = computed(() => props.request.dialogKind ?? 'unknown')

/** Friendly titles for kinds we know; anything else is shown verbatim. */
const KIND_TITLES: Record<string, string> = {
  refusal_fallback_prompt: '模型拒绝，可切换备用模型重试',
}

const title = computed(() => KIND_TITLES[kind.value] ?? kind.value)

interface Choice {
  label: string
  value: unknown
}

/**
 * Pull a choice list out of a payload without knowing its schema: look for an array whose
 * entries look like options, and take the first one found.
 */
const choices = computed<Choice[]>(() => {
  const payload = props.request.payload
  if (!payload || typeof payload !== 'object') return []

  const candidates = ['options', 'choices', 'actions', 'actions_taken']
  for (const key of candidates) {
    const list = (payload as Record<string, unknown>)[key]
    if (!Array.isArray(list) || list.length === 0) continue

    const mapped: Choice[] = []
    for (const entry of list) {
      if (typeof entry === 'string') {
        mapped.push({ label: entry, value: entry })
        continue
      }
      if (!entry || typeof entry !== 'object') continue
      const record = entry as Record<string, unknown>
      const label = record.label ?? record.title ?? record.name ?? record.value
      if (typeof label !== 'string' || !label) continue
      // Prefer an explicit machine value; fall back to echoing the whole entry, which is what
      // an opaque payload expects.
      mapped.push({ label, value: record.value ?? entry })
    }
    if (mapped.length > 0) return mapped
  }
  return []
})

/** Anything the payload says about itself, for the collapse-open detail view. */
const payloadRows = computed(() => {
  const payload = props.request.payload
  if (!payload || typeof payload !== 'object') return []
  return Object.entries(payload as Record<string, unknown>)
    .filter(([, value]) => typeof value !== 'object' || value === null)
    .map(([key, value]) => ({ key, value: String(value) }))
})

const payloadJson = computed(() => {
  try {
    return JSON.stringify(props.request.payload ?? {}, null, 2)
  } catch {
    return String(props.request.payload)
  }
})

function choose(choice: Choice) {
  emit('answer', { requestId: requestId.value, behavior: 'completed', result: choice.value })
}

function confirm() {
  // No explicit choices: hand back the payload untouched as the result, which is the only
  // shape an opaque kind can interpret as "accepted with no changes".
  emit('answer', { requestId: requestId.value, behavior: 'completed', result: props.request.payload ?? {} })
}

function cancel() {
  emit('answer', { requestId: requestId.value, behavior: 'cancelled' })
}
</script>

<template>
  <div class="dlg">
    <div class="dlg__head">
      <span class="dlg__badge">需要选择</span>
      <span class="dlg__title">{{ title }}</span>
      <span class="dlg__kind">{{ kind }}</span>
    </div>

    <div v-if="payloadRows.length > 0" class="dlg__rows">
      <div v-for="row in payloadRows" :key="row.key" class="dlg__row">
        <span class="dlg__key">{{ row.key }}</span>
        <span class="dlg__value">{{ row.value }}</span>
      </div>
    </div>

    <button class="dlg__toggle" type="button" @click="expanded = !expanded">
      {{ expanded ? '隐藏原始载荷' : '查看原始载荷' }}
    </button>
    <pre v-if="expanded" class="dlg__pre">{{ payloadJson }}</pre>

    <div class="dlg__actions">
      <template v-if="choices.length > 0">
        <button
          v-for="choice in choices"
          :key="choice.label"
          class="dlg__btn dlg__btn--primary"
          type="button"
          :disabled="!requestId"
          @click="choose(choice)"
        >
          {{ choice.label }}
        </button>
      </template>
      <button v-else class="dlg__btn dlg__btn--primary" type="button" :disabled="!requestId" @click="confirm">
        确认
      </button>

      <span class="dlg__spacer" />
      <button class="dlg__btn dlg__btn--cancel" type="button" :disabled="!requestId" @click="cancel">
        取消
      </button>
    </div>
  </div>
</template>

<style scoped>
.dlg {
  margin-bottom: 10px;
  border: 0.5px solid var(--dsw-alias-state-business-primary);
  border-radius: 12px;
  background: var(--dsw-alias-bg-layer-1);
  overflow: hidden;
}

.dlg__head {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 9px 12px;
}

.dlg__badge {
  flex: none;
  padding: 2px 7px;
  border-radius: 5px;
  background: var(--dsw-alias-state-business-tertiary);
  color: var(--dsw-static-deepseek-400);
  font-size: 10.5px;
  font-weight: 600;
}

.dlg__title {
  min-width: 0;
  overflow: hidden;
  font-size: var(--dsh-content-font-size-secondary);
  font-weight: 600;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.dlg__kind {
  flex: none;
  margin-left: auto;
  color: var(--dsw-alias-label-caption);
  font-family: var(--dsw-font-family-code);
  font-size: 10.5px;
}

.dlg__rows {
  display: grid;
  gap: 3px;
  padding: 0 12px 6px;
}

.dlg__row {
  display: grid;
  grid-template-columns: 130px minmax(0, 1fr);
  gap: 10px;
  font-size: 11.5px;
}

.dlg__key {
  color: var(--dsw-alias-label-caption);
  font-family: var(--dsw-font-family-code);
}

.dlg__value {
  min-width: 0;
  overflow: hidden;
  color: var(--dsw-alias-label-secondary);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.dlg__toggle {
  margin: 0 12px 8px;
  padding: 3px 0;
  color: var(--dsw-alias-link);
  font-size: 11.5px;
  text-align: left;
}

.dlg__pre {
  max-height: 240px;
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

.dlg__actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  padding: 0 12px 11px;
}

.dlg__spacer {
  flex: 1;
}

.dlg__btn {
  padding: 6px 13px;
  border: 0.5px solid var(--dsw-alias-border-l2);
  border-radius: 8px;
  background: var(--dsw-alias-bg-layer-2);
  color: var(--dsw-alias-label-primary);
  font-size: 12.5px;
  font-weight: 500;
}

.dlg__btn:hover:not(:disabled) {
  background: var(--dsw-alias-interactive-bg-hover-solid);
}

.dlg__btn--primary {
  border-color: transparent;
  background: var(--dsw-alias-button-info-fill);
  color: #fff;
}

.dlg__btn--primary:hover:not(:disabled) {
  background: var(--dsw-alias-button-info-hover);
}

.dlg__btn--cancel {
  color: var(--dsw-alias-label-tertiary);
}
</style>
