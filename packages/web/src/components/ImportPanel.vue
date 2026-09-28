<script setup lang="ts">
/**
 * Import existing Claude Code conversations.
 *
 * These sessions are not imported in the sense of being copied or converted: Claude Code already
 * wrote them to `<config>/projects/<encoded-cwd>/<sessionId>.jsonl`, and the bridge already launches
 * the CLI with `--resume <id>`. So "importing" means listing what is on disk and reopening it, which
 * is why tool calls and reasoning survive intact — nothing is transformed.
 *
 * This deliberately replaces porting dsh-chat-import: that plugin converts OTHER tools' transcripts
 * into DSH session records and its portable surface (`export-md`) targets DSH storage, which this app
 * does not have. The Markdown export here is the same idea against Claude Code's own format.
 */
import { computed, onMounted, ref } from 'vue'
import type { Bridge } from '../composables/useBridge'
import type { TranscriptListing, TranscriptSummary } from '../types'

const props = defineProps<{
  bridge: Bridge
}>()

const emit = defineEmits<{
  /** Open a past conversation as a live, resumable session. */
  (e: 'open-transcript', transcript: TranscriptSummary): void
}>()

const listing = ref<TranscriptListing | null>(null)
const loading = ref(false)
const error = ref<string | null>(null)
const query = ref('')
const collapsed = ref<Set<string>>(new Set())
/** Which transcript's Markdown is being prepared, so the button can show progress. */
const exporting = ref<string | null>(null)

async function load() {
  loading.value = true
  error.value = null
  try {
    listing.value = await props.bridge.listTranscripts(query.value)
  } catch (cause) {
    error.value = String((cause as Error).message ?? cause)
  } finally {
    loading.value = false
  }
}

onMounted(load)

/** Debounced so typing a query does not re-read every transcript on disk per keystroke. */
let searchTimer: ReturnType<typeof setTimeout> | null = null
function onSearchInput() {
  if (searchTimer) clearTimeout(searchTimer)
  searchTimer = setTimeout(load, 250)
}

function toggle(cwd: string) {
  const next = new Set(collapsed.value)
  if (next.has(cwd)) next.delete(cwd)
  else next.add(cwd)
  collapsed.value = next
}

function isCollapsed(cwd: string) {
  return collapsed.value.has(cwd)
}

/** Shorten a working directory to its last two segments, the way the sidebar labels workspaces. */
function shortPath(cwd: string) {
  const parts = cwd.split(/[\\/]/).filter(Boolean)
  if (parts.length <= 2) return cwd
  return '…' + (cwd.includes('\\') ? '\\' : '/') + parts.slice(-2).join(cwd.includes('\\') ? '\\' : '/')
}

function when(iso: string | null, mtime: number) {
  const at = iso ? new Date(iso) : new Date(mtime)
  if (Number.isNaN(at.getTime())) return '时间未知'
  return at.toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
}

const groups = computed(() => listing.value?.groups ?? [])
const totalTurns = computed(() => (listing.value?.transcripts ?? []).reduce((sum, item) => sum + item.turns, 0))

async function exportMarkdown(transcript: TranscriptSummary) {
  exporting.value = transcript.sessionId
  error.value = null
  try {
    const result = await props.bridge.exportTranscript(transcript.sessionId)
    // A download rather than a filesystem write: the bridge runs as a sidecar with its own cwd, and
    // "save where the user expects" is the browser's job, not the bridge's.
    const blob = new Blob([result.markdown], { type: 'text/markdown;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = `${transcript.sessionId}.md`
    document.body.appendChild(anchor)
    anchor.click()
    anchor.remove()
    URL.revokeObjectURL(url)
  } catch (cause) {
    error.value = String((cause as Error).message ?? cause)
  } finally {
    exporting.value = null
  }
}
</script>

<template>
  <div>
    <h3 class="st__h">导入已有会话</h3>
    <p class="st__sub">
      这里列出 Claude Code 已经写在磁盘上的历史会话，可以直接继续对话 —— 不会复制或转换，
      因此工具调用与推理过程都保持原样。
    </p>

    <div class="st__field">
      <div class="tr__bar">
        <input
          v-model="query"
          class="field__input tr__search"
          placeholder="搜索提问、目录或会话 ID…"
          spellcheck="false"
          @input="onSearchInput"
        />
        <button class="tinyButton tinyButton--text" type="button" :disabled="loading" @click="load">
          {{ loading ? '读取中…' : '刷新' }}
        </button>
      </div>

      <p v-if="listing" class="st__hint">
        共 {{ listing.total }} 个会话 · {{ totalTurns }} 轮对话 · 目录
        <code class="tr__path">{{ listing.root }}</code>
        <template v-if="listing.truncatedByCount">（数量超过上限，仅列出最近的部分）</template>
      </p>
    </div>

    <p v-if="error" class="st__hint tr__error">{{ error }}</p>

    <div v-if="loading && !listing" class="st__hint">正在读取历史会话…</div>
    <div v-else-if="listing && listing.matched === 0" class="st__hint">
      {{ query ? '没有匹配的会话。' : '这个目录下还没有历史会话。' }}
    </div>

    <div v-for="group in groups" :key="group.cwd" class="tr__group">
      <button class="tr__groupHead" type="button" @click="toggle(group.cwd)">
        <span class="reason__caret" :class="{ 'reason__caret--open': !isCollapsed(group.cwd) }" />
        <span class="tr__groupName">{{ shortPath(group.cwd) }}</span>
        <span class="tr__groupCount">{{ group.items.length }}</span>
      </button>

      <div v-if="!isCollapsed(group.cwd)" class="tr__list">
        <div v-for="item in group.items" :key="item.sessionId" class="tr__row">
          <div class="tr__main">
            <div class="tr__title">{{ item.title }}</div>
            <div class="tr__meta">
              <span>{{ item.turns }} 轮</span>
              <span class="statsPills__sep" />
              <span>用户 {{ item.userTurns }} · 助手 {{ item.assistantTurns }}</span>
              <template v-if="item.toolResultRecords > 0">
                <span class="statsPills__sep" />
                <span>工具结果 {{ item.toolResultRecords }}</span>
              </template>
              <span class="statsPills__sep" />
              <span>{{ when(item.endedAt, item.mtime) }}</span>
              <template v-if="item.version">
                <span class="statsPills__sep" />
                <span>v{{ item.version }}</span>
              </template>
            </div>
            <div class="tr__id">{{ item.sessionId }}</div>
          </div>

          <div class="tr__actions">
            <button
              class="tinyButton tinyButton--text"
              type="button"
              :disabled="exporting === item.sessionId"
              @click="exportMarkdown(item)"
            >
              {{ exporting === item.sessionId ? '导出中…' : '导出 MD' }}
            </button>
            <button class="tinyButton tinyButton--primary" type="button" @click="emit('open-transcript', item)">
              继续对话
            </button>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.tr__bar {
  display: flex;
  align-items: center;
  gap: 8px;
}

.tr__search {
  flex: 1;
  min-width: 0;
}

.tr__path {
  font-family: var(--dsw-font-family-code);
  font-size: 11px;
  word-break: break-all;
}

.tr__error {
  color: var(--dsw-alias-state-error-primary);
}

.tr__group {
  margin-top: 12px;
}

.tr__groupHead {
  display: flex;
  align-items: center;
  gap: 6px;
  width: 100%;
  padding: 5px 6px;
  border: 0;
  border-radius: 8px;
  background: transparent;
  color: var(--dsw-alias-label-secondary);
  font-size: 12px;
  cursor: pointer;
  text-align: left;
}

.tr__groupHead:hover {
  background: var(--dsw-alias-interactive-bg-hover);
}

.tr__groupName {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.tr__groupCount {
  color: var(--dsw-alias-label-caption);
  font-family: var(--dsw-font-family-code);
}

.tr__list {
  display: flex;
  flex-direction: column;
  gap: 4px;
  margin-top: 4px;
}

.tr__row {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  padding: 8px 10px;
  border: 0.5px solid var(--dsw-alias-border-l2);
  border-radius: 10px;
  background: var(--dsw-alias-bg-layer-1);
}

.tr__main {
  flex: 1;
  min-width: 0;
}

.tr__title {
  color: var(--dsw-alias-label-primary);
  font-size: 13px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.tr__meta {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-top: 3px;
  color: var(--dsw-alias-label-caption);
  font-size: 11.5px;
}

.tr__id {
  margin-top: 3px;
  color: var(--dsw-alias-label-dimmed);
  font-family: var(--dsw-font-family-code);
  font-size: 10.5px;
}

.tr__actions {
  display: flex;
  flex-direction: column;
  gap: 4px;
  /** Sized to the widest label so the two buttons line up instead of each hugging its text. */
  flex: 0 0 auto;
  min-width: 76px;
}
</style>
