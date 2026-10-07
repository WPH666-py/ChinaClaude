<script setup lang="ts">
/**
 * "A newer version is available."
 *
 * Two choices, as asked: 暂不更新 closes this and does nothing else, 立刻更新 downloads, verifies and
 * runs the installer. There is no third "remind me later" state to persist — a version check runs at
 * every launch, so declining is not a decision that needs remembering.
 *
 * WHY THE WINDOW CLOSES ITSELF AT THE END: the installer replaces the running executable's files, so
 * it cannot proceed while this process holds them. Launching it and then quitting is the whole
 * upgrade; nothing uninstalls first, because the NSIS installer already removes the previous
 * version's files as part of installing — doing it in two steps would leave a window in which a
 * failure means the user has nothing installed at all.
 */
import { computed, onBeforeUnmount, ref } from 'vue'
import type { UpdateCheck, UpdateProgress } from '../types'
import type { Bridge } from '../composables/useBridge'
import { formatNumber } from '../composables/useBridge'

const props = defineProps<{
  check: UpdateCheck
  bridge: Bridge
}>()

const emit = defineEmits<{
  (e: 'close'): void
}>()

const progress = ref<UpdateProgress | null>(null)
const failure = ref<string | null>(null)
/** Nothing is running until 立刻更新 is pressed. */
const starting = ref(false)
let poll: number | null = null

const phase = computed(() => progress.value?.phase ?? 'offer')

/** Percent, or null while the total length is still unknown. */
const percent = computed(() => {
  const p = progress.value
  if (!p || !p.total) return null
  return Math.min(100, Math.round((p.received / p.total) * 100))
})

const downloadedLabel = computed(() => {
  const p = progress.value
  if (!p) return ''
  const mb = (bytes: number) => (bytes / 1024 / 1024).toFixed(1)
  return p.total ? `${mb(p.received)} / ${mb(p.total)} MB` : `${mb(p.received)} MB`
})

function stopPolling() {
  if (poll !== null) {
    window.clearInterval(poll)
    poll = null
  }
}

onBeforeUnmount(stopPolling)

async function start() {
  if (starting.value) return
  starting.value = true
  failure.value = null
  try {
    const started = await props.bridge.startUpdateDownload()
    if (started.error) {
      failure.value = started.error
      starting.value = false
      return
    }
    // Progress is polled rather than streamed: one long response is far less machinery than a second
    // event channel for a single percentage.
    poll = window.setInterval(async () => {
      try {
        const status = await props.bridge.updateStatus()
        progress.value = status
        if (status.phase === 'error') {
          failure.value = status.error ?? '下载失败'
          stopPolling()
          starting.value = false
          return
        }
        if (status.phase === 'ready') {
          stopPolling()
          const installed = await props.bridge.installUpdate()
          if (installed.error) {
            failure.value = installed.error
            starting.value = false
            return
          }
          // Give the installer a moment to take the file lock before this process lets go of it.
          window.setTimeout(() => window.close(), 1200)
        }
      } catch (error) {
        failure.value = String((error as Error).message ?? error)
        stopPolling()
        starting.value = false
      }
    }, 500)
  } catch (error) {
    failure.value = String((error as Error).message ?? error)
    starting.value = false
  }
}
</script>

<template>
  <div class="upd">
    <div class="upd__scrim" @click="phase === 'offer' ? emit('close') : undefined" />

    <div class="upd__panel" role="dialog" aria-label="发现新版本">
      <h3 class="upd__title">
        <template v-if="phase === 'offer'">发现新版本 {{ check.latest }}</template>
        <template v-else-if="phase === 'downloading' || phase === 'verifying'">正在下载 {{ check.latest }}</template>
        <template v-else-if="phase === 'ready' || phase === 'installing'">正在安装 {{ check.latest }}</template>
        <template v-else>更新失败</template>
      </h3>

      <p class="upd__versions">
        当前版本 <code>{{ check.current }}</code>
        <span class="upd__arrow">→</span>
        <code>{{ check.latest }}</code>
        <span v-if="check.source" class="upd__source">来源 {{ check.source }}</span>
      </p>

      <!-- Offer: what will happen, and what the file is. -->
      <template v-if="phase === 'offer'">
        <p class="upd__what">
          安装包 <code>{{ check.asset?.name }}</code>
          <template v-if="check.asset?.size">（{{ (check.asset.size / 1024 / 1024).toFixed(1) }} MB）</template>
        </p>
        <!--
          Say plainly whether the download can be verified. GitHub supplies a digest and Gitee does
          not, and "we could not check this" must not look like "we checked this and it is fine".
        -->
        <p class="upd__note" :class="check.asset?.sha256 ? 'upd__note--ok' : 'upd__note--warn'">
          {{ check.asset?.sha256 ? '下载后会校验 SHA-256 后再运行' : '该来源未提供校验值，下载后无法校验完整性' }}
        </p>

        <details v-if="check.notes" class="upd__notes">
          <summary>本次更新内容</summary>
          <pre class="upd__notesBody">{{ check.notes }}</pre>
        </details>

        <div class="upd__actions">
          <button class="upd__ghost" type="button" @click="emit('close')">暂不更新</button>
          <button class="upd__primary" type="button" :disabled="starting" @click="start">立刻更新</button>
        </div>
      </template>

      <!-- Downloading / verifying / installing -->
      <template v-else-if="phase !== 'error'">
        <div class="upd__bar"><span class="upd__barFill" :style="{ width: (percent ?? 0) + '%' }" /></div>
        <p class="upd__progress">
          <template v-if="phase === 'downloading'">{{ downloadedLabel }}<template v-if="percent !== null"> · {{ percent }}%</template></template>
          <template v-else-if="phase === 'verifying'">正在校验文件完整性…</template>
          <template v-else>安装程序已启动，完成后本窗口会自动关闭</template>
        </p>
        <!-- An unverifiable download is stated, not hidden: `verified` is null when the source gave
             no digest, which is a different thing from a check that passed. -->
        <p v-if="progress?.verified === true" class="upd__note upd__note--ok">SHA-256 校验通过</p>
        <p v-else-if="progress?.verified === null && phase !== 'downloading'" class="upd__note upd__note--warn">
          该来源未提供校验值，未能校验完整性
        </p>
      </template>

      <!-- Failure -->
      <template v-else>
        <p class="upd__note upd__note--error">{{ failure ?? progress?.error }}</p>
        <p class="upd__what">可以稍后再试，或到发布页手动下载。</p>
        <div class="upd__actions">
          <a v-if="check.page" class="upd__ghost" :href="check.page" target="_blank" rel="noreferrer">打开发布页</a>
          <button class="upd__ghost" type="button" @click="emit('close')">关闭</button>
        </div>
      </template>
    </div>
  </div>
</template>

<style scoped>
.upd {
  position: fixed;
  inset: 0;
  z-index: 60;
  display: grid;
  place-items: center;
}

.upd__scrim {
  position: absolute;
  inset: 0;
  background: rgb(0 0 0 / 55%);
}

.upd__panel {
  position: relative;
  width: min(520px, calc(100vw - 48px));
  padding: 18px 20px 16px;
  border: 0.5px solid var(--dsw-alias-border-l2);
  border-radius: 14px;
  background: var(--dsw-alias-bg-layer-1);
  box-shadow: 0 24px 64px rgb(0 0 0 / 45%);
}

.upd__title {
  margin: 0 0 6px;
  color: var(--dsw-alias-label-primary);
  font-size: 15px;
  font-weight: 600;
}

.upd__versions {
  margin: 0 0 12px;
  color: var(--dsw-alias-label-tertiary);
  font-size: 12px;
}

.upd__arrow {
  margin: 0 6px;
}

.upd__source {
  margin-left: 10px;
  padding: 0 6px;
  border-radius: 4px;
  background: var(--dsw-alias-bg-layer-3);
  color: var(--dsw-alias-label-caption);
  font-size: 10.5px;
}

.upd__what {
  margin: 0 0 8px;
  color: var(--dsw-alias-label-secondary);
  font-size: 12.5px;
  line-height: 19px;
  word-break: break-all;
}

.upd__note {
  margin: 0 0 10px;
  font-size: 12px;
  line-height: 18px;
}

.upd__note--ok {
  color: var(--dsw-alias-state-success-primary);
}

.upd__note--warn {
  color: var(--dsw-alias-state-warn-secondary);
}

.upd__note--error {
  color: var(--dsw-alias-state-error-primary);
}

.upd__notes {
  margin-bottom: 12px;
}

.upd__notes summary {
  color: var(--dsw-alias-link);
  font-size: 12px;
  cursor: pointer;
}

.upd__notesBody {
  max-height: 200px;
  margin: 8px 0 0;
  padding: 8px 10px;
  overflow: auto;
  border-radius: 8px;
  background: var(--dsw-alias-bg-layer-2);
  color: var(--dsw-alias-label-secondary);
  font-family: var(--dsw-font-family);
  font-size: 11.5px;
  line-height: 18px;
  white-space: pre-wrap;
  word-break: break-word;
}

.upd__bar {
  height: 6px;
  margin: 12px 0 8px;
  overflow: hidden;
  border-radius: 3px;
  background: var(--dsw-alias-bg-layer-3);
}

.upd__barFill {
  display: block;
  height: 100%;
  border-radius: 3px;
  background: var(--dsw-alias-state-business-primary);
  transition: width 0.3s ease;
}

.upd__progress {
  margin: 0 0 8px;
  color: var(--dsw-alias-label-secondary);
  font-size: 12px;
}

.upd__actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 14px;
}

.upd__ghost,
.upd__primary {
  padding: 8px 16px;
  border-radius: 8px;
  font-size: 12.5px;
  text-decoration: none;
}

.upd__ghost {
  border: 0.5px solid var(--dsw-alias-border-l2);
  background: var(--dsw-alias-bg-layer-2);
  color: var(--dsw-alias-label-primary);
}

.upd__ghost:hover {
  background: var(--dsw-alias-interactive-bg-hover-solid);
}

.upd__primary {
  border: 0;
  background: var(--dsw-alias-brand-primary, #4d6bfe);
  color: #fff;
}

.upd__primary:disabled {
  opacity: 0.55;
}
</style>
