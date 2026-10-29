<script setup lang="ts">
/**
 * 移动端功能菜单。
 *
 * 两种形态：
 * - 默认：橙色悬浮球，可拖到任意角落，点开右侧白色抽屉；
 * - `inline`：不再浮着，作为第三行的普通按钮（和「对话 / 轨迹 / Git」同一行），
 *   抽屉仍然是覆盖式的。
 */
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'

type Action = 'restart' | 'logs' | 'plugins' | 'author' | 'shop' | 'feedback'

const props = defineProps<{ inline?: boolean }>()

const emit = defineEmits<{ (e: 'action', name: Action): void }>()

const SIZE = 52
const MARGIN = 10
const STORE_KEY = 'cccn.fabPos'

const open = ref(false)
const pos = ref({ x: -1, y: -1 })
const dragging = ref(false)

let start = { x: 0, y: 0, px: 0, py: 0 }
let moved = false
/** 最近一次展开的时刻，用来忽略紧跟着的那一下遮罩点击。 */
let openedAt = 0

const style = computed(() => {
  if (pos.value.x < 0) return {}
  return { left: `${pos.value.x}px`, top: `${pos.value.y}px` }
})

const items: Array<{ key: Action; label: string; icon: string }> = [
  { key: 'restart', label: '重启', icon: '⟳' },
  { key: 'logs', label: '运行日志', icon: '☰' },
  { key: 'plugins', label: '插件管理', icon: '⧉' },
  { key: 'author', label: '作者信息', icon: '☺' },
  { key: 'shop', label: '休闲食品商城', icon: '🛒' },
  { key: 'feedback', label: '评价与反馈', icon: '✉' },
]

function clamp(x: number, y: number) {
  const maxX = Math.max(MARGIN, window.innerWidth - SIZE - MARGIN)
  const maxY = Math.max(MARGIN, window.innerHeight - SIZE - MARGIN)
  return { x: Math.min(Math.max(MARGIN, x), maxX), y: Math.min(Math.max(MARGIN, y), maxY) }
}

function restore() {
  const fallback = clamp(window.innerWidth - SIZE - 16, window.innerHeight - SIZE - 120)
  try {
    const raw = localStorage.getItem(STORE_KEY)
    if (raw) {
      const saved = JSON.parse(raw) as { x?: number; y?: number }
      if (typeof saved.x === 'number' && typeof saved.y === 'number') {
        pos.value = clamp(saved.x, saved.y)
        return
      }
    }
  } catch {
    /* 坏掉的坐标不该挡住按钮，按默认落点摆 */
  }
  pos.value = fallback
}

function onPointerDown(event: PointerEvent) {
  if (props.inline) return
  if (event.button !== 0) return
  dragging.value = true
  moved = false
  start = { x: event.clientX, y: event.clientY, px: pos.value.x, py: pos.value.y }
  ;(event.currentTarget as HTMLElement).setPointerCapture(event.pointerId)
}

function onPointerMove(event: PointerEvent) {
  if (!dragging.value) return
  const dx = event.clientX - start.x
  const dy = event.clientY - start.y
  if (Math.abs(dx) + Math.abs(dy) > 4) moved = true
  if (!moved) return
  pos.value = clamp(start.px + dx, start.py + dy)
}

function onPointerUp(event: PointerEvent) {
  if (!dragging.value) return
  dragging.value = false
  ;(event.currentTarget as HTMLElement).releasePointerCapture?.(event.pointerId)
  if (!moved) return
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(pos.value))
  } catch {
    /* 私有模式写不进去也不影响拖动 */
  }
}

/**
 * 展开/收起只能挂在 click 上。
 * 若挂 pointerup：pointerup 改状态 → Vue 立刻把遮罩挂到手指下面 → 随后浏览器补发的
 * click 正好落在遮罩上，又被 @click.self 关掉，表现就是「点了球没反应」。
 */
function onClick() {
  if (moved) {
    // 刚才那一下是拖动，不要顺带把菜单打开
    moved = false
    return
  }
  open.value = !open.value
  openedAt = Date.now()
}

function pick(name: Action) {
  open.value = false
  emit('action', name)
}

/** 遮罩关闭要跳过刚打开的那一下点击，否则菜单仍然会瞬开瞬关。 */
function closeFromScrim() {
  if (Date.now() - openedAt < 350) return
  open.value = false
}

function onResize() {
  if (props.inline) return
  pos.value = clamp(pos.value.x, pos.value.y)
}

onMounted(() => {
  if (!props.inline) restore()
  window.addEventListener('resize', onResize)
})

onBeforeUnmount(() => {
  window.removeEventListener('resize', onResize)
})
</script>

<template>
  <div class="fab" :class="{ 'fab--inline': props.inline }" :style="props.inline ? undefined : style">
    <button
      class="fab__ball"
      type="button"
      :class="{ 'fab__ball--open': open }"
      aria-label="功能菜单"
      @pointerdown="onPointerDown"
      @pointermove="onPointerMove"
      @pointerup="onPointerUp"
      @click="onClick"
    >
      ☰
    </button>
  </div>

  <div v-if="open" class="fab__scrim" @click.self="closeFromScrim">
    <nav class="fab__drawer" role="menu" aria-label="功能菜单">
      <p class="fab__brand">ChinaClaude</p>

      <button
        v-for="item in items"
        :key="item.key"
        class="fab__row"
        type="button"
        role="menuitem"
        @click="pick(item.key)"
      >
        <span class="fab__icon">{{ item.icon }}</span>
        <span class="fab__label">{{ item.label }}</span>
      </button>

      <button class="fab__close" type="button" @click="open = false">关闭菜单</button>
    </nav>
  </div>
</template>

<style scoped>
.fab {
  position: fixed;
  z-index: 70;
}

.fab--inline {
  position: static;
}

.fab__ball {
  /* 拖动时不要顺带滚动页面；不 preventDefault，否则浏览器不再补发 click。 */
  touch-action: none;
  width: 52px;
  height: 52px;
  border-radius: 50%;
  border: none;
  background: #f6a55c;
  color: #2a1a08;
  font-size: 20px;
  line-height: 1;
  box-shadow: 0 6px 18px rgba(0, 0, 0, 0.45);
  cursor: grab;
}

.fab__ball--open {
  background: #ffb974;
}

/* 遮罩只在右侧留一条窄缝，让人知道「后面还是原来的页面」。 */
.fab__scrim {
  position: fixed;
  inset: 0;
  z-index: 80;
  background: rgba(0, 0, 0, 0.28);
  display: flex;
  justify-content: flex-end;
}

.fab__drawer {
  width: min(84vw, 360px);
  height: 100%;
  padding: 18px 14px 14px;
  background: #f7f7f8;
  color: #1d1d1f;
  display: flex;
  flex-direction: column;
  gap: 2px;
  overflow-y: auto;
  box-shadow: -8px 0 24px rgba(0, 0, 0, 0.25);
}

.fab__brand {
  margin: 4px 10px 14px;
  font-size: 13px;
  color: #8b8b93;
  letter-spacing: 0.4px;
}

.fab__row {
  display: flex;
  align-items: center;
  gap: 14px;
  padding: 14px 12px;
  border: none;
  border-radius: 10px;
  background: transparent;
  color: #1d1d1f;
  font-size: 16px;
  text-align: left;
  cursor: pointer;
}

.fab__row:active {
  background: rgba(246, 165, 92, 0.22);
}

.fab__icon {
  width: 22px;
  text-align: center;
  font-size: 16px;
  color: #6b6b73;
}

.fab__label {
  flex: 1;
}

.fab__close {
  margin-top: auto;
  padding: 13px 12px;
  border: 1px solid #d9d9de;
  border-radius: 12px;
  background: #ffffff;
  color: #1d1d1f;
  font-size: 15px;
  cursor: pointer;
}
</style>
