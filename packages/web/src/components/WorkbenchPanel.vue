<script setup lang="ts">
/**
 * 工作台 — 右侧的工作区：文件树、预览、搜索、变更审阅。
 *
 * WHY THE TREE IS LAZY: a checkout with `node_modules` is tens of thousands of entries, and the user
 * is looking at one directory. One request per level keeps opening the panel instant and makes the
 * "heavy directory" marker meaningful instead of a footnote on an already-frozen window.
 *
 * WHY NO SYNTAX HIGHLIGHTER: CodeMirror/Shiki would add megabytes and a second scroll container to
 * the bundle for a preview that is mostly read once. Plain text with line numbers answers "what is
 * in this file"; editing stays in the editor the user already has.
 *
 * WHY CHANGES ARE READ-ONLY: staging, discarding and committing already have a home in 代码管理
 * (GitPanel). Two places that can delete work is exactly the kind of duplicate this repo avoids.
 */
import { computed, onMounted, ref, watch } from 'vue'
import ShellDialog from './ShellDialog.vue'

type Entry = { name: string; path: string; type: 'dir' | 'file'; size: number; mtime: number; heavy: boolean }
type TreeAnswer = { ok: boolean; error?: string; path?: string; parent?: string | null; entries?: Entry[]; hidden?: number }
type FileAnswer = {
  ok: boolean
  error?: string
  path?: string
  name?: string
  size?: number
  kind?: 'text' | 'markdown' | 'image' | 'binary'
  language?: string
  text?: string
  truncated?: boolean
  dataUrl?: string
  hint?: string
}
type Hit = { path: string; line: number; text: string }
type SearchAnswer = { ok: boolean; error?: string; hits?: Hit[]; scanned?: number; capped?: boolean }
type ChangeFile = { path: string; status?: string; staged?: boolean }
type ChangesAnswer = {
  ok: boolean
  error?: string
  git?: { ok: boolean; available?: boolean; branch?: string | null; error?: string; hint?: string | null }
  files?: ChangeFile[]
  diff?: string
}

const props = defineProps<{ cwd?: string | null; sessionId?: string | null; file?: string | null }>()
const emit = defineEmits<{ (e: 'close'): void }>()

/** Same three-step resolution as every other panel (shell injection → ?bridge= → dev proxy). */
function resolveBaseUrl(): string {
  const injected = (globalThis as Record<string, unknown>).__CCCN_BRIDGE_URL__
  if (typeof injected === 'string' && injected.length > 0) return injected.replace(/\/$/, '')
  const param = new URLSearchParams(location.search).get('bridge')
  if (param) return param.replace(/\/$/, '')
  return import.meta.env.DEV ? '' : 'http://127.0.0.1:43130'
}

const baseUrl = resolveBaseUrl()

async function get<T>(path: string): Promise<T> {
  const response = await fetch(`${baseUrl}${path}`)
  return (await response.json()) as T
}

const tab = ref<'files' | 'changes'>('files')
const tree = ref<TreeAnswer | null>(null)
const treeLoading = ref(false)
const treeError = ref('')
/** Guards against a slow directory painting over a newer click. */
let treeTicket = 0

const currentDir = ref('')
const preview = ref<FileAnswer | null>(null)
const previewLoading = ref(false)
let previewTicket = 0

const query = ref('')
const searching = ref(false)
const searchAnswer = ref<SearchAnswer | null>(null)

const changes = ref<ChangesAnswer | null>(null)
const changesLoading = ref(false)

/** 按轮差异: turns recorded for this session, newest first, plus the one being reviewed. */
type TurnSummary = { turn: number; files: number }
type TurnFile = { path: string; status: string; added?: number; removed?: number; diff?: string; reason?: string }
const turnList = ref<TurnSummary[]>([])
const activeTurn = ref<number | null>(null)
const turnFiles = ref<TurnFile[]>([])
const turnLoading = ref(false)

const workspace = computed(() => props.cwd ?? null)
const breadcrumb = computed(() => (currentDir.value === '' ? [] : currentDir.value.split('/')))

async function loadTree(path: string) {
  if (!workspace.value) return
  const ticket = ++treeTicket
  treeLoading.value = true
  treeError.value = ''
  try {
    const answer = await get<TreeAnswer>(
      `/api/workbench/tree?cwd=${encodeURIComponent(workspace.value)}&path=${encodeURIComponent(path)}`,
    )
    if (ticket !== treeTicket) return
    if (!answer.ok) {
      treeError.value = answer.error ?? '无法读取目录'
      return
    }
    tree.value = answer
    currentDir.value = answer.path ?? path
  } catch (problem) {
    if (ticket === treeTicket) treeError.value = problem instanceof Error ? problem.message : String(problem)
  } finally {
    if (ticket === treeTicket) treeLoading.value = false
  }
}

async function openFile(path: string) {
  if (!workspace.value) return
  const ticket = ++previewTicket
  previewLoading.value = true
  try {
    const answer = await get<FileAnswer>(
      `/api/workbench/file?cwd=${encodeURIComponent(workspace.value)}&path=${encodeURIComponent(path)}`,
    )
    if (ticket !== previewTicket) return
    preview.value = answer
  } catch (problem) {
    if (ticket === previewTicket) preview.value = { ok: false, error: problem instanceof Error ? problem.message : String(problem) }
  } finally {
    if (ticket === previewTicket) previewLoading.value = false
  }
}

function enter(entry: Entry) {
  if (entry.type === 'dir') {
    void loadTree(entry.path)
    preview.value = null
    return
  }
  void openFile(entry.path)
}

async function runSearch() {
  const needle = query.value.trim()
  if (needle === '' || !workspace.value) {
    searchAnswer.value = null
    return
  }
  searching.value = true
  try {
    searchAnswer.value = await get<SearchAnswer>(
      `/api/workbench/search?cwd=${encodeURIComponent(workspace.value)}&q=${encodeURIComponent(needle)}`,
    )
  } catch (problem) {
    searchAnswer.value = { ok: false, error: problem instanceof Error ? problem.message : String(problem) }
  } finally {
    searching.value = false
  }
}

async function loadChanges() {
  if (!workspace.value) return
  changesLoading.value = true
  try {
    const session = props.sessionId ? `&sessionId=${encodeURIComponent(props.sessionId)}` : ''
    if (activeTurn.value !== null) {
      // A turn request returns the turn's files in `files`; the git payload is not part of this call, so
      // `changes` is left untouched — overwriting it with this shape would blank the git section.
      const answer = await get<{ ok: boolean; turns?: TurnSummary[]; files?: TurnFile[]; error?: string }>(
        `/api/workbench/changes?cwd=${encodeURIComponent(workspace.value)}${session}&turn=${activeTurn.value}`,
      )
      if (Array.isArray(answer.turns)) turnList.value = answer.turns
      turnFiles.value = Array.isArray(answer.files) ? answer.files : []
      return
    }

    const answer = await get<ChangesAnswer & { turns?: TurnSummary[] }>(
      `/api/workbench/changes?cwd=${encodeURIComponent(workspace.value)}${session}`,
    )
    changes.value = answer
    if (Array.isArray(answer.turns)) {
      turnList.value = answer.turns
      // First load: show the newest turn automatically — "this turn" is what the review tab is for.
      if (answer.turns.length > 0) {
        activeTurn.value = answer.turns[0].turn
        await loadChanges()
      }
    }
  } catch (problem) {
    changes.value = { ok: false, error: problem instanceof Error ? problem.message : String(problem) }
  } finally {
    changesLoading.value = false
  }
}

/** Switched turn: ask for that turn's diffs specifically. */
async function pickTurn(turn: number) {
  activeTurn.value = turn
  turnLoading.value = true
  await loadChanges()
  turnLoading.value = false
}

/** Escape first, then apply a deliberately small subset of Markdown. */
function renderMarkdown(source: string): string {
  const escaped = source
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')

  const blocks = escaped.split(/```/)
  const html: string[] = []
  blocks.forEach((block, index) => {
    if (index % 2 === 1) {
      html.push(`<pre class="wb__code">${block.replace(/^\w*\n/, '')}</pre>`)
      return
    }
    for (const line of block.split(/\r?\n/)) {
      const text = line
        .replace(/`([^`]+)`/g, '<code>$1</code>')
        .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      if (/^###\s/.test(line)) html.push(`<h4>${text.replace(/^###\s/, '')}</h4>`)
      else if (/^##\s/.test(line)) html.push(`<h3>${text.replace(/^##\s/, '')}</h3>`)
      else if (/^#\s/.test(line)) html.push(`<h2>${text.replace(/^#\s/, '')}</h2>`)
      else if (/^\s*[-*]\s/.test(line)) html.push(`<li>${text.replace(/^\s*[-*]\s/, '')}</li>`)
      else if (line.trim() === '') html.push('')
      else html.push(`<p>${text}</p>`)
    }
  })
  // `<li>` without a wrapper renders as an unstyled bullet list; wrap consecutive items.
  return html
    .join('\n')
    .replace(/(?:^|\n)(<li>[\s\S]*?<\/li>)(?=\n|$)/g, '\n<ul>$1</ul>')
}

const markdownHtml = computed(() => (preview.value?.kind === 'markdown' && preview.value.text ? renderMarkdown(preview.value.text) : ''))
const previewLines = computed(() => (preview.value?.text ?? '').split(/\r?\n/))
const diffLines = computed(() => (changes.value?.diff ?? '').split(/\r?\n/))

function diffClass(line: string): string {
  if (line.startsWith('+++') || line.startsWith('---')) return 'wb__diffMeta'
  if (line.startsWith('@@')) return 'wb__diffHunk'
  if (line.startsWith('+')) return 'wb__diffAdd'
  if (line.startsWith('-')) return 'wb__diffDel'
  return ''
}

function statusLabel(file: ChangeFile): string {
  const status = String(file.status ?? '').trim()
  if (status === '' || status === 'M') return '修改'
  if (status === 'A' || status === '??') return '新增'
  if (status === 'D') return '删除'
  if (status === 'R') return '重命名'
  return status
}

watch(
  () => props.cwd,
  () => {
    tree.value = null
    preview.value = null
    searchAnswer.value = null
    changes.value = null
    currentDir.value = ''
    if (workspace.value) void loadTree('')
  },
)

onMounted(() => {
  if (workspace.value) void loadTree('')
  // 从右栏点进来的文件：直接打开它，不再要求用户在同一棵树里再点一次。
  if (props.file) void openFile(props.file)
})
</script>

<template>
  <ShellDialog title="工作台" :meta="cwd ?? '未打开工作区'" :width="980" @close="emit('close')">
    <div v-if="!cwd" class="wb__empty">需要先打开一个工作目录。工作台只读取当前会话的工作区。</div>

    <div v-else class="wb">
      <header class="wb__bar">
        <div class="wb__tabs">
          <button class="wb__tab" :class="{ 'wb__tab--on': tab === 'files' }" type="button" @click="tab = 'files'">文件</button>
          <button
            class="wb__tab"
            :class="{ 'wb__tab--on': tab === 'changes' }"
            type="button"
            @click="tab = 'changes'; loadChanges()"
          >
            变更
          </button>
        </div>
        <input
          v-if="tab === 'files'"
          v-model="query"
          class="wb__search"
          placeholder="在工作区搜索（回车）"
          spellcheck="false"
          @keydown.enter="runSearch"
        />
        <button v-if="tab === 'files' && query" class="wb__btn" type="button" :disabled="searching" @click="runSearch">
          {{ searching ? '搜索中…' : '搜索' }}
        </button>
        <button v-if="tab === 'changes'" class="wb__btn" type="button" :disabled="changesLoading" @click="loadChanges">
          {{ changesLoading ? '读取中…' : '刷新' }}
        </button>
      </header>

      <div v-if="tab === 'files'" class="wb__body">
        <aside v-if="!file" class="wb__side">
          <nav class="wb__crumbs">
            <button class="wb__crumb" type="button" @click="loadTree('')">工作区</button>
            <template v-for="(segment, index) in breadcrumb" :key="segment + index">
              <span class="wb__crumbSep">/</span>
              <button class="wb__crumb" type="button" @click="loadTree(breadcrumb.slice(0, index + 1).join('/'))">
                {{ segment }}
              </button>
            </template>
          </nav>

          <p v-if="treeError" class="wb__error">{{ treeError }}</p>
          <p v-else-if="treeLoading" class="wb__muted">读取中…</p>
          <ul v-else class="wb__list">
            <li v-if="tree?.parent !== null && tree?.parent !== undefined" class="wb__row">
              <button class="wb__entry" type="button" @click="loadTree(tree?.parent ?? '')">..</button>
            </li>
            <li v-for="entry in tree?.entries ?? []" :key="entry.path" class="wb__row">
              <button
                class="wb__entry"
                :class="{ 'wb__entry--heavy': entry.heavy, 'wb__entry--dir': entry.type === 'dir' }"
                type="button"
                :title="entry.path"
                @click="enter(entry)"
              >
                <span class="wb__glyph">{{ entry.type === 'dir' ? '▸' : '·' }}</span>
                <span class="wb__name">{{ entry.name }}</span>
                <span v-if="entry.type === 'file'" class="wb__size">{{ Math.max(1, Math.round(entry.size / 1024)) }} KB</span>
              </button>
            </li>
          </ul>
          <p v-if="(tree?.hidden ?? 0) > 0" class="wb__muted">还有 {{ tree?.hidden }} 项未列出（目录太大，先展开子目录）</p>

          <div v-if="searchAnswer" class="wb__hits">
            <p class="wb__hitsHead">
              {{ searchAnswer.ok ? `命中 ${searchAnswer.hits?.length ?? 0} 处` : searchAnswer.error }}
              <span v-if="searchAnswer.capped" class="wb__muted">（已截断）</span>
            </p>
            <button
              v-for="hit in searchAnswer.hits ?? []"
              :key="hit.path + ':' + hit.line"
              class="wb__hit"
              type="button"
              :title="hit.path"
              @click="openFile(hit.path)"
            >
              <span class="wb__hitPath">{{ hit.path }}:{{ hit.line }}</span>
              <span class="wb__hitText">{{ hit.text }}</span>
            </button>
          </div>
        </aside>

        <section class="wb__preview">
          <p v-if="previewLoading" class="wb__muted">读取中…</p>
          <template v-else-if="preview">
            <header class="wb__previewHead">
              <span class="wb__previewPath">{{ preview.path }}</span>
              <span v-if="preview.language" class="wb__badge">{{ preview.language }}</span>
              <span v-if="preview.truncated" class="wb__badge wb__badge--warn">已截断</span>
            </header>
            <p v-if="preview.error" class="wb__error">{{ preview.error }}</p>
            <p v-else-if="preview.hint" class="wb__muted">{{ preview.hint }}</p>

            <img v-if="preview.kind === 'image' && preview.dataUrl" class="wb__image" :src="preview.dataUrl" :alt="preview.name" />
            <div v-else-if="preview.kind === 'markdown'" class="wb__md" v-html="markdownHtml" />
            <div v-else-if="preview.kind === 'text'" class="wb__codeWrap">
              <div class="wb__gutter"><span v-for="n in previewLines.length" :key="n">{{ n }}</span></div>
              <pre class="wb__text">{{ preview.text }}</pre>
            </div>
            <p v-else-if="preview.kind === 'binary'" class="wb__muted">二进制文件（{{ Math.round((preview.size ?? 0) / 1024) }} KB），不提供预览。</p>
          </template>
          <p v-else class="wb__muted">从左侧选一个文件。</p>
        </section>
      </div>

      <div v-else class="wb__changes">
        <p v-if="changes?.error" class="wb__error">{{ changes.error }}</p>
        <p v-else-if="changes?.git && !changes.git.ok" class="wb__muted">
          {{ changes.git.error }}<template v-if="changes.git.hint">：{{ changes.git.hint }}</template>
        </p>
        <p v-else-if="changes?.git?.ok && (changes.files?.length ?? 0) === 0" class="wb__muted">工作区没有未提交的改动。</p>

        <template v-if="changes?.git?.ok">
          <p class="wb__muted">
            {{ changes.git.branch ? `分支 ${changes.git.branch}` : '当前分支未知' }} · {{ changes.files?.length ?? 0 }} 个改动文件
          </p>
          <ul class="wb__changed">
            <li v-for="file in changes.files ?? []" :key="file.path">
              <button class="wb__changedRow" type="button" @click="openFile(file.path)">
                <span class="wb__badge">{{ statusLabel(file) }}</span>
                <span class="wb__name">{{ file.path }}</span>
              </button>
            </li>
          </ul>
          <pre v-if="diffLines.length > 1" class="wb__diff"><span
            v-for="(line, index) in diffLines"
            :key="index"
            class="wb__diffLine"
            :class="diffClass(line)"
          >{{ line }}
</span></pre>
        </template>

        <!-- 按轮差异：这一轮的工具调用改了什么 -->
        <template v-if="turnList.length > 0">
          <p class="wb__muted">
            本轮差异
            <select class="wb__select" :value="activeTurn ?? undefined" @change="pickTurn(Number(($event.target as HTMLSelectElement).value))">
              <option v-for="entry in turnList" :key="entry.turn" :value="entry.turn">第 {{ entry.turn }} 轮（{{ entry.files }} 个文件）</option>
            </select>
            <span v-if="turnLoading" class="wb__muted"> · 读取中…</span>
          </p>
          <p v-if="turnFiles.length === 0" class="wb__muted">这一轮没有记录到文件改动。</p>
          <ul class="wb__changed">
            <li v-for="file in turnFiles" :key="file.path">
              <button class="wb__changedRow" type="button" @click="openFile(file.path)">
                <span class="wb__badge">{{ file.status }}</span>
                <span class="wb__name">{{ file.path }}</span>
                <span v-if="file.added !== undefined" class="wb__size">+{{ file.added }} / -{{ file.removed ?? 0 }}</span>
              </button>
            </li>
          </ul>
          <pre v-if="turnFiles.length > 0" class="wb__diff"><template v-for="file in turnFiles" :key="file.path"><span
            class="wb__diffMeta">{{ file.path }}
</span><span
            v-for="(line, index) in String(file.diff ?? file.reason ?? '').split('\n')"
            :key="file.path + index"
            class="wb__diffLine"
            :class="diffClass(line)"
          >{{ line }}
</span></template></pre>
        </template>
      </div>
    </div>
  </ShellDialog>
</template>

<style scoped>
.wb {
  display: flex;
  flex-direction: column;
  gap: 8px;
  height: min(64vh, 620px);
  min-height: 420px;
}

.wb__empty {
  padding: 24px;
  color: var(--dsw-alias-label-tertiary);
  font-size: 12.5px;
  text-align: center;
}

.wb__bar {
  display: flex;
  align-items: center;
  gap: 8px;
}

.wb__tabs {
  display: flex;
  gap: 2px;
}

.wb__tab {
  padding: 3px 10px;
  border-radius: 7px;
  color: var(--dsw-alias-label-secondary);
  font-size: 12.5px;
}

.wb__tab--on {
  background: var(--dsw-alias-interactive-bg-hover);
  color: var(--dsw-alias-label-primary);
}

.wb__search {
  flex: 1;
  min-width: 0;
  padding: 4px 8px;
  border: 0.5px solid var(--dsw-alias-border-l1);
  border-radius: 7px;
  background: var(--dsw-alias-bg-layer-2);
  color: var(--dsw-alias-label-primary);
  font-size: 12px;
}

.wb__btn {
  padding: 4px 10px;
  border: 0.5px solid var(--dsw-alias-border-l1);
  border-radius: 7px;
  color: var(--dsw-alias-label-secondary);
  font-size: 12px;
}

.wb__btn:disabled {
  opacity: 0.5;
}

.wb__body {
  display: flex;
  flex: 1;
  min-height: 0;
  border-top: 0.5px solid var(--dsw-alias-border-l1);
}

.wb__side {
  display: flex;
  flex: 0 0 300px;
  flex-direction: column;
  min-height: 0;
  overflow: auto;
  padding: 6px 8px 6px 0;
  border-right: 0.5px solid var(--dsw-alias-border-l1);
}

.wb__crumbs {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 2px;
  margin-bottom: 4px;
}

.wb__crumb {
  color: var(--dsw-alias-label-tertiary);
  font-size: 11.5px;
}

.wb__crumb:hover {
  color: var(--dsw-alias-label-primary);
}

.wb__crumbSep {
  color: var(--dsw-alias-label-tertiary);
  font-size: 11px;
}

.wb__list {
  margin: 0;
  padding: 0;
  list-style: none;
}

.wb__entry {
  display: flex;
  align-items: center;
  gap: 6px;
  width: 100%;
  padding: 2px 6px;
  border-radius: 6px;
  color: var(--dsw-alias-label-secondary);
  font-family: var(--dsw-font-family-code);
  font-size: 11.5px;
  text-align: left;
}

.wb__entry:hover {
  background: var(--dsw-alias-interactive-bg-hover);
  color: var(--dsw-alias-label-primary);
}

.wb__entry--dir {
  color: var(--dsw-alias-label-primary);
}

.wb__entry--heavy {
  opacity: 0.65;
}

.wb__glyph {
  flex: none;
  width: 10px;
  color: var(--dsw-alias-label-tertiary);
}

.wb__name {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.wb__size {
  margin-left: auto;
  color: var(--dsw-alias-label-tertiary);
  font-size: 10.5px;
}

.wb__hits {
  margin-top: 10px;
  border-top: 0.5px solid var(--dsw-alias-border-l1);
  padding-top: 6px;
}

.wb__hitsHead {
  margin: 0 0 4px;
  color: var(--dsw-alias-label-tertiary);
  font-size: 11.5px;
}

.wb__hit {
  display: block;
  width: 100%;
  padding: 4px 6px;
  border-radius: 6px;
  text-align: left;
}

.wb__hit:hover {
  background: var(--dsw-alias-interactive-bg-hover);
}

.wb__hitPath {
  display: block;
  color: var(--dsw-alias-label-secondary);
  font-family: var(--dsw-font-family-code);
  font-size: 11px;
}

.wb__hitText {
  display: block;
  overflow: hidden;
  color: var(--dsw-alias-label-tertiary);
  font-family: var(--dsw-font-family-code);
  font-size: 10.5px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.wb__preview {
  flex: 1;
  min-width: 0;
  overflow: auto;
  padding: 6px 0 6px 10px;
}

.wb__previewHead {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 6px;
}

.wb__previewPath {
  overflow: hidden;
  color: var(--dsw-alias-label-secondary);
  font-family: var(--dsw-font-family-code);
  font-size: 11.5px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.wb__badge {
  flex: none;
  padding: 1px 6px;
  border-radius: 5px;
  background: var(--dsw-alias-interactive-bg-hover);
  color: var(--dsw-alias-label-tertiary);
  font-size: 10.5px;
}

.wb__badge--warn {
  color: var(--dsw-alias-state-error-primary);
}

.wb__codeWrap {
  display: flex;
  gap: 8px;
}

.wb__gutter {
  display: flex;
  flex: none;
  flex-direction: column;
  color: var(--dsw-alias-label-tertiary);
  font-family: var(--dsw-font-family-code);
  font-size: 11px;
  line-height: 1.55;
  text-align: right;
  user-select: none;
}

.wb__text {
  flex: 1;
  margin: 0;
  color: var(--dsw-alias-label-secondary);
  font-family: var(--dsw-font-family-code);
  font-size: 11.5px;
  line-height: 1.55;
  white-space: pre-wrap;
  word-break: break-word;
}

.wb__image {
  max-width: 100%;
  border-radius: 8px;
}

.wb__md {
  color: var(--dsw-alias-label-secondary);
  font-size: 12.5px;
  line-height: 1.7;
}

.wb__md :deep(h2),
.wb__md :deep(h3),
.wb__md :deep(h4) {
  margin: 10px 0 4px;
  color: var(--dsw-alias-label-primary);
}

.wb__md :deep(p) {
  margin: 4px 0;
}

.wb__md :deep(code) {
  padding: 0 4px;
  border-radius: 4px;
  background: var(--dsw-alias-bg-layer-2);
  font-family: var(--dsw-font-family-code);
}

.wb__md :deep(.wb__code) {
  padding: 8px 10px;
  border-radius: 8px;
  background: var(--dsw-alias-bg-layer-2);
  overflow: auto;
}

.wb__changes {
  flex: 1;
  min-height: 0;
  overflow: auto;
  padding-top: 8px;
}

.wb__changed {
  margin: 4px 0 8px;
  padding: 0;
  list-style: none;
}

.wb__changedRow {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 3px 4px;
  border-radius: 6px;
  text-align: left;
}

.wb__changedRow:hover {
  background: var(--dsw-alias-interactive-bg-hover);
}

.wb__diff {
  margin: 0;
  padding: 8px 10px;
  border-radius: 8px;
  background: var(--dsw-alias-bg-layer-2);
  font-family: var(--dsw-font-family-code);
  font-size: 11px;
  line-height: 1.5;
  overflow: auto;
}

.wb__diffLine {
  display: block;
  white-space: pre-wrap;
}

.wb__diffAdd {
  color: var(--dsw-alias-state-success-primary, #3fb950);
}

.wb__diffDel {
  color: var(--dsw-alias-state-error-primary);
}

.wb__diffHunk {
  color: var(--dsw-alias-label-tertiary);
}

.wb__diffMeta {
  color: var(--dsw-alias-label-tertiary);
  font-weight: 600;
}

.wb__muted {
  margin: 4px 0;
  color: var(--dsw-alias-label-tertiary);
  font-size: 11.5px;
}

.wb__error {
  margin: 4px 0;
  color: var(--dsw-alias-state-error-primary);
  font-size: 12px;
}
</style>
