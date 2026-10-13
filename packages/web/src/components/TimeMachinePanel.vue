<script setup lang="ts">
/**
 * 时间机器: workspace checkpoints for the currently open working directory.
 *
 * WHY IT TALKS TO /api/checkpoints DIRECTLY INSTEAD OF useBridge: the bridge composable owns the
 * session, the event stream and the polling loop for the whole app; a dialog that appears for ten
 * seconds has no business being a fourth subscriber to that state. Three one-shot calls against one
 * route keep the dialog self-contained, and the base URL is resolved with the same three-step rule
 * useBridge uses, so both land on the same bridge under `vite dev` and inside the Tauri webview.
 *
 * WHY EVERY DESTRUCTIVE CONTROL NEEDS TWO CLICKS: a checkpoint's whole purpose is to be the thing you
 * fall back on, and "回滚" next to "删除" in a list is one stray click away from overwriting the work
 * the user came here to protect. The second click states exactly what it will do and to how many
 * files — a confirmation that does not name the number is not a confirmation.
 */
import { computed, onMounted, ref, watch } from 'vue'
import ShellDialog from './ShellDialog.vue'

const props = defineProps<{
  /** The open workspace. Without one there is nothing to snapshot, and the panel says so. */
  cwd?: string | null
}>()

const emit = defineEmits<{
  (e: 'close'): void
}>()

type CheckpointItem = { id: string; label: string; at: string; fileCount: number; bytes: number; note: string }
type DiffStatus = 'added' | 'removed' | 'modified' | 'unchanged'
type DiffEntry = { path: string; status: DiffStatus; added: number; removed: number; binary: boolean }
type SkipEntry = { path: string; reason: string }

type ListResult = { ok: boolean; error?: string; cwd?: string | null; store?: string | null; items?: CheckpointItem[] }
type CreateResult = { ok: boolean; error?: string; item?: CheckpointItem; skipped?: string[]; pruned?: string[] }
type DiffResult = { ok: boolean; error?: string; entries?: DiffEntry[]; changed?: number; truncated?: boolean; warning?: string }
type RestoreResult = {
  ok: boolean
  error?: string
  restored?: string[]
  deleted?: string[]
  kept?: string[]
  keptTotal?: number
  skipped?: SkipEntry[]
}
type UsageResult = { ok: boolean; error?: string; root?: string; count?: number; bytes?: number; workspaces?: number }

/** Base URL, resolved exactly like useBridge's resolveBaseUrl: injected shell value, `?bridge=`, dev proxy. */
function resolveBaseUrl(): string {
  const injected = (globalThis as Record<string, unknown>).__CCCN_BRIDGE_URL__
  if (typeof injected === 'string' && injected.length > 0) return injected.replace(/\/$/, '')
  const param = new URLSearchParams(location.search).get('bridge')
  if (param) return param.replace(/\/$/, '')
  // vite dev proxies /api, so an empty base is correct there.
  return import.meta.env.DEV ? '' : 'http://127.0.0.1:43130'
}

const baseUrl = resolveBaseUrl()

function describe(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}

const items = ref<CheckpointItem[]>([])
const usage = ref<UsageResult | null>(null)
const loading = ref(false)
const error = ref<string | null>(null)
const notice = ref<string | null>(null)
/** Skip lines from the last create: the panel's answer to "why is this snapshot so small". */
const lastSkips = ref<string[]>([])

const naming = ref(false)
const newLabel = ref('')
const creating = ref(false)

const view = ref<'list' | 'diff'>('list')
const diffFor = ref<CheckpointItem | null>(null)
const diffEntries = ref<DiffEntry[]>([])
const diffLoading = ref(false)
const diffWarn = ref('')
const selected = ref<Set<string>>(new Set())

const confirmRestore = ref(false)
const restoring = ref(false)
/** Which row is asking for its second click, and for what. */
const rowConfirm = ref<{ id: string; kind: 'restore' | 'delete' } | null>(null)
const rowBusy = ref<string | null>(null)

const usageLine = computed(() => {
  const current = usage.value
  if (current?.ok) return `快照 ${current.count ?? 0} 个 · 占用 ${formatBytes(current.bytes ?? 0)}`
  return `快照 ${items.value.length} 个`
})

const changedCount = computed(() => diffEntries.value.filter((entry) => entry.status !== 'unchanged').length)
const selectable = computed(() => diffEntries.value.filter((entry) => isRestorable(entry)))
const allSelected = computed(
  () => selectable.value.length > 0 && selectable.value.every((entry) => selected.value.has(entry.path)),
)

/**
 * `added` rows have nothing to write back — the snapshot predates the file — so they are listed and
 * never selectable. Deleting files the snapshot never knew about is exactly the destructive guess a
 * restore must not make.
 */
function isRestorable(entry: DiffEntry): boolean {
  return entry.status !== 'added'
}

function statusLabel(status: DiffStatus): string {
  if (status === 'added') return '新增'
  if (status === 'modified') return '修改'
  if (status === 'removed') return '缺失'
  return '未变'
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`
}

/**
 * Local relative time, written here rather than piped through Intl.RelativeTimeFormat: the wording
 * has to match the rest of the Chinese UI ("3 分钟前"), and a UTC timestamp from the bridge must be
 * read in the user's own timezone.
 */
function formatTime(iso: string): string {
  const at = new Date(iso)
  if (Number.isNaN(at.getTime())) return '时间未知'
  const elapsed = Date.now() - at.getTime()
  if (elapsed < 0) return at.toLocaleString('zh-CN', { hour: '2-digit', minute: '2-digit' })
  if (elapsed < 60_000) return '刚刚'
  if (elapsed < 3_600_000) return `${Math.floor(elapsed / 60_000)} 分钟前`
  if (elapsed < 86_400_000) return `${Math.floor(elapsed / 3_600_000)} 小时前`
  if (elapsed < 7 * 86_400_000) return `${Math.floor(elapsed / 86_400_000)} 天前`
  return at.toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
}

function absoluteTime(iso: string): string {
  const at = new Date(iso)
  return Number.isNaN(at.getTime()) ? '' : at.toLocaleString('zh-CN')
}

async function post<T>(body: Record<string, unknown>): Promise<T> {
  const response = await fetch(`${baseUrl}/api/checkpoints`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!response.ok) throw new Error(`桥接返回 ${response.status}`)
  return (await response.json()) as T
}

async function loadList() {
  const cwd = props.cwd
  if (!cwd) {
    items.value = []
    return
  }
  loading.value = true
  try {
    const response = await fetch(`${baseUrl}/api/checkpoints?cwd=${encodeURIComponent(cwd)}`)
    if (!response.ok) throw new Error(`桥接返回 ${response.status}`)
    const result = (await response.json()) as ListResult
    if (!result.ok) {
      items.value = []
      error.value = result.error ?? '读取快照列表失败'
      return
    }
    items.value = result.items ?? []
  } catch (cause) {
    error.value = describe(cause)
  } finally {
    loading.value = false
  }
}

async function loadUsage() {
  try {
    const result = await post<UsageResult>({ action: 'usage' })
    if (result.ok) usage.value = result
  } catch {
    // The usage line is a decoration; failing to read it must not block the actual feature.
  }
}

async function refresh() {
  await Promise.all([loadList(), loadUsage()])
}

/** Back to the list, with nothing half-answered: an open confirm must not survive a workspace switch. */
function resetView() {
  view.value = 'list'
  diffFor.value = null
  diffEntries.value = []
  diffWarn.value = ''
  selected.value = new Set()
  confirmRestore.value = false
  rowConfirm.value = null
  error.value = null
  notice.value = null
  lastSkips.value = []
  naming.value = false
  newLabel.value = ''
}

onMounted(() => {
  void refresh()
})

watch(
  () => props.cwd,
  () => {
    resetView()
    void refresh()
  },
)

function startNaming() {
  naming.value = true
  newLabel.value = ''
}

function cancelNaming() {
  naming.value = false
  newLabel.value = ''
}

async function submitCreate() {
  const cwd = props.cwd
  if (!cwd || creating.value) return
  creating.value = true
  error.value = null
  try {
    const result = await post<CreateResult>({ action: 'create', cwd, label: newLabel.value.trim(), note: '' })
    if (!result.ok || !result.item) {
      error.value = result.error ?? '创建检查点失败'
      return
    }
    naming.value = false
    newLabel.value = ''
    lastSkips.value = result.skipped ?? []
    const pruned = result.pruned?.length ?? 0
    notice.value = `已创建「${result.item.label}」，纳入 ${result.item.fileCount} 个文件 · ${formatBytes(result.item.bytes)}${
      pruned > 0 ? `，并按上限清理了最旧的 ${pruned} 个快照` : ''
    }`
    await refresh()
  } catch (cause) {
    error.value = describe(cause)
  } finally {
    creating.value = false
  }
}

async function openDiff(item: CheckpointItem) {
  const cwd = props.cwd
  if (!cwd) return
  view.value = 'diff'
  diffFor.value = item
  diffEntries.value = []
  diffWarn.value = ''
  selected.value = new Set()
  confirmRestore.value = false
  error.value = null
  notice.value = null
  diffLoading.value = true
  try {
    const result = await post<DiffResult>({ action: 'diff', cwd, id: item.id })
    if (!result.ok) {
      error.value = result.error ?? '比对失败'
      return
    }
    diffEntries.value = result.entries ?? []
    diffWarn.value = result.truncated ? result.warning ?? '工作区较大，仅比对了已纳入快照范围的文件' : ''
    // Pre-select what a restore can actually change: files already identical to the snapshot are
    // listed (so the row count matches reality) but ticking them by default would only rewrite
    // identical bytes.
    selected.value = new Set(
      diffEntries.value
        .filter((entry) => entry.status === 'modified' || entry.status === 'removed')
        .map((entry) => entry.path),
    )
  } catch (cause) {
    error.value = describe(cause)
  } finally {
    diffLoading.value = false
  }
}

function backToList() {
  view.value = 'list'
  diffFor.value = null
  diffEntries.value = []
  selected.value = new Set()
  confirmRestore.value = false
  error.value = null
}

function toggle(path: string) {
  const next = new Set(selected.value)
  if (next.has(path)) next.delete(path)
  else next.add(path)
  selected.value = next
}

function toggleAll() {
  if (allSelected.value) {
    selected.value = new Set()
    return
  }
  selected.value = new Set(selectable.value.map((entry) => entry.path))
}

/** The one line every rollback has to produce: what was written, what was left alone, what was not. */
function rollbackLine(result: RestoreResult): string {
  const restored = result.restored?.length ?? 0
  const kept = result.keptTotal ?? result.kept?.length ?? 0
  const skipped = result.skipped?.length ?? 0
  return `恢复了 ${restored} 个文件 · 保留 ${kept} 个快照外的文件 · 跳过 ${skipped} 个`
}

async function doRestoreSelected() {
  const cwd = props.cwd
  const target = diffFor.value
  if (!cwd || !target || restoring.value) return
  restoring.value = true
  error.value = null
  confirmRestore.value = false
  const files = [...selected.value]
  try {
    const result = await post<RestoreResult>({ action: 'restore', cwd, id: target.id, files })
    if (!result.ok) error.value = result.error ?? '回滚失败'
    const line = rollbackLine(result)
    await refresh()
    // Re-read the diff so the table shows the workspace as it is now rather than the rows the user
    // just resolved, then put the report back: openDiff clears it.
    await openDiff(target)
    notice.value = line
  } catch (cause) {
    error.value = describe(cause)
  } finally {
    restoring.value = false
  }
}

async function doRestoreWhole(item: CheckpointItem) {
  const cwd = props.cwd
  if (!cwd || rowBusy.value) return
  rowBusy.value = item.id
  error.value = null
  rowConfirm.value = null
  try {
    const result = await post<RestoreResult>({ action: 'restore', cwd, id: item.id })
    if (!result.ok) error.value = result.error ?? '回滚失败'
    notice.value = `「${item.label}」${rollbackLine(result)}`
    await refresh()
  } catch (cause) {
    error.value = describe(cause)
  } finally {
    rowBusy.value = null
  }
}

async function doDelete(item: CheckpointItem) {
  const cwd = props.cwd
  if (!cwd || rowBusy.value) return
  rowBusy.value = item.id
  error.value = null
  rowConfirm.value = null
  try {
    const result = await post<{ ok: boolean; error?: string }>({ action: 'delete', cwd, id: item.id })
    if (!result.ok) {
      error.value = result.error ?? '删除失败'
      return
    }
    if (diffFor.value?.id === item.id) backToList()
    notice.value = `已删除快照「${item.label}」`
    await refresh()
  } catch (cause) {
    error.value = describe(cause)
  } finally {
    rowBusy.value = null
  }
}
</script>

<template>
  <ShellDialog title="时间机器" :meta="usageLine" :width="880" @close="emit('close')">
    <template #actions>
      <button
        v-if="!naming"
        class="btnGhost btnGhost--icon"
        type="button"
        :disabled="!cwd || creating"
        @click="startNaming"
      >
        新建检查点
      </button>
      <form v-else class="tm__new" @submit.prevent="submitCreate">
        <input
          v-model="newLabel"
          class="field__input tm__newInput"
          maxlength="60"
          spellcheck="false"
          placeholder="快照名称（可留空）"
        />
        <button class="tinyButton tinyButton--primary" type="submit" :disabled="creating">
          {{ creating ? '创建中…' : '创建' }}
        </button>
        <button class="tinyButton tinyButton--text" type="button" @click="cancelNaming">取消</button>
      </form>
    </template>

    <p v-if="!cwd" class="tm__hint">需要先打开一个工作目录，时间机器才知道给哪个目录拍快照。</p>

    <template v-else>
      <p v-if="error" class="tm__error">{{ error }}</p>
      <p v-if="notice" class="tm__ok">{{ notice }}</p>

      <details v-if="lastSkips.length > 0" class="tm__skips">
        <summary>本次快照跳过了 {{ lastSkips.length }} 项（未纳入快照）</summary>
        <ul class="tm__skipList">
          <li v-for="line in lastSkips" :key="line" class="tm__skipItem">{{ line }}</li>
        </ul>
      </details>

      <!-- 差异视图 ---------------------------------------------------------------->
      <template v-if="view === 'diff'">
        <div class="tm__bar">
          <button class="tinyButton tinyButton--text" type="button" @click="backToList">← 返回快照列表</button>
          <span class="tm__diffTitle">{{ diffFor?.label }}</span>
          <span class="tm__dim">{{ changedCount }} 处改动</span>
          <span class="tm__spacer" />
          <label v-if="selectable.length > 0" class="tm__check tm__check--all">
            <input type="checkbox" :checked="allSelected" @change="toggleAll" />
            全选
          </label>
          <button
            class="tinyButton tinyButton--primary"
            type="button"
            :disabled="selected.size === 0 || restoring || diffLoading"
            @click="confirmRestore = true"
          >
            回滚所选 ({{ selected.size }})
          </button>
        </div>

        <p v-if="diffWarn" class="tm__warn">{{ diffWarn }}</p>

        <p v-if="confirmRestore" class="tm__confirm">
          <span>确认回滚，将覆盖 {{ selected.size }} 个文件？快照外的新文件不会被删除。</span>
          <button
            class="tinyButton tinyButton--text tm__dangerBtn"
            type="button"
            :disabled="restoring"
            @click="doRestoreSelected"
          >
            {{ restoring ? '回滚中…' : '确认回滚' }}
          </button>
          <button class="tinyButton tinyButton--text" type="button" @click="confirmRestore = false">取消</button>
        </p>

        <div v-if="diffLoading" class="tm__waiting"><span class="spinner" />正在比对文件…</div>
        <div v-else-if="diffEntries.length === 0" class="tm__empty">这个快照里没有文件。</div>
        <table v-else class="tm__table">
          <thead>
            <tr>
              <th class="tm__colCheck" />
              <th>路径</th>
              <th class="tm__colStatus">状态</th>
              <th class="tm__colCount">行数</th>
            </tr>
          </thead>
          <tbody>
            <tr
              v-for="entry in diffEntries"
              :key="entry.path"
              :class="{ 'tm__row--dim': entry.status === 'unchanged' }"
            >
              <td class="tm__colCheck">
                <input
                  type="checkbox"
                  :checked="selected.has(entry.path)"
                  :disabled="!isRestorable(entry)"
                  :title="isRestorable(entry) ? '' : '快照中没有这个文件，回滚不会删除它'"
                  @change="toggle(entry.path)"
                />
              </td>
              <td class="tm__path" :title="entry.path">{{ entry.path }}</td>
              <td class="tm__colStatus">
                <span class="tm__badge" :class="`tm__badge--${entry.status}`">{{ statusLabel(entry.status) }}</span>
              </td>
              <td class="tm__colCount tm__counts">
                <span v-if="entry.binary" class="tm__dim" title="文件过大或为二进制，未统计行数">—</span>
                <template v-else>
                  <span class="tm__add">+{{ entry.added }}</span>
                  <span class="tm__del">-{{ entry.removed }}</span>
                </template>
              </td>
            </tr>
          </tbody>
        </table>
      </template>

      <!-- 快照列表 ---------------------------------------------------------------->
      <template v-else>
        <div v-if="loading && items.length === 0" class="tm__waiting"><span class="spinner" />正在读取快照…</div>
        <div v-else-if="items.length === 0" class="tm__empty">
          还没有检查点。改动之前先拍一张，跑歪了可以整目录或单文件回滚。
        </div>

        <div v-for="item in items" :key="item.id" class="tm__row">
          <div class="tm__rowMain">
            <div class="tm__rowTop">
              <span class="tm__label">{{ item.label }}</span>
              <span class="tm__dim" :title="absoluteTime(item.at)">{{ formatTime(item.at) }}</span>
            </div>
            <div class="tm__meta">
              <span>{{ item.fileCount }} 个文件 · {{ formatBytes(item.bytes) }}</span>
              <template v-if="item.note">
                <span class="statsPills__sep" />
                <span>{{ item.note }}</span>
              </template>
            </div>
          </div>

          <div class="tm__rowActions">
            <button
              class="tinyButton tinyButton--text"
              type="button"
              :disabled="rowBusy === item.id"
              @click="openDiff(item)"
            >
              查看差异
            </button>
            <button
              class="tinyButton tinyButton--text"
              type="button"
              :disabled="rowBusy === item.id"
              @click="rowConfirm = { id: item.id, kind: 'restore' }"
            >
              回滚
            </button>
            <button
              class="tinyButton tinyButton--text tm__dangerBtn"
              type="button"
              :disabled="rowBusy === item.id"
              @click="rowConfirm = { id: item.id, kind: 'delete' }"
            >
              删除
            </button>
          </div>

          <p v-if="rowConfirm?.id === item.id && rowConfirm.kind === 'restore'" class="tm__confirm tm__confirm--row">
            <span>确认回滚，将覆盖 {{ item.fileCount }} 个文件？快照外的新文件不会被删除。</span>
            <button
              class="tinyButton tinyButton--text tm__dangerBtn"
              type="button"
              :disabled="rowBusy === item.id"
              @click="doRestoreWhole(item)"
            >
              {{ rowBusy === item.id ? '回滚中…' : '确认回滚' }}
            </button>
            <button class="tinyButton tinyButton--text" type="button" @click="rowConfirm = null">取消</button>
          </p>

          <p v-if="rowConfirm?.id === item.id && rowConfirm.kind === 'delete'" class="tm__confirm tm__confirm--row">
            <span>确认删除「{{ item.label }}」？这个快照会被彻底删除，无法恢复。</span>
            <button
              class="tinyButton tinyButton--text tm__dangerBtn"
              type="button"
              :disabled="rowBusy === item.id"
              @click="doDelete(item)"
            >
              {{ rowBusy === item.id ? '删除中…' : '确认删除' }}
            </button>
            <button class="tinyButton tinyButton--text" type="button" @click="rowConfirm = null">取消</button>
          </p>
        </div>
      </template>
    </template>

    <template #footer>
      <span>快照是文件副本（不依赖 git），因此大目录与构建产物会被跳过。</span>
      <span class="tm__spacer" />
      <code v-if="usage?.root" class="tm__store" :title="usage.root">存储位置 {{ usage.root }}</code>
    </template>
  </ShellDialog>
</template>

<style scoped>
.tm__new {
  display: flex;
  align-items: center;
  gap: 6px;
}

.tm__newInput {
  width: 190px;
  padding: 5px 8px;
  font-size: 12px;
}

.tm__hint {
  margin: 0;
  color: var(--dsw-alias-label-secondary);
  font-size: 12.5px;
  line-height: 19px;
}

.tm__error,
.tm__ok,
.tm__warn {
  margin: 8px 0 0;
  padding: 7px 9px;
  border-radius: 8px;
  font-size: 12px;
  line-height: 17px;
}

.tm__error {
  background: var(--dsw-alias-interactive-bg-hover-danger);
  color: var(--dsw-alias-state-error-primary);
}

.tm__ok {
  background: var(--dsw-alias-state-success-tertiary);
  color: var(--dsw-alias-state-success-secondary);
}

.tm__warn {
  background: var(--dsw-alias-state-warn-tertiary);
  color: var(--dsw-alias-state-warn-secondary);
}

.tm__skips {
  margin-top: 10px;
  padding: 7px 9px;
  border: 0.5px solid var(--dsw-alias-border-l1);
  border-radius: 8px;
  background: var(--dsw-alias-bg-layer-1);
  color: var(--dsw-alias-label-secondary);
  font-size: 11.5px;
}

.tm__skips summary {
  cursor: pointer;
}

.tm__skipList {
  margin: 6px 0 0;
  padding-left: 16px;
  max-height: 150px;
  overflow-y: auto;
}

.tm__skipItem {
  color: var(--dsw-alias-label-caption);
  font-family: var(--dsw-font-family-code);
  font-size: 11px;
  line-height: 17px;
  word-break: break-all;
}

.tm__bar {
  display: flex;
  align-items: center;
  gap: 9px;
  margin-bottom: 9px;
}

.tm__diffTitle {
  color: var(--dsw-alias-label-primary);
  font-size: 13px;
  font-weight: 600;
}

.tm__spacer {
  flex: 1;
}

.tm__waiting,
.tm__empty {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  padding: 34px 12px;
  color: var(--dsw-alias-label-caption);
  font-size: 12.5px;
  text-align: center;
}

.tm__table {
  width: 100%;
  border-collapse: collapse;
  font-size: 12px;
}

.tm__table th {
  padding: 5px 8px;
  border-bottom: 0.5px solid var(--dsw-alias-border-l1);
  color: var(--dsw-alias-label-caption);
  font-weight: 500;
  text-align: left;
}

.tm__table td {
  padding: 5px 8px;
  border-bottom: 0.5px solid var(--dsw-alias-border-l1);
  color: var(--dsw-alias-label-secondary);
  vertical-align: middle;
}

.tm__table tbody tr:hover {
  background: var(--dsw-alias-interactive-bg-hover);
}

.tm__row--dim {
  opacity: 0.6;
}

.tm__colCheck {
  width: 26px;
}

.tm__colStatus {
  width: 56px;
}

.tm__colCount {
  width: 96px;
  text-align: right;
}

.tm__path {
  color: var(--dsw-alias-label-primary) !important;
  font-family: var(--dsw-font-family-code);
  font-size: 11.5px;
  word-break: break-all;
}

.tm__badge {
  display: inline-block;
  padding: 1px 6px;
  border-radius: 4px;
  background: var(--dsw-alias-bg-layer-3);
  color: var(--dsw-alias-label-tertiary);
  font-size: 10.5px;
  font-weight: 500;
}

.tm__badge--added {
  background: var(--dsw-alias-state-success-tertiary);
  color: var(--dsw-alias-state-success-secondary);
}

.tm__badge--modified {
  background: var(--dsw-alias-state-warn-tertiary);
  color: var(--dsw-alias-state-warn-secondary);
}

.tm__badge--removed {
  background: var(--dsw-alias-interactive-bg-hover-danger);
  color: var(--dsw-alias-state-error-primary);
}

.tm__counts {
  display: flex;
  justify-content: flex-end;
  gap: 6px;
  font-family: var(--dsw-font-family-code);
  font-size: 11px;
}

.tm__add {
  color: var(--dsw-alias-state-success-secondary);
}

.tm__del {
  color: var(--dsw-alias-state-error-primary);
}

.tm__check {
  display: flex;
  align-items: center;
  gap: 5px;
  color: var(--dsw-alias-label-secondary);
  font-size: 12px;
}

.tm__check--all {
  flex: none;
}

.tm__confirm {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  margin: 9px 0 0;
  padding: 8px 10px;
  border: 0.5px solid var(--dsw-alias-state-warn-primary);
  border-radius: 8px;
  background: var(--dsw-alias-state-warn-tertiary);
  color: var(--dsw-alias-label-secondary);
  font-size: 12px;
}

.tm__confirm--row {
  flex: 1 0 100%;
  margin-top: 8px;
}

.tm__row {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-start;
  gap: 10px;
  padding: 9px 10px;
  border: 0.5px solid var(--dsw-alias-border-l2);
  border-radius: 10px;
  background: var(--dsw-alias-bg-layer-1);
}

.tm__row + .tm__row {
  margin-top: 6px;
}

.tm__rowMain {
  flex: 1;
  min-width: 0;
}

.tm__rowTop {
  display: flex;
  align-items: center;
  gap: 8px;
}

.tm__label {
  min-width: 0;
  overflow: hidden;
  color: var(--dsw-alias-label-primary);
  font-size: 13px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.tm__meta {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
  margin-top: 3px;
  color: var(--dsw-alias-label-caption);
  font-size: 11.5px;
}

.tm__rowActions {
  display: flex;
  flex: none;
  align-items: center;
  gap: 2px;
}

/** Scoped, not global: `.tinyButton--danger` does not exist in styles.css and this dialog is its only user. */
.tm__dangerBtn {
  color: var(--dsw-alias-state-error-primary);
}

.tm__dim {
  color: var(--dsw-alias-label-caption);
  font-size: 11.5px;
}

.tm__store {
  min-width: 0;
  overflow: hidden;
  color: var(--dsw-alias-label-dimmed);
  font-family: var(--dsw-font-family-code);
  font-size: 10.5px;
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>
