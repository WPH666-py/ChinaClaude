<script setup lang="ts">
/**
 * Workspace directory picker.
 *
 * A repo-owned modal rather than the OS dialog, so the picker looks and behaves identically
 * under `vite dev` in a browser and inside the Tauri webview — the Tauri dialog plugin would
 * give the desktop build a UI the browser build cannot have.
 *
 * Navigation model: root shortcuts on the left, one directory level at a time on the right.
 * "Select" confirms the directory currently being browsed, so the user can pick a folder
 * without entering it first.
 */
import { computed, onMounted, ref } from 'vue'
import { useBridge } from '../composables/useBridge'

const props = defineProps<{
  /** Directory the picker opens on. */
  initialPath: string
}>()

const emit = defineEmits<{
  (e: 'select', path: string): void
  (e: 'close'): void
}>()

const bridge = useBridge()

interface Root {
  label: string
  path: string
}

const roots = ref<Root[]>([])
const current = ref('')
const parent = ref<string | null>(null)
const isRoot = ref(false)
const entries = ref<Array<{ name: string; path: string }>>([])
const loading = ref(false)
const error = ref<string | null>(null)
const showHidden = ref(false)
/** Typed path for power users; kept in step with `current` unless being edited. */
const pathInput = ref(props.initialPath ?? '')

/** Split a path into clickable crumbs; handles both `\` and `/` and drive letters. */
const crumbs = computed(() => {
  const path = current.value
  if (!path) return []

  const driveMatch = path.match(/^([A-Za-z]:)[\\/]?/)
  const parts = path.split(/[\\/]+/).filter(Boolean)
  const result: Array<{ label: string; path: string }> = []

  let consumed = ''
  for (const part of parts) {
    // The first segment of a Windows path is the drive itself ("C:") — appending a
    // separator would produce "C:\" twice.
    if (driveMatch && part === driveMatch[1]) {
      consumed = part + '\\'
      result.push({ label: part, path: consumed })
      continue
    }
    consumed = consumed ? consumed.replace(/[\\/]+$/, '') + '\\' + part : part + '\\'
    result.push({ label: part, path: consumed })
  }
  return result
})

async function loadRoots() {
  try {
    const result = await fetch(`${bridge.baseUrl.value}/api/directories/roots`).then((r) => r.json())
    roots.value = result.roots ?? []
  } catch {
    roots.value = []
  }
}

async function open(path: string) {
  loading.value = true
  error.value = null
  try {
    const query = new URLSearchParams({ path })
    if (showHidden.value) query.set('hidden', '1')
    const response = await fetch(`${bridge.baseUrl.value}/api/directories?${query}`)
    const payload = await response.json()
    if (!response.ok) {
      error.value = payload?.error ?? `无法打开 ${path}`
      return
    }
    current.value = payload.path
    pathInput.value = payload.path
    parent.value = payload.parent
    isRoot.value = payload.isRoot === true
    entries.value = payload.entries ?? []
  } catch (cause) {
    error.value = String((cause as Error).message ?? cause)
  } finally {
    loading.value = false
  }
}

async function toggleHidden() {
  showHidden.value = !showHidden.value
  if (current.value) await open(current.value)
}

function confirm() {
  if (current.value) emit('select', current.value)
}

async function submitPathInput() {
  if (pathInput.value.trim()) await open(pathInput.value.trim())
}

function onKeydown(event: KeyboardEvent) {
  if (event.key === 'Escape') emit('close')
  if (event.key === 'Enter' && (event.target as HTMLElement)?.tagName === 'INPUT') {
    event.preventDefault()
    void submitPathInput()
  }
}

onMounted(async () => {
  await loadRoots()
  await open(props.initialPath || '')
})
</script>

<template>
  <div class="picker" @keydown="onKeydown">
    <div class="picker__scrim" @click="$emit('close')" />

    <div class="picker__panel" role="dialog" aria-label="选择工作目录">
      <header class="picker__head">
        <span class="picker__title">选择工作目录</span>
        <button class="iconButton" type="button" title="关闭" @click="$emit('close')">
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" />
          </svg>
        </button>
      </header>

      <!-- path input + breadcrumbs -->
      <div class="picker__pathBar">
        <button
          class="iconButton"
          type="button"
          title="上一级"
          :disabled="!parent"
          @click="parent && open(parent)"
        >
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <path d="M10 3L5 8l5 5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" />
          </svg>
        </button>
        <input
          v-model="pathInput"
          class="picker__pathInput"
          spellcheck="false"
          placeholder="输入路径后回车，或从下方选择"
          @keydown.enter="submitPathInput"
        />
        <button class="btnGhost" type="button" @click="toggleHidden">
          {{ showHidden ? '隐藏点目录' : '显示点目录' }}
        </button>
      </div>

      <div class="picker__crumbs">
        <template v-for="(crumb, index) in crumbs" :key="crumb.path">
          <span v-if="index > 0" class="picker__crumbSep">›</span>
          <button class="picker__crumb" type="button" @click="open(crumb.path)">{{ crumb.label }}</button>
        </template>
      </div>

      <!-- roots + entries -->
      <div class="picker__body">
        <div class="picker__roots">
          <div class="picker__sectionLabel">快速访问</div>
          <button
            v-for="root in roots"
            :key="root.path"
            class="picker__root"
            :class="{ 'picker__root--active': root.path === current }"
            type="button"
            @click="open(root.path)"
          >
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <path d="M2 5.5A1.5 1.5 0 013.5 4h2.2l1.2 1.4h5.6A1.5 1.5 0 0114 6.9v4.6A1.5 1.5 0 0112.5 13h-9A1.5 1.5 0 012 11.5v-6z" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round" />
            </svg>
            <span class="picker__rootLabel">{{ root.label }}</span>
          </button>
        </div>

        <div class="picker__list">
          <div v-if="error" class="banner banner--error" style="margin: 10px 12px">{{ error }}</div>
          <div v-if="loading" class="picker__status"><span class="spinner" /> 读取中…</div>
          <div v-else-if="!error && entries.length === 0" class="picker__status">此目录下没有子目录</div>

          <button
            v-for="entry in entries"
            :key="entry.path"
            class="picker__entry"
            type="button"
            @dblclick="open(entry.path)"
            @click="open(entry.path)"
          >
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <path d="M2 5.5A1.5 1.5 0 013.5 4h2.2l1.2 1.4h5.6A1.5 1.5 0 0114 6.9v4.6A1.5 1.5 0 0112.5 13h-9A1.5 1.5 0 012 11.5v-6z" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round" />
            </svg>
            <span class="picker__entryName">{{ entry.name }}</span>
            <span class="picker__entryGo">›</span>
          </button>
        </div>
      </div>

      <footer class="picker__foot">
        <span class="picker__selected" :title="current">将使用：{{ current || '—' }}</span>
        <span class="picker__spacer" />
        <button class="btnGhost" type="button" @click="$emit('close')">取消</button>
        <button class="btnPrimary picker__confirm" type="button" :disabled="!current" @click="confirm">
          选择此目录
        </button>
      </footer>
    </div>
  </div>
</template>

<style scoped>
.picker {
  position: fixed;
  inset: 0;
  z-index: 50;
  display: grid;
  place-items: center;
  padding: 32px;
}

.picker__scrim {
  position: absolute;
  inset: 0;
  background: rgba(0, 0, 0, 0.5);
}

.picker__panel {
  position: relative;
  display: flex;
  flex-direction: column;
  width: 100%;
  max-width: 720px;
  max-height: 100%;
  border: 0.5px solid var(--dsw-alias-border-l2);
  border-radius: 16px;
  background: var(--dsw-alias-bg-layer-2);
  box-shadow: 0 16px 48px rgba(0, 0, 0, 0.5);
  overflow: hidden;
}

.picker__head {
  display: flex;
  flex: none;
  align-items: center;
  justify-content: space-between;
  padding: 12px 16px;
  border-bottom: 0.5px solid var(--dsw-alias-border-l1);
}

.picker__title {
  font-size: 14px;
  font-weight: 600;
}

.picker__pathBar {
  display: flex;
  flex: none;
  align-items: center;
  gap: 8px;
  padding: 10px 16px 6px;
}

.picker__pathInput {
  flex: 1;
  min-width: 0;
  padding: 7px 11px;
  border: 0.5px solid var(--dsw-alias-border-l2);
  border-radius: 8px;
  background: var(--dsw-static-neutral-bluish-900);
  outline: none;
  color: var(--dsw-alias-label-primary);
  font-family: var(--dsw-font-family-code);
  font-size: 12px;
}

.picker__pathInput:focus {
  border-color: var(--dsw-alias-state-business-primary);
}

.picker__crumbs {
  display: flex;
  flex: none;
  flex-wrap: wrap;
  align-items: center;
  gap: 2px;
  padding: 0 16px 8px;
  overflow: hidden;
}

.picker__crumb {
  padding: 2px 6px;
  border-radius: 5px;
  color: var(--dsw-alias-label-tertiary);
  font-size: 11.5px;
}

.picker__crumb:hover {
  background: var(--dsw-alias-interactive-bg-hover);
  color: var(--dsw-alias-label-primary);
}

.picker__crumbSep {
  color: var(--dsw-alias-label-caption);
  font-size: 11.5px;
}

.picker__body {
  display: grid;
  grid-template-columns: 168px minmax(0, 1fr);
  flex: 1;
  min-height: 260px;
  border-top: 0.5px solid var(--dsw-alias-border-l1);
  overflow: hidden;
}

.picker__roots {
  padding: 8px;
  border-right: 0.5px solid var(--dsw-alias-border-l1);
  background: var(--dsw-alias-bg-layer-1);
  overflow-y: auto;
}

.picker__sectionLabel {
  padding: 4px 8px 6px;
  color: var(--dsw-alias-label-caption);
  font-size: 10.5px;
  font-weight: 600;
  letter-spacing: 0.06em;
  text-transform: uppercase;
}

.picker__root {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 6px 8px;
  border-radius: 7px;
  color: var(--dsw-alias-label-secondary);
  font-size: 12.5px;
  text-align: left;
}

.picker__root:hover {
  background: var(--dsw-alias-interactive-bg-hover);
}

.picker__root--active {
  background: var(--dsw-alias-interactive-bg-active);
  color: var(--dsw-alias-label-primary);
}

.picker__rootLabel {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.picker__list {
  min-width: 0;
  padding: 6px;
  overflow-y: auto;
}

.picker__entry {
  display: flex;
  align-items: center;
  gap: 9px;
  width: 100%;
  padding: 7px 9px;
  border-radius: 7px;
  color: var(--dsw-alias-label-secondary);
  font-size: 13px;
  text-align: left;
}

.picker__entry:hover {
  background: var(--dsw-alias-interactive-bg-hover);
  color: var(--dsw-alias-label-primary);
}

.picker__entryName {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.picker__entryGo {
  margin-left: auto;
  color: var(--dsw-alias-label-caption);
}

.picker__status {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 16px 12px;
  color: var(--dsw-alias-label-caption);
  font-size: 12.5px;
}

.picker__foot {
  display: flex;
  flex: none;
  align-items: center;
  gap: 10px;
  padding: 12px 16px;
  border-top: 0.5px solid var(--dsw-alias-border-l1);
}

.picker__selected {
  min-width: 0;
  overflow: hidden;
  color: var(--dsw-alias-label-caption);
  font-family: var(--dsw-font-family-code);
  font-size: 11.5px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.picker__spacer {
  flex: 1;
}

.picker__confirm {
  width: auto;
  height: 34px;
  margin: 0;
  padding: 0 18px;
  border-radius: 10px;
}
</style>
