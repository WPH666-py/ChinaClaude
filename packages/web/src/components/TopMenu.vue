<script setup lang="ts">
/**
 * The top menu bar — the same ten entries the reference app (Harness-CN) carries, in the same order.
 *
 * WHY A CUSTOM BAR RATHER THAN A NATIVE MENU: the reference app's bar is part of the page, and the
 * reason is visible in this one — every entry opens an in-app window that is themed, resizable and
 * testable, whereas a native menu would have to be rebuilt per platform and could not show state
 * (a running download, a version, a failure sentence).
 *
 * WHY THE BAR OWNS THE WINDOWS: the alternative is eleven `v-if`s in `App.vue` plus eleven refs, and
 * a menu that cannot be moved without editing the app root. Here the only things that leave this file
 * are the two actions that genuinely belong to the app: opening settings and switching sessions.
 */
import { ref } from 'vue'
import LogViewerPanel from './LogViewerPanel.vue'

import AuthorPanel from './AuthorPanel.vue'
import ShopPanel from './ShopPanel.vue'
import FeedbackPanel from './FeedbackPanel.vue'

import { invokeShell } from '../composables/useShellApi'
import type { BridgeEvent, PricedTimeline, SessionView } from '../types'

/** Only the fields this bar reports; the full shape lives in `types.ts`. */
interface UpdateOutcome {
  ok?: boolean
  available?: boolean
  latest?: string
  current?: string
  errors?: string[]
}

const props = withDefaults(
  defineProps<{
    version?: string
    cwd?: string | null
    sessionId?: string | null
    sessionEvents?: BridgeEvent[]
    sessions?: SessionView[]
    sessionCost?: PricedTimeline | null
    modelContext?: { window?: number; model?: string } | null
    /** Supplied by the app root, which owns the update dialog and the bridge handle. */
    checkUpdate?: () => Promise<UpdateOutcome>
    /**
     * 小屏：只藏按钮行，组件仍然渲染。
     *
     * 运行日志 / 作者 / 商城是 TopMenu 自己的弹窗，藏掉组件就等于藏掉它们的能力，
     * 所以悬浮球通过下面 expose 的方法远程触发，而不是另起一套。
     */
    compact?: boolean
  }>(),
  { version: '', cwd: null, sessionId: null, compact: false },
)

const emit = defineEmits<{
  (e: 'open-settings', section: string): void
  (e: 'select-session', id: string): void
  /** The workbench is a right-hand dock now, so the menu only asks the shell to toggle it. */
  (e: 'toggle-workbench'): void
  /** 打开整页的服务器管理（不是弹窗）。 */
  (e: 'open-server'): void
  (e: 'open-mobile'): void
}>()

/** 悬浮球远程触发的入口：只暴露「打开某个弹窗」这类动作，不碰内部状态。 */
defineExpose({
  restart,
  checkUpdates,
  showLogs: () => (open.value = 'logs'),
  showAuthor: () => (open.value = 'author'),
  showShop: () => (open.value = 'shop'),
  showFeedback: () => (open.value = 'feedback'),
})

type Window = 'logs' | 'plugins' | 'author' | 'shop' | 'feedback' | 'server' | null
const open = ref<Window>(null)
/** One line of feedback for the actions that have nowhere else to report. */
const notice = ref('')
const busy = ref(false)

function say(text: string) {
  notice.value = text
}

/** Clear the notice after a moment, so a stale "已重启" is not read as current state. */
function sayBriefly(text: string) {
  say(text)
  window.setTimeout(() => {
    if (notice.value === text) notice.value = ''
  }, 6000)
}

async function checkUpdates() {
  if (!props.checkUpdate) return
  busy.value = true
  say('正在检查更新…')
  try {
    const result = await props.checkUpdate()
    if (result.available && result.latest) sayBriefly(`发现新版本 ${result.latest}（当前 ${result.current ?? props.version}）`)
    else if (result.ok === false) sayBriefly(`检查失败：${(result.errors ?? ['两个源都没答上']).join('；')}`)
    else sayBriefly(`已是最新版本（${result.current ?? props.version}）`)
  } catch (problem) {
    sayBriefly(`检查失败：${problem instanceof Error ? problem.message : String(problem)}`)
  } finally {
    busy.value = false
  }
}

/**
 * Quit and restart go through the Tauri shell, not the bridge: the bridge is a child process and
 * cannot close the window that owns it. A browser preview has no shell, so the failure is reported
 * as a sentence instead of silently doing nothing.
 */
async function restart() {
  say('正在重启…')
  const answer = await invokeShell('shell_restart')
  if (!answer.ok) {
    sayBriefly(`重启失败：${answer.error ?? '未知原因'}`)
  }
}

async function devtools() {
  const answer = await invokeShell('shell_devtools')
  sayBriefly(answer.ok ? '已打开开发者工具' : `打开失败：${answer.error ?? '未知原因'}`)
}
</script>

<template>
  <div class="tm" :class="{ 'tm--compact': compact }">
    <button class="tm__item" type="button" :disabled="busy" @click="restart">重启</button>
    <button class="tm__item" type="button" @click="open = 'logs'">运行日志</button>
    <button class="tm__item" type="button" :title="cwd ? cwd : '先打开一个工作目录'" @click="emit('toggle-workbench')">工作台</button>
    <button class="tm__item" type="button" @click="emit('open-settings', 'plugins')">插件管理</button>
    <button class="tm__item" type="button" :disabled="busy" @click="checkUpdates">检查更新</button>
    <button class="tm__item" type="button" @click="emit('open-settings', 'models')">API 密钥</button>
    <button class="tm__item" type="button" @click="open = 'author'">作者信息</button>
    <button class="tm__item" type="button" @click="open = 'shop'">休闲食品商城</button>
    <button class="tm__item" type="button" @click="open = 'feedback'">评价与反馈</button>
    <button class="tm__item" type="button" @click="devtools">开发者工具</button>
    <button class="tm__item" type="button" @click="emit('open-mobile')">移动访问</button>
        <button class="tm__item" type="button" @click="emit('open-server')">服务器管理</button>

    <span class="tm__spacer" />
    <span v-if="notice" class="tm__notice">{{ notice }}</span>
  </div>

  <LogViewerPanel v-if="open === 'logs'" @close="open = null" />
  <AuthorPanel v-else-if="open === 'author'" @close="open = null" />
  <ShopPanel v-else-if="open === 'shop'" @close="open = null" />
  <FeedbackPanel v-else-if="open === 'feedback'" @close="open = null" />

</template>

<style scoped>
/* 小屏：按钮行交给悬浮球；只把这一条横栏收成 0 高，弹窗仍在树里（隐藏组件会连弹窗一起隐藏）。 */
.tm--compact {
  height: 0;
  padding: 0;
  border-bottom: none;
  background: transparent;
}
.tm--compact > .tm__item,
.tm--compact > .tm__version {
  display: none;
}

.tm {
  display: flex;
  flex: none;
  align-items: center;
  gap: 2px;
  height: 34px;
  padding: 0 10px;
  border-bottom: 0.5px solid var(--dsw-alias-border-l1);
  background: var(--dsw-alias-bg-layer-1);
  /* A bar, not a control strip: it must not be selectable like text when the user drags across it. */
  user-select: none;
}

.tm__brand {
  margin-right: 10px;
  color: var(--dsw-alias-label-tertiary);
  font-size: 11.5px;
  font-weight: 600;
  letter-spacing: 0.2px;
}

.tm__item {
  padding: 3px 9px;
  border-radius: 6px;
  color: var(--dsw-alias-label-secondary);
  font-size: 12.5px;
  white-space: nowrap;
}

.tm__item:hover:not(:disabled) {
  background: var(--dsw-alias-interactive-bg-hover);
  color: var(--dsw-alias-label-primary);
}

.tm__item:disabled {
  opacity: 0.5;
}

.tm__item--danger:hover:not(:disabled) {
  background: var(--dsw-alias-interactive-bg-hover-danger);
  color: var(--dsw-alias-state-error-primary);
}

.tm__spacer {
  flex: 1;
}

.tm__notice {
  min-width: 0;
  overflow: hidden;
  color: var(--dsw-alias-label-caption);
  font-size: 11.5px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.tm__version {
  margin-left: 10px;
  color: var(--dsw-alias-label-caption);
  font-family: var(--dsw-font-family-code);
  font-size: 11px;
}

/**
 * A phone is ~360–430 CSS px wide, and the ten entries above need ~620 px in one row. Left as a
 * single row the bar simply clips: the last entries ("开发者工具", "退出") cannot be reached at all,
 * because a flex row with `overflow: hidden` neither wraps nor scrolls.
 *
 * WRAPPING, NOT SCROLLING: these are app commands, not content — a horizontally scrolled menu hides
 * the exit button behind a gesture nobody expects on a menu bar. Wrapping to two or three rows keeps
 * every entry a tap away, and the bar grows instead of clipping. The width at which this kicks in
 * matches the shell's existing phone breakpoint (`720px`), so the whole layout flips together.
 */
@media (max-width: 720px) {
  .tm {
    flex-wrap: wrap;
    height: auto;
    min-height: 34px;
    padding: 4px 8px;
    row-gap: 2px;
  }

  /* The spacer only exists to push the notice/version to the right edge of a full-width row; once
     the bar wraps it adds an empty line, so the version is pinned right by its own rule instead. */
  .tm__spacer {
    display: none;
  }

  .tm__brand {
    margin-right: 6px;
  }

  .tm__item {
    padding: 3px 7px;
  }

  /* `{notice}` is a transient sentence, not a menu entry: on a narrow bar it is dropped so the
     entries always win the row, and the same text still surfaces in the panels that own it. */
  .tm__notice {
    display: none;
  }

  .tm__version {
    margin-left: auto;
  }
}
</style>
