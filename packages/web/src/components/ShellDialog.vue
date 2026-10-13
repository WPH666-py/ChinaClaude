<script setup lang="ts">
/**
 * The one window shell every menu-bar dialog is built on.
 *
 * WHY A WRAPPER RATHER THAN EACH PANEL ROLLING ITS OWN: the scrim, the focus-obvious close button,
 * the escape key, and the header/body/footer rhythm are the parts that drift visibly between
 * windows when they are copy-pasted. They are also the parts a keyboard user notices first, so
 * getting them right in one place is worth more than the freedom to restyle each dialog.
 *
 * The body is a slot on purpose: a panel supplies content, never chrome.
 */
import { onBeforeUnmount, onMounted } from 'vue'

const props = withDefaults(
  defineProps<{
    title: string
    /** Shown next to the title; keep it short — it is a subtitle, not a paragraph. */
    meta?: string
    /** Max width in px. Wide windows (the shop grid) pass their own. */
    width?: number
  }>(),
  { meta: '', width: 720 },
)

const emit = defineEmits<{ (e: 'close'): void }>()

/** Escape closes, the way every other window in this app does. */
function onKey(event: KeyboardEvent) {
  if (event.key === 'Escape') emit('close')
}

onMounted(() => window.addEventListener('keydown', onKey))
onBeforeUnmount(() => window.removeEventListener('keydown', onKey))

void props
</script>

<template>
  <div class="sd">
    <div class="sd__scrim" @click="emit('close')" />

    <div class="sd__panel" :style="{ maxWidth: `${width}px` }" role="dialog" :aria-label="title">
      <header class="sd__head">
        <span class="sd__title">{{ title }}</span>
        <span v-if="meta" class="sd__meta">{{ meta }}</span>
        <span class="sd__spacer" />
        <slot name="actions" />
        <button class="iconButton" type="button" title="关闭" @click="emit('close')">
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" />
          </svg>
        </button>
      </header>

      <div class="sd__body">
        <slot />
      </div>

      <footer v-if="$slots.footer" class="sd__foot">
        <slot name="footer" />
      </footer>
    </div>
  </div>
</template>

<style scoped>
.sd {
  position: fixed;
  inset: 0;
  z-index: 60;
  display: grid;
  place-items: center;
  padding: 32px;
}

.sd__scrim {
  position: absolute;
  inset: 0;
  background: rgba(0, 0, 0, 0.5);
}

.sd__panel {
  position: relative;
  display: flex;
  flex-direction: column;
  width: 100%;
  max-height: 100%;
  border: 0.5px solid var(--dsw-alias-border-l2);
  border-radius: 16px;
  background: var(--dsw-alias-bg-layer-2);
  box-shadow: 0 16px 48px rgba(0, 0, 0, 0.5);
  overflow: hidden;
}

.sd__head {
  display: flex;
  flex: none;
  align-items: center;
  gap: 10px;
  padding: 12px 16px;
  border-bottom: 0.5px solid var(--dsw-alias-border-l1);
}

.sd__title {
  flex: none;
  font-size: 14px;
  font-weight: 600;
}

.sd__meta {
  min-width: 0;
  overflow: hidden;
  color: var(--dsw-alias-label-caption);
  font-size: 11.5px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.sd__spacer {
  flex: 1;
}

.sd__body {
  flex: 1;
  min-height: 120px;
  padding: 14px 16px;
  overflow-y: auto;
}

.sd__foot {
  display: flex;
  flex: none;
  flex-wrap: wrap;
  align-items: center;
  gap: 10px;
  padding: 10px 16px;
  border-top: 0.5px solid var(--dsw-alias-border-l1);
  color: var(--dsw-alias-label-caption);
  font-size: 11.5px;
}
</style>
