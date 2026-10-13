<script setup lang="ts">
/**
 * The bar between the transcript and the composer that reports what the LOCAL checks decided.
 *
 * WHY THIS EXISTS AT ALL: 规则引擎 and 安全防护 both used to live in their own windows, where they
 * could look configured and still change nothing about a real turn — the gap this component closes.
 * Whatever the bridge decided on a send has to be visible at the moment of sending, next to the box
 * the text came out of, or the user has no way to tell "my rule fired" from "my rule is broken".
 *
 * Two modes, deliberately different in weight:
 *   - CONFIRM: a decision is required. Full width, blockers spelled out, and the send button is the
 *     second half of the pair — never auto-confirmed, never auto-dismissed.
 *   - NOTICE: a label or an appended line went out with the turn. Thin, dismissible, self-clearing:
 *     information, not a question.
 */
import { computed } from 'vue'
import type { SendBlocker, SendRuleHit } from '../types'

const props = defineProps<{
  /** Present when a send is held awaiting confirmation. */
  pending?: { text: string; blockers: SendBlocker[] } | null
  /** Present when the last send carried rule labels or an appended line. */
  notice?: { rules: SendRuleHit[]; appended?: string | null } | null
  /** Present when the last send failed outright (e.g. a turn is already running). */
  error?: string | null
  busy?: boolean
}>()

const emit = defineEmits<{
  (e: 'confirm'): void
  (e: 'cancel'): void
  (e: 'dismiss'): void
}>()

const SOURCE_LABEL: Record<string, string> = { rule: '规则', defend: '安全防护' }

/** What actually went out, said in one line: a silent rewrite would be the one unforgivable option. */
const noticeText = computed(() => {
  const rules = props.notice?.rules ?? []
  if (rules.length === 0 && !props.notice?.appended) return ''
  const labels = rules.filter((rule) => rule.action === 'label').map((rule) => rule.name)
  const appended = rules.filter((rule) => rule.action === 'append')
  const parts: string[] = []
  if (labels.length > 0) parts.push(`标注：${labels.join('、')}`)
  if (appended.length > 0) parts.push(`追加提示：${appended.map((rule) => rule.name).join('、')}`)
  return parts.join(' · ')
})

const preview = computed(() => {
  const text = props.pending?.text ?? ''
  // The card is a confirmation, not a reading pane: enough to recognise the turn, not the whole paste.
  return text.length > 300 ? `${text.slice(0, 300)}…` : text
})
</script>

<template>
  <!-- confirm mode -->
  <div v-if="pending" class="sg sg--confirm">
    <div class="sg__head">
      <span class="sg__badge sg__badge--stop">发送前检查</span>
      <span class="sg__title">命中 {{ pending.blockers.length }} 项，未发送</span>
      <span class="sg__spacer" />
      <span class="sg__hint">确认后会原样发出，并记入运行日志</span>
    </div>

    <ul class="sg__list">
      <li v-for="(blocker, index) in pending.blockers" :key="`${blocker.name}-${index}`" class="sg__item">
        <span class="sg__source">{{ SOURCE_LABEL[blocker.source] ?? blocker.source }}</span>
        <span class="sg__name">{{ blocker.name }}</span>
        <span v-if="blocker.family" class="sg__family">{{ blocker.family }}</span>
        <span v-if="blocker.label" class="sg__label">{{ blocker.label }}</span>
      </li>
    </ul>

    <pre class="sg__preview">{{ preview }}</pre>

    <div class="sg__actions">
      <button class="btnPrimary" type="button" :disabled="busy" @click="emit('confirm')">
        {{ busy ? '发送中…' : '仍然发送' }}
      </button>
      <button class="btnGhost" type="button" :disabled="busy" @click="emit('cancel')">
        取消并放回输入框
      </button>
    </div>
  </div>

  <!-- notice / error mode -->
  <div v-else-if="noticeText || error" class="sg sg--notice" :class="{ 'sg--error': Boolean(error) }">
    <span class="sg__badge" :class="error ? 'sg__badge--stop' : 'sg__badge--ok'">
      {{ error ? '未发送' : '规则命中' }}
    </span>
    <span class="sg__text">{{ error ?? noticeText }}</span>
    <span v-if="!error && notice?.appended" class="sg__appended" :title="notice.appended">
      已追加：{{ notice.appended }}
    </span>
    <span class="sg__spacer" />
    <button class="iconButton" type="button" title="关闭" @click="emit('dismiss')">
      <svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden="true">
        <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" />
      </svg>
    </button>
  </div>
</template>

<style scoped>
.sg {
  flex: none;
  margin: 0 16px 8px;
  border: 0.5px solid var(--dsw-alias-border-l1);
  border-radius: 10px;
  background: var(--dsw-alias-bg-layer-1);
}

.sg--confirm {
  padding: 10px 12px;
  border-color: var(--dsw-alias-state-warn-secondary);
  background: var(--dsw-alias-bg-layer-2);
}

.sg--notice {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 10px;
  font-size: 12px;
}

.sg--error {
  border-color: var(--dsw-alias-state-error-primary);
}

.sg__head {
  display: flex;
  align-items: center;
  gap: 8px;
}

.sg__badge {
  flex: none;
  padding: 1px 7px;
  border-radius: 5px;
  background: var(--dsw-alias-bg-layer-3);
  color: var(--dsw-alias-label-tertiary);
  font-size: 10.5px;
  font-weight: 600;
}

.sg__badge--stop {
  background: var(--dsw-alias-interactive-bg-hover-danger);
  color: var(--dsw-alias-state-error-primary);
}

.sg__badge--ok {
  background: var(--dsw-alias-state-warn-tertiary);
  color: var(--dsw-alias-state-warn-secondary);
}

.sg__title {
  font-size: 12.5px;
  font-weight: 600;
}

.sg__spacer {
  flex: 1;
}

.sg__hint {
  color: var(--dsw-alias-label-caption);
  font-size: 11px;
}

.sg__list {
  margin: 8px 0 0;
  padding: 0;
  list-style: none;
}

.sg__item {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 8px;
  padding: 3px 0;
  font-size: 12px;
}

.sg__source {
  flex: none;
  padding: 1px 6px;
  border-radius: 4px;
  background: var(--dsw-alias-bg-layer-3);
  color: var(--dsw-alias-label-tertiary);
  font-size: 10px;
}

.sg__name {
  font-weight: 500;
}

.sg__family,
.sg__label {
  color: var(--dsw-alias-label-secondary);
  font-size: 11.5px;
}

.sg__preview {
  margin: 8px 0 0;
  max-height: 96px;
  padding: 8px 10px;
  border-radius: 8px;
  background: var(--dsw-static-neutral-bluish-1000);
  overflow: auto;
  color: var(--dsw-alias-label-secondary);
  font-family: var(--dsw-font-family-code);
  font-size: 11.5px;
  line-height: 17px;
  white-space: pre-wrap;
  word-break: break-word;
}

.sg__actions {
  display: flex;
  gap: 10px;
  margin-top: 10px;
}

.sg__text {
  color: var(--dsw-alias-label-secondary);
}

.sg--error .sg__text {
  color: var(--dsw-alias-state-error-primary);
}

.sg__appended {
  min-width: 0;
  overflow: hidden;
  color: var(--dsw-alias-label-caption);
  font-family: var(--dsw-font-family-code);
  font-size: 11px;
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>
