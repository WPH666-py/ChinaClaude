<script setup lang="ts">
/**
 * 项目记忆 — the durable notes one workspace keeps for itself.
 *
 * WHY IT REFUSES TO GUESS A WORKSPACE: notes are keyed by the project directory, and picking one here
 * (the install folder, the last session's cwd) would file them under a store nobody will ever open
 * again — the failure looks like "the app forgot my notes". So with no workspace open the form is
 * disabled and the reason is on screen, the same rule the plugin list uses before it opens this window.
 *
 * Everything is scoped to `props.cwd`: switching workspace mid-window reloads rather than mixing two
 * projects' notes in one list.
 */
import { computed, onMounted, ref, watch } from 'vue'
import ShellDialog from './ShellDialog.vue'

const props = defineProps<{
  /** The open workspace. Absent means no project is open, which disables every write. */
  cwd?: string | null
}>()

const emit = defineEmits<{ (e: 'close'): void }>()

/** One stored note — mirrors what `bridge/memory.mjs` returns. */
interface MemoryEntry {
  id: string
  at: number
  kind: string
  text: string
  tags: string[]
}

interface MemoryAnswer {
  ok: boolean
  error?: string
  cwd?: string
  file?: string
  entries?: MemoryEntry[]
}

interface ExportAnswer {
  ok: boolean
  error?: string
  path?: string
  markdown?: string
}

/** The four kinds the bridge accepts, labelled for the select and the badges. */
const KIND_OPTIONS = [
  { value: 'fact', label: '事实' },
  { value: 'decision', label: '决定' },
  { value: 'pitfall', label: '坑' },
  { value: 'todo', label: '待办' },
]

/**
 * The bridge client, kept local on purpose.
 *
 * Base-URL resolution follows `useBridge` / `useShellApi` character for character — injected shell
 * value, then `?bridge=`, then the dev proxy (empty, because vite proxies `/api`). This window is
 * opened from the plugin list and has to work with no session attached, so it deliberately does not
 * pull in the session composable's state to reach the bridge.
 */
function baseUrl(): string {
  const injected = (globalThis as Record<string, unknown>).__CCCN_BRIDGE_URL__
  if (typeof injected === 'string' && injected.length > 0) return injected.replace(/\/$/, '')
  const param = new URLSearchParams(location.search).get('bridge')
  if (param) return param.replace(/\/$/, '')
  return import.meta.env.DEV ? '' : 'http://127.0.0.1:43130'
}

/**
 * One request.
 *
 * A non-2xx status is an error; `ok: false` inside a 200 body is not. The bridge answers "this
 * workspace does not exist" as data with a Chinese sentence, and the panel has to show that sentence
 * instead of a generic fetch failure.
 */
async function call<T>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(`${baseUrl()}${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  if (!response.ok) throw new Error(`HTTP ${response.status}`)
  return (await response.json()) as T
}

const entries = ref<MemoryEntry[]>([])
const storePath = ref('')
const exportPath = ref('')
const draftText = ref('')
const draftKind = ref('fact')
const draftTags = ref('')
const loading = ref(false)
const busy = ref(false)
const error = ref<string | null>(null)
const notice = ref<string | null>(null)

/** The workspace every call is scoped to; empty means no project is open. */
const workspace = computed(() => (props.cwd ?? '').trim())

/** Badge text for a kind, including one the store did not recognise (older or hand-edited file). */
function kindLabel(kind: string): string {
  return KIND_OPTIONS.find((option) => option.value === kind)?.label ?? kind
}

/** `MM-DD HH:mm` — the year is in the tooltip; a list of notes is read at a glance, not audited. */
function formatAt(at: number): string {
  const date = new Date(at)
  // A missing timestamp (hand-edited store) shows as unknown rather than as 1970 or 1970-01-01 08:00.
  if (!at || Number.isNaN(date.getTime())) return '时间未知'
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

function fullAt(at: number): string {
  const date = new Date(at)
  return !at || Number.isNaN(date.getTime()) ? '时间未知' : date.toLocaleString('zh-CN')
}

/** Tags are typed as free text; both comma forms and whitespace separate them. */
function splitTags(value: string): string[] {
  return value
    .split(/[,，、\s]+/)
    .map((tag) => tag.trim())
    .filter(Boolean)
}

function report(problem: unknown) {
  error.value = problem instanceof Error ? problem.message : String(problem)
}

async function load() {
  if (!workspace.value) {
    entries.value = []
    storePath.value = ''
    return
  }
  loading.value = true
  error.value = null
  try {
    const answer = await call<MemoryAnswer>(`/api/memory?cwd=${encodeURIComponent(workspace.value)}`)
    if (!answer.ok) {
      error.value = answer.error ?? '读取失败'
      entries.value = []
      return
    }
    entries.value = answer.entries ?? []
    storePath.value = answer.file ?? ''
  } catch (problem) {
    entries.value = []
    report(problem)
  } finally {
    loading.value = false
  }
}

async function add() {
  if (!workspace.value)
    return
  const text = draftText.value.trim()
  if (!text) {
    error.value = '内容不能为空'
    return
  }
  busy.value = true
  error.value = null
  notice.value = null
  try {
    const answer = await call<MemoryAnswer>('/api/memory', {
      action: 'add',
      cwd: workspace.value,
      text,
      kind: draftKind.value,
      tags: splitTags(draftTags.value),
    })
    if (!answer.ok) {
      error.value = answer.error ?? '保存失败'
      return
    }
    draftText.value = ''
    draftTags.value = ''
    // Reload rather than pushing the returned entry: the store's own order is what the list claims to
    // show, and a second window adding a note must not leave this one displaying a stale list.
    await load()
    notice.value = '已记下'
  } catch (problem) {
    report(problem)
  } finally {
    busy.value = false
  }
}

async function remove(id: string) {
  if (!workspace.value)
    return
  busy.value = true
  error.value = null
  notice.value = null
  try {
    const answer = await call<MemoryAnswer>('/api/memory', { action: 'remove', cwd: workspace.value, id })
    if (!answer.ok) {
      error.value = answer.error ?? '删除失败'
      return
    }
    exportPath.value = ''
    await load()
  } catch (problem) {
    report(problem)
  } finally {
    busy.value = false
  }
}

async function exportMarkdown() {
  if (!workspace.value)
    return
  busy.value = true
  error.value = null
  notice.value = null
  try {
    const answer = await call<ExportAnswer>('/api/memory', { action: 'export', cwd: workspace.value })
    if (!answer.ok) {
      error.value = answer.error ?? '导出失败'
      return
    }
    // The path is shown rather than a bare "已导出": the whole value of the file is that the user knows
    // where it is and can read what the agent will read.
    exportPath.value = answer.path ?? ''
    notice.value = `已写入 ${answer.path ?? ''}`
  } catch (problem) {
    report(problem)
  } finally {
    busy.value = false
  }
}

onMounted(() => void load())
watch(
  () => props.cwd,
  () => {
    exportPath.value = ''
    notice.value = null
    void load()
  },
)
</script>

<template>
  <ShellDialog
    title="项目记忆"
    :meta="workspace ? `工作区 ${workspace}` : '未打开工作区'"
    :width="780"
    @close="emit('close')"
  >
    <template #actions>
      <span v-if="loading" class="spinner" />
    </template>

    <p class="mp__lead">把项目里定下来的事实和踩过的坑记下来，下个会话不用重新推导。</p>

    <div v-if="!workspace" class="mp__notice">
      还没有打开工作区。记忆按项目目录分开存放，先在侧边栏打开一个项目，再回到这个窗口。
    </div>

    <div class="mp__form">
      <textarea
        v-model="draftText"
        class="mp__text"
        rows="3"
        spellcheck="false"
        :disabled="!workspace || busy"
        placeholder="记一条：例如「网关只认 HTTPS，内网代理会改包体」"
      />
      <div class="mp__row">
        <select v-model="draftKind" class="mp__select" :disabled="!workspace || busy">
          <option v-for="option in KIND_OPTIONS" :key="option.value" :value="option.value">
            {{ option.label }}
          </option>
        </select>
        <input
          v-model="draftTags"
          class="mp__input"
          spellcheck="false"
          :disabled="!workspace || busy"
          placeholder="标签，逗号分隔（可选）"
        />
        <button
          class="btnPrimary mp__add"
          type="button"
          :disabled="!workspace || busy || !draftText.trim()"
          @click="add"
        >
          添加
        </button>
      </div>
    </div>

    <div v-if="error" class="mp__error">{{ error }}</div>

    <div class="mp__listHead">
      <span>已记录 {{ entries.length }} 条</span>
      <span v-if="notice" class="mp__ok">{{ notice }}</span>
      <span class="mp__spacer" />
      <span class="mp__counter">只读时也保留原文，导出不覆盖标记以外的内容</span>
    </div>

    <div v-if="loading && entries.length === 0" class="mp__waiting">
      <span class="spinner" />
      正在读取…
    </div>
    <div v-else-if="entries.length === 0" class="mp__empty">
      还没有记录。写下第一条，下个会话的你就少推导一遍。
    </div>
    <ul v-else class="mp__list">
      <li v-for="entry in entries" :key="entry.id" class="mp__item">
        <div class="mp__itemHead">
          <span class="mp__kind">{{ kindLabel(entry.kind) }}</span>
          <span class="mp__time" :title="fullAt(entry.at)">{{ formatAt(entry.at) }}</span>
          <span v-for="tag in entry.tags" :key="tag" class="mp__tag">{{ tag }}</span>
          <span class="mp__spacer" />
          <button class="btnGhost mp__del" type="button" :disabled="busy" @click="remove(entry.id)">
            删除
          </button>
        </div>
        <p class="mp__body">{{ entry.text }}</p>
      </li>
    </ul>

    <template #footer>
      <button
        class="btnPrimary mp__export"
        type="button"
        :disabled="!workspace || busy"
        @click="exportMarkdown"
      >
        导出为 CLAUDE.memory.md
      </button>
      <button class="btnGhost" type="button" :disabled="!workspace || loading" @click="load">刷新</button>
      <span class="mp__spacer" />
      <span class="mp__counter mp__counter--warn">
        新建会话时自动注入（上限 4000 字，最近的优先）；导出的是给人看的 Markdown，CLI 不会自动读它
      </span>
      <span class="mp__spacer" />
      <span v-if="exportPath" class="mp__path" :title="exportPath">已写入 {{ exportPath }}</span>
      <span v-else-if="storePath" class="mp__path" :title="storePath">存放于 {{ storePath }}</span>
    </template>
  </ShellDialog>
</template>

<style scoped>
.mp__lead {
  margin: 0 0 12px;
  color: var(--dsw-alias-label-secondary);
  font-size: 12px;
  line-height: 19px;
}

.mp__notice {
  margin-bottom: 12px;
  padding: 9px 11px;
  border: 0.5px solid var(--dsw-alias-state-warn-secondary);
  border-radius: 8px;
  background: var(--dsw-alias-state-warn-tertiary);
  color: var(--dsw-alias-label-secondary);
  font-size: 12px;
  line-height: 18px;
}

.mp__form {
  display: grid;
  gap: 8px;
  margin-bottom: 12px;
}

.mp__text,
.mp__input,
.mp__select {
  min-width: 0;
  padding: 7px 11px;
  border: 0.5px solid var(--dsw-alias-border-l2);
  border-radius: 8px;
  background: var(--dsw-static-neutral-bluish-900);
  outline: none;
  color: var(--dsw-alias-label-primary);
  font-size: 12.5px;
}

.mp__text {
  width: 100%;
  resize: vertical;
  line-height: 18px;
}

.mp__text:focus,
.mp__input:focus,
.mp__select:focus {
  border-color: var(--dsw-alias-state-business-primary);
}

.mp__text:disabled,
.mp__input:disabled,
.mp__select:disabled {
  opacity: 0.5;
}

.mp__row {
  display: flex;
  align-items: center;
  gap: 8px;
}

.mp__select {
  flex: none;
  width: 92px;
}

.mp__input {
  flex: 1;
}

/* `.btnPrimary` is full-width by design (it is a dialog's confirm button); this one sits in a row. */
.mp__add,
.mp__export {
  flex: none;
  width: auto;
  height: 32px;
  margin: 0;
  padding: 0 16px;
}

.mp__error {
  margin-bottom: 10px;
  padding: 8px 11px;
  border: 0.5px solid var(--dsw-alias-state-error-primary);
  border-radius: 8px;
  background: var(--dsw-alias-interactive-bg-hover-danger);
  color: var(--dsw-alias-state-error-primary);
  font-size: 12px;
}

.mp__listHead {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  margin-bottom: 6px;
  color: var(--dsw-alias-label-caption);
  font-size: 11.5px;
}

.mp__ok {
  color: var(--dsw-alias-state-success-secondary);
}

.mp__counter {
  color: var(--dsw-alias-label-caption);
}

/* The one line in this window that is a caveat rather than a status: it says what the export does
   NOT do, which the old copy got wrong by naming a file the CLI never reads. */
.mp__counter--warn {
  color: var(--dsw-alias-state-warn-secondary);
}

.mp__spacer {
  flex: 1;
  min-width: 8px;
}

.mp__waiting,
.mp__empty {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 9px;
  padding: 26px 4px;
  color: var(--dsw-alias-label-caption);
  font-size: 12.5px;
}

.mp__list {
  margin: 0;
  padding: 0;
  list-style: none;
}

.mp__item {
  padding: 9px 10px;
  border-bottom: 0.5px solid var(--dsw-alias-border-l1);
  border-radius: 8px;
}

.mp__item:hover {
  background: var(--dsw-alias-interactive-bg-hover);
}

.mp__itemHead {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 7px;
}

.mp__kind {
  flex: none;
  padding: 1px 7px;
  border-radius: 5px;
  background: var(--dsw-alias-bg-layer-3);
  color: var(--dsw-alias-label-tertiary);
  font-size: 10.5px;
  font-weight: 600;
}

.mp__time {
  color: var(--dsw-alias-label-caption);
  font-family: var(--dsw-font-family-code);
  font-size: 11px;
}

.mp__tag {
  flex: none;
  padding: 1px 8px;
  border: 0.5px solid var(--dsw-alias-border-l1);
  border-radius: 999px;
  background: var(--dsw-alias-bg-layer-1);
  color: var(--dsw-alias-label-tertiary);
  font-family: var(--dsw-font-family-code);
  font-size: 10.5px;
}

.mp__del {
  padding: 4px 10px;
  font-size: 11.5px;
}

.mp__body {
  margin: 6px 0 0;
  color: var(--dsw-alias-label-secondary);
  font-size: 12.5px;
  line-height: 19px;
  white-space: pre-wrap;
  word-break: break-word;
}

.mp__path {
  min-width: 0;
  overflow: hidden;
  color: var(--dsw-alias-label-caption);
  font-family: var(--dsw-font-family-code);
  font-size: 10.5px;
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>
