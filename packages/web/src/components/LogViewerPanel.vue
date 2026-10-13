<script setup lang="ts">
/**
 * 运行日志 — the bridge's own rolling log, in a window.
 *
 * WHY IT POLLS A CURSOR INSTEAD OF SUBSCRIBING: the session stream is a per-session SSE channel, and
 * the lines worth reading here are exactly the ones that exist when no session does (a failed spawn,
 * a missing binary, a handshake that never arrived). A cursor poll is a few hundred bytes per tick
 * and cannot be the thing that breaks when the session layer is what is broken.
 *
 * The "dropped" counter is surfaced rather than hidden: a ring buffer that quietly forgets its oldest
 * lines makes a truncated log look like the whole story, which is the one failure mode a log viewer
 * must not have.
 */
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import ShellDialog from './ShellDialog.vue'
import { formatBytes, formatClock, shellGet, shellPost } from '../composables/useShellApi'

interface LogLine {
  seq: number
  at: number
  level: string
  source: string
  text: string
}

const emit = defineEmits<{ (e: 'close'): void }>()

const lines = ref<LogLine[]>([])
const file = ref('')
const size = ref(0)
const dropped = ref(0)
const filter = ref<'all' | 'info' | 'warn' | 'error'>('all')
const follow = ref(true)
const busy = ref(false)
const status = ref('')

const POLL_MS = 1500
let timer: number | null = null
let cursor = 0

const shown = computed(() =>
  filter.value === 'all' ? lines.value : lines.value.filter((line) => line.level === filter.value),
)

async function poll() {
  try {
    const answer = await shellGet<{
      file: string
      size: number
      dropped: number
      lines: LogLine[]
      lastSeq: number
    }>('/api/shell/logs', { since: cursor })
    file.value = answer.file
    size.value = answer.size
    dropped.value = answer.dropped
    if (answer.lines.length > 0) {
      lines.value = [...lines.value, ...answer.lines].slice(-2000)
      cursor = answer.lastSeq
      if (follow.value) {
        // Scrolling after paint, so the height includes the lines just appended.
        requestAnimationFrame(() => {
          const box = document.querySelector('.lv__body')
          if (box) box.scrollTop = box.scrollHeight
        })
      }
    }
  } catch (problem) {
    status.value = `读取日志失败：${problem instanceof Error ? problem.message : String(problem)}`
  }
}

async function clear() {
  busy.value = true
  try {
    await shellPost('/api/shell/logs/clear')
    lines.value = []
    cursor = 0
    dropped.value = 0
    status.value = '已清空（文件也已清空）'
  } catch (problem) {
    status.value = `清空失败：${problem instanceof Error ? problem.message : String(problem)}`
  } finally {
    busy.value = false
  }
}

async function reveal() {
  try {
    await shellPost('/api/shell/logs/reveal')
    status.value = '已在文件管理器中定位日志文件'
  } catch (problem) {
    status.value = `打开失败：${problem instanceof Error ? problem.message : String(problem)}`
  }
}

async function copyAll() {
  const text = lines.value.map((line) => `${formatClock(line.at)} [${line.level}] ${line.text}`).join('\n')
  try {
    await navigator.clipboard.writeText(text)
    status.value = `已复制 ${lines.value.length} 行`
  } catch {
    status.value = '复制失败：剪贴板不可用'
  }
}

onMounted(() => {
  void poll()
  timer = window.setInterval(() => void poll(), POLL_MS)
})

onBeforeUnmount(() => {
  if (timer !== null) window.clearInterval(timer)
})
</script>

<template>
  <ShellDialog title="运行日志" :meta="`${lines.length} 行 · ${formatBytes(size)}`" :width="880" @close="emit('close')">
    <template #actions>
      <div class="tabs">
        <button class="tab" :class="{ 'tab--active': filter === 'all' }" type="button" @click="filter = 'all'">全部</button>
        <button class="tab" :class="{ 'tab--active': filter === 'info' }" type="button" @click="filter = 'info'">信息</button>
        <button class="tab" :class="{ 'tab--active': filter === 'warn' }" type="button" @click="filter = 'warn'">警告</button>
        <button class="tab" :class="{ 'tab--active': filter === 'error' }" type="button" @click="filter = 'error'">错误</button>
      </div>
    </template>

    <div class="lv__bar">
      <label class="lv__check">
        <input v-model="follow" type="checkbox" />
        自动跟随最新
      </label>
      <span v-if="dropped > 0" class="lv__dropped">已丢弃最早 {{ dropped }} 行（内存里只保留最近 2000 行）</span>
      <span class="lv__spacer" />
      <span v-if="status" class="lv__status">{{ status }}</span>
    </div>

    <div class="lv__body">
      <div v-if="shown.length === 0" class="lv__empty">
        还没有日志。桥接进程的输出会实时出现在这里 —— 启动失败、找不到 claude.exe、握手超时都会留在这。
      </div>
      <div v-for="line in shown" :key="line.seq" class="lv__line">
        <span class="lv__time">{{ formatClock(line.at) }}</span>
        <span class="lv__level" :class="`lv__level--${line.level}`">{{ line.level }}</span>
        <span class="lv__text">{{ line.text }}</span>
      </div>
    </div>

    <template #footer>
      <button class="btnGhost" type="button" :disabled="busy" @click="copyAll">复制全部</button>
      <button class="btnGhost" type="button" :disabled="busy" @click="clear">清空</button>
      <button class="btnGhost" type="button" @click="reveal">打开日志文件</button>
      <span class="lv__path" :title="file">{{ file }}</span>
    </template>
  </ShellDialog>
</template>

<style scoped>
.lv__bar {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-bottom: 8px;
  color: var(--dsw-alias-label-caption);
  font-size: 11.5px;
}

.lv__check {
  display: flex;
  align-items: center;
  gap: 5px;
  cursor: pointer;
}

.lv__dropped {
  color: var(--dsw-alias-state-warn-secondary);
}

.lv__spacer {
  flex: 1;
}

.lv__status {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.lv__body {
  height: 380px;
  padding: 8px 10px;
  border: 0.5px solid var(--dsw-alias-border-l1);
  border-radius: 8px;
  background: var(--dsw-static-neutral-bluish-1000);
  overflow-y: auto;
  font-family: var(--dsw-font-family-code);
  font-size: 11.5px;
  line-height: 17px;
}

.lv__empty {
  padding: 24px 8px;
  color: var(--dsw-alias-label-caption);
  font-family: var(--dsw-font-family);
  font-size: 12px;
  line-height: 19px;
  text-align: center;
}

.lv__line {
  display: flex;
  gap: 8px;
  white-space: pre-wrap;
  word-break: break-word;
}

.lv__time {
  flex: none;
  color: var(--dsw-alias-label-caption);
}

.lv__level {
  flex: none;
  width: 42px;
  color: var(--dsw-alias-label-tertiary);
  text-transform: uppercase;
}

.lv__level--error {
  color: var(--dsw-alias-state-error-primary);
}

.lv__level--warn {
  color: var(--dsw-alias-state-warn-secondary);
}

.lv__text {
  min-width: 0;
  color: var(--dsw-alias-label-secondary);
}

.lv__path {
  min-width: 0;
  overflow: hidden;
  font-family: var(--dsw-font-family-code);
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>
