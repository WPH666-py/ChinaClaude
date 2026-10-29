<script setup lang="ts">
/**
 * 工作台（右栏）— 只放文件树。
 *
 * The dock used to be a modal that mixed tree and preview. The user asked for a persistent tree on
 * the right and previews in the middle instead, so this component owns exactly one job: browse
 * directories and hand a file path to the app. Anything that reads file contents lives in the
 * dialog (WorkbenchPanel), which keeps the surface here narrow enough to stay open all day.
 */
import { computed, onMounted, ref, watch } from 'vue'

type Entry = { name: string; path: string; type: 'dir' | 'file'; size: number; mtime: number; heavy: boolean }
type TreeAnswer = { ok: boolean; error?: string; path?: string; parent?: string | null; entries?: Entry[]; hidden?: number }
type Hit = { path: string; line: number; text: string }
type SearchAnswer = { ok: boolean; error?: string; hits?: Hit[]; scanned?: number; capped?: boolean }

const props = defineProps<{ cwd?: string | null }>()
const emit = defineEmits<{ (e: 'open', path: string): void; (e: 'close'): void }>()

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

const tree = ref<TreeAnswer | null>(null)
const treeLoading = ref(false)
const treeError = ref('')
let treeTicket = 0
const currentDir = ref('')
const query = ref('')
const searching = ref(false)
const searchAnswer = ref<SearchAnswer | null>(null)

const workspace = computed(() => props.cwd ?? null)
const breadcrumb = computed(() => (currentDir.value === '' ? [] : currentDir.value.split('/')))

async function loadTree(path: string) {
  if (!workspace.value) return
  const ticket = ++treeTicket
  treeLoading.value = true
  treeError.value = ''
  searchAnswer.value = null
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

async function runSearch() {
  if (!workspace.value || query.value.trim() === '') return
  searching.value = true
  try {
    const answer = await get<SearchAnswer>(
      `/api/workbench/search?cwd=${encodeURIComponent(workspace.value)}&q=${encodeURIComponent(query.value.trim())}`,
    )
    searchAnswer.value = answer
  } catch (problem) {
    searchAnswer.value = { ok: false, error: problem instanceof Error ? problem.message : String(problem) }
  } finally {
    searching.value = false
  }
}

function enter(entry: Entry) {
  if (entry.type === 'dir') {
    void loadTree(entry.path)
    return
  }
  emit('open', entry.path)
}

function sizeText(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return ''
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

onMounted(() => void loadTree(''))
watch(
  () => props.cwd,
  () => {
    tree.value = null
    void loadTree('')
  },
)
</script>

<template>
  <div class="wt">
    <header class="wt__head">
      <span class="wt__title">文件</span>
      <span v-if="cwd" class="wt__cwd" :title="cwd">{{ cwd }}</span>
      <button class="wt__close" type="button" title="关闭工作台" aria-label="关闭工作台" @click="emit('close')">
        ✕
      </button>
    </header>

    <nav class="wt__crumbs">
      <button class="wt__crumb" type="button" @click="loadTree('')">工作区</button>
      <template v-for="(segment, index) in breadcrumb" :key="segment + index">
        <span class="wt__sep">/</span>
        <button class="wt__crumb" type="button" @click="loadTree(breadcrumb.slice(0, index + 1).join('/'))">
          {{ segment }}
        </button>
      </template>
    </nav>

    <input
      v-model="query"
      class="wt__search"
      type="search"
      placeholder="搜索文件内容（回车）"
      @keydown.enter.prevent="runSearch"
    />

    <div class="wt__body">
      <p v-if="!cwd" class="wt__muted">需要先打开一个工作目录。</p>
      <template v-else-if="searchAnswer">
        <p v-if="!searchAnswer.ok" class="wt__error">{{ searchAnswer.error }}</p>
        <p v-else-if="!searchAnswer.hits?.length" class="wt__muted">没有命中。</p>
        <ul v-else class="wt__list">
          <li v-for="hit in searchAnswer.hits" :key="hit.path + hit.line" class="wt__row">
            <button class="wt__entry wt__entry--hit" type="button" @click="emit('open', hit.path)">
              <span class="wt__name">{{ hit.path }}</span>
              <span class="wt__meta">:{{ hit.line }}</span>
            </button>
          </li>
        </ul>
      </template>
      <template v-else>
        <p v-if="treeError" class="wt__error">{{ treeError }}</p>
        <p v-else-if="treeLoading" class="wt__muted">读取中…</p>
        <ul v-else class="wt__list">
          <li v-if="tree?.parent !== null && tree?.parent !== undefined" class="wt__row">
            <button class="wt__entry" type="button" @click="loadTree(tree?.parent ?? '')">..</button>
          </li>
          <li v-for="entry in tree?.entries ?? []" :key="entry.path" class="wt__row">
            <button
              class="wt__entry"
              :class="{ 'wt__entry--dir': entry.type === 'dir' }"
              type="button"
              @click="enter(entry)"
            >
              <span class="wt__icon">{{ entry.type === 'dir' ? '▸' : '·' }}</span>
              <span class="wt__name">{{ entry.name }}</span>
              <span v-if="entry.type === 'dir' && entry.heavy" class="wt__meta">大</span>
              <span v-else-if="entry.type === 'file'" class="wt__meta">{{ sizeText(entry.size) }}</span>
            </button>
          </li>
        </ul>
      </template>
    </div>
  </div>
</template>

<style scoped>
/* 橙色不是装饰：用户要求文件树从深黑里分离出来，一眼能看出这是「文件」区而不是对话区。 */
.wt {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  background: linear-gradient(180deg, #f6a55c 0%, #ee8f3d 100%);
  color: #2b1602;
}

.wt__head {
  display: flex;
  align-items: baseline;
  gap: 8px;
  padding: 10px 12px 6px;
  border-bottom: 1px solid rgba(43, 22, 2, 0.18);
}

.wt__title {
  font-weight: 700;
  font-size: 13px;
  letter-spacing: 0.04em;
}

.wt__cwd {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
  font-size: 11px;
  opacity: 0.72;
}

/* 关闭按钮跟标题同一行、贴右边：桌面和小屏都要能一键收起工作台。 */
.wt__close {
  margin-left: auto;
  flex: none;
  align-self: center;
  width: 26px;
  height: 26px;
  padding: 0;
  border: none;
  border-radius: 8px;
  background: rgba(43, 22, 2, 0.14);
  color: #2a1a08;
  font-size: 13px;
  line-height: 1;
  cursor: pointer;
}

.wt__close:hover {
  background: rgba(43, 22, 2, 0.26);
}

.wt__crumbs {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 2px;
  padding: 6px 12px;
  font-size: 12px;
}

.wt__crumb {
  border: 0;
  background: transparent;
  color: #2b1602;
  padding: 1px 2px;
  border-radius: 4px;
  cursor: pointer;
  font: inherit;
}

.wt__crumb:hover {
  background: rgba(43, 22, 2, 0.12);
}

.wt__sep {
  opacity: 0.5;
}

.wt__search {
  margin: 0 12px 8px;
  padding: 6px 8px;
  border-radius: 8px;
  border: 1px solid rgba(43, 22, 2, 0.25);
  background: rgba(255, 255, 255, 0.55);
  color: #2b1602;
  font: inherit;
  font-size: 12px;
}

.wt__search::placeholder {
  color: rgba(43, 22, 2, 0.55);
}

.wt__body {
  flex: 1;
  min-height: 0;
  overflow: auto;
  padding: 0 6px 10px;
}

.wt__list {
  list-style: none;
  margin: 0;
  padding: 0;
}

.wt__entry {
  display: flex;
  align-items: baseline;
  gap: 6px;
  width: 100%;
  padding: 4px 6px;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: inherit;
  font: inherit;
  font-size: 12.5px;
  text-align: left;
  cursor: pointer;
}

.wt__entry:hover {
  background: rgba(255, 255, 255, 0.45);
}

.wt__entry--dir .wt__name {
  font-weight: 600;
}

.wt__entry--hit {
  display: block;
}

.wt__icon {
  width: 10px;
  opacity: 0.6;
}

.wt__name {
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
  flex: 1;
}

.wt__meta {
  font-size: 11px;
  opacity: 0.65;
  white-space: nowrap;
}

.wt__muted {
  padding: 8px 12px;
  font-size: 12px;
  opacity: 0.7;
}

.wt__error {
  padding: 8px 12px;
  font-size: 12px;
  color: #7a1c00;
}
</style>
