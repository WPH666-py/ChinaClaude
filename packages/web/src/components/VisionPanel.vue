<script setup lang="ts">
/**
 * 图片理解 — one image in, text evidence out, for a model that cannot see pictures.
 *
 * WHY THIS WINDOW EXISTS AT ALL
 *
 * The assistant on the other side of the conversation is text-only: an image path in a message is
 * just characters to it, and asking it to "guess from the filename" is how a screenshot ends up
 * described wrong. The vendored modlens CLI turns the image into structured JSON (every word
 * transcribed, layout regions, semantics) which can then be pasted straight into the conversation.
 * So this window is a converter, not a viewer — it deliberately shows text, never the picture.
 *
 * WHY IT REFUSES TO PRETEND
 *
 * The CLI needs a vision provider (a Gemini key, an OpenAI-compatible endpoint, an agent CLI login).
 * A machine without one is a normal, expected state, and the failure mode of a panel like this is to
 * show an empty JSON box that reads as "the image has no text". So the status is asked BEFORE the
 * button is offered (`/api/vision/status` runs the CLI's own quota-free `doctor`), and the three
 * unavailability reasons — no CLI, broken probe, no provider — are stated separately with the
 * doctor's own fix commands, because they need three different user actions.
 *
 * WHY THE FILE LIST IS A PLAIN DIRECTORY READ
 *
 * A native file dialog lives in the Rust shell and cannot hand a path back through the bridge's HTTP
 * surface, so the picker is a directory listing: type or paste a directory, see the images in it,
 * click one. Newest first, because the image someone wants here is almost always the screenshot they
 * just took, and the first row is pre-selected for the same reason.
 */
import { computed, onMounted, ref } from 'vue'
import ShellDialog from './ShellDialog.vue'
import { formatAgo, formatBytes, shellGet, shellPost } from '../composables/useShellApi'

const props = defineProps<{
  /** Starting directory for the picker; the session's workspace when there is one. */
  cwd?: string | null
}>()

const emit = defineEmits<{ (e: 'close'): void }>()

/** Mirrors `visionStatus()` in packages/bridge/src/vision.mjs. */
interface VisionStatus {
  ok: boolean
  available: boolean
  cli?: string | null
  cliSource?: string | null
  version?: string | null
  node?: string | null
  provider?: string | null
  reason?: string | null
  hint?: string | null
}

/** Mirrors `listImages()`. */
interface VisionImage {
  path: string
  name: string
  size: number
  at: number
}

interface ImageListing {
  ok: boolean
  dir: string
  images?: VisionImage[]
  truncated?: boolean
  error?: string
}

/**
 * The evidence the CLI returns, typed only as far as this window renders it.
 *
 * `[key: string]: unknown` is deliberate: the document is third-party JSON, and a version that adds
 * fields must still display, rather than being rejected by an exhaustive local type.
 */
interface VisionEvidence {
  image?: string
  provider?: string
  result?: {
    summary?: string
    ocr?: { full_text?: string; lines?: Array<{ text?: string; language?: string }> }
    layout?: { regions?: Array<{ type?: string; reading_order?: number; text?: string }> }
    semantics?: { scene?: string; intent?: string }
    visual?: { style?: string; dominant_colors?: string[]; notes?: string[] }
    uncertainty?: string[]
  }
  meta?: {
    model?: string | null
    generatedAt?: string
    durationSeconds?: number | null
    warnings?: string[]
  }
  [key: string]: unknown
}

/** Mirrors `readImage()`. */
interface ReadResult {
  ok: boolean
  evidence?: VisionEvidence | null
  raw?: string
  stderr?: string
  durationMs?: number
  error?: string
}

const status = ref<VisionStatus | null>(null)
const statusProblem = ref('')
const checking = ref(false)

const dir = ref(props.cwd ?? '')
const images = ref<VisionImage[]>([])
const listing = ref('')
const loadingList = ref(false)

const selected = ref<string | null>(null)
const focus = ref('')

const reading = ref(false)
const readProblem = ref('')
const readDone = ref(false)
const durationMs = ref(0)
const evidence = ref<VisionEvidence | null>(null)
const copied = ref('')

const available = computed(() => status.value?.available === true)

/**
 * The unavailable states, each titled and coloured separately.
 *
 * A missing CLI is a broken install (error), a missing provider is a configuration step the user
 * simply has not taken yet (warn) — showing them the same way would make a normal first run look
 * like a crash.
 *
 * The bridge's `reason` is a standalone sentence so it survives being read on its own; under a title
 * that already says the same words it would stutter, so the shared prefix is dropped here.
 */
function withoutPrefix(text: string, prefix: string): string {
  return text.startsWith(prefix) ? text.slice(prefix.length) : text
}

const blocked = computed(() => {
  if (statusProblem.value !== '') {
    return { kind: 'error' as const, title: '无法确定 modlens 状态', detail: statusProblem.value, hint: '' }
  }
  if (status.value === null) return null
  if (!status.value.ok) {
    return {
      kind: 'error' as const,
      title: 'modlens 状态检查失败',
      detail: status.value.reason ?? '',
      hint: status.value.hint ?? '',
    }
  }
  if (status.value.available) return null
  if (!status.value.cli) {
    return {
      kind: 'error' as const,
      title: '未找到 modlens',
      detail: withoutPrefix(status.value.reason ?? '', '未找到 modlens CLI：'),
      hint: status.value.hint ?? '',
    }
  }
  return {
    kind: 'warn' as const,
    title: '缺少视觉 provider',
    detail: withoutPrefix(status.value.reason ?? '', '缺少视觉 provider：'),
    hint: status.value.hint ?? '',
  }
})

/** One line, always present, so the window never looks idle while something is happening. */
const readStatus = computed(() => {
  if (reading.value) return { kind: 'busy' as const, text: '正在读取…' }
  if (readProblem.value !== '') return { kind: 'error' as const, text: `读取失败：${readProblem.value}` }
  if (readDone.value) return { kind: 'ok' as const, text: `读取完成（耗时 ${durationMs.value} ms）` }
  if (!available.value) return { kind: 'idle' as const, text: '读取功能当前不可用，原因见上方' }
  if (selected.value === null) return { kind: 'idle' as const, text: '先在左侧选中一张图片' }
  return { kind: 'idle' as const, text: '尚未读取' }
})

const pretty = computed(() => (evidence.value ? JSON.stringify(evidence.value, null, 2) : ''))
/** The transcription is the single most useful field for a text-only model, so it gets its own box. */
const transcription = computed(() => evidence.value?.result?.ocr?.full_text ?? '')
const uncertainty = computed(() => evidence.value?.result?.uncertainty ?? [])
const facts = computed(() => {
  const meta = evidence.value?.meta
  const parts: string[] = []
  if (evidence.value?.provider) parts.push(`provider ${evidence.value.provider}`)
  if (meta?.model) parts.push(`模型 ${meta.model}`)
  if (typeof meta?.durationSeconds === 'number') parts.push(`provider 耗时 ${meta.durationSeconds}s`)
  return parts.join(' · ')
})

async function loadStatus() {
  checking.value = true
  try {
    status.value = await shellGet<VisionStatus>('/api/vision/status')
    statusProblem.value = ''
  } catch (problem) {
    status.value = null
    statusProblem.value = problem instanceof Error ? problem.message : String(problem)
  } finally {
    checking.value = false
  }
}

async function loadImages() {
  loadingList.value = true
  listing.value = ''
  try {
    const answer = await shellGet<ImageListing>('/api/vision/images', { dir: dir.value.trim() })
    if (!answer.ok) {
      images.value = []
      selected.value = null
      listing.value = answer.error ?? '无法列出目录'
      return
    }
    images.value = answer.images ?? []
    // Keep the user's pick across a refresh; otherwise pre-select the newest, which is what a
    // screenshot workflow wants almost every time.
    const stillThere = images.value.some((image) => image.path === selected.value)
    if (!stillThere) selected.value = images.value[0]?.path ?? null
    listing.value =
      images.value.length === 0
        ? `${answer.dir} 里没有图片文件`
        : `${images.value.length} 张图片${answer.truncated ? '（已达上限，只显示最新的一部分）' : ''}`
  } catch (problem) {
    images.value = []
    selected.value = null
    listing.value = `列出失败：${problem instanceof Error ? problem.message : String(problem)}`
  } finally {
    loadingList.value = false
  }
}

async function read() {
  if (selected.value === null || reading.value) return
  reading.value = true
  readProblem.value = ''
  readDone.value = false
  copied.value = ''
  // Cleared before the request: stale evidence left on screen next to a new image's name would be
  // read as that image's content, which is the one mistake this window must not make.
  evidence.value = null
  const started = Date.now()
  try {
    const answer = await shellPost<ReadResult>('/api/vision/read', {
      path: selected.value,
      focus: focus.value.trim(),
    })
    durationMs.value = answer.durationMs ?? Date.now() - started
    if (!answer.ok || !answer.evidence) {
      readProblem.value = answer.error ?? 'modlens 没有返回证据'
      return
    }
    evidence.value = answer.evidence
    readDone.value = true
  } catch (problem) {
    durationMs.value = Date.now() - started
    readProblem.value = problem instanceof Error ? problem.message : String(problem)
  } finally {
    reading.value = false
  }
}

async function copyText(text: string, label: string) {
  if (text === '') return
  try {
    await navigator.clipboard.writeText(text)
    copied.value = `已复制${label}（${text.length} 字）`
  } catch {
    copied.value = '复制失败：剪贴板不可用'
  }
}

onMounted(() => {
  void loadStatus()
  if (dir.value.trim() !== '') void loadImages()
})
</script>

<template>
  <ShellDialog title="图片理解" :width="880" @close="emit('close')">
    <p class="vp__why">纯文本模型看不到图片，这个窗口把图片转成文字证据，可以直接贴进对话。</p>

    <div v-if="blocked" class="vp__banner" :class="`vp__banner--${blocked.kind}`">
      <div class="vp__bannerTop">
        <span class="vp__bannerTitle">{{ blocked.title }}</span>
        <span class="vp__spacer" />
        <button class="btnGhost" type="button" :disabled="checking" @click="loadStatus">
          {{ checking ? '检查中…' : '重新检查' }}
        </button>
      </div>
      <p v-if="blocked.detail" class="vp__bannerText">{{ blocked.detail }}</p>
      <p v-if="blocked.hint" class="vp__bannerHint">{{ blocked.hint }}</p>
    </div>

    <div class="vp__grid">
      <section class="vp__col vp__col--left">
        <div class="vp__row">
          <input
            v-model="dir"
            class="vp__input vp__input--dir"
            spellcheck="false"
            placeholder="图片所在目录（绝对路径）"
            @keyup.enter="loadImages"
          />
          <button class="btnGhost" type="button" :disabled="loadingList" @click="loadImages">刷新</button>
        </div>

        <p class="vp__hint">{{ listing || '输入一个目录后点刷新，列出里面的图片' }}</p>

        <div class="vp__list">
          <div v-if="loadingList" class="vp__listEmpty"><span class="spinner" /> 正在列出图片…</div>
          <div v-else-if="images.length === 0" class="vp__listEmpty">这个目录里没有 png / jpg / jpeg / webp / gif / bmp</div>
          <!-- The v-else matters: without it the previous directory's rows stay clickable under the
               spinner, so a fast click selects an image that is no longer in the list. -->
          <template v-else>
            <button
              v-for="image in images"
              :key="image.path"
              class="vp__item"
              :class="{ 'vp__item--active': image.path === selected }"
              type="button"
              :title="image.path"
              @click="selected = image.path"
            >
              <span class="vp__itemName">{{ image.name }}</span>
              <span class="vp__itemMeta">{{ formatBytes(image.size) }} · {{ formatAgo(image.at) }}</span>
            </button>
          </template>
        </div>
      </section>

      <section class="vp__col vp__col--right">
        <div class="vp__row">
          <input
            v-model="focus"
            class="vp__input"
            spellcheck="false"
            placeholder="可选的额外关注点，例如：只看坐标轴的刻度"
          />
          <button class="btnPrimary" type="button" :disabled="!available || selected === null || reading" @click="read">
            读取图片
          </button>
        </div>

        <p class="vp__status" :class="`vp__status--${readStatus.kind}`">
          <span v-if="reading" class="spinner" />
          {{ readStatus.text }}
        </p>

        <p v-if="facts" class="vp__facts">{{ facts }}</p>

        <p v-if="uncertainty.length > 0" class="vp__uncertainty">不确定项：{{ uncertainty.join('；') }}</p>

        <div v-if="transcription !== ''" class="vp__box vp__box--transcription">
          <div class="vp__boxHead">逐字转写（ocr.full_text）</div>
          <pre class="vp__pre vp__pre--transcription">{{ transcription }}</pre>
        </div>

        <div class="vp__box">
          <div class="vp__boxHead">证据 JSON</div>
          <pre v-if="pretty" class="vp__pre">{{ pretty }}</pre>
          <div v-else class="vp__empty">
            选中左侧的图片并点「读取图片」，这里会显示模型读到的文字、版面与语义证据。
          </div>
        </div>
      </section>
    </div>

    <template #footer>
      <button class="btnGhost" type="button" :disabled="pretty === ''" @click="copyText(pretty, ' JSON')">复制 JSON</button>
      <button
        class="btnGhost"
        type="button"
        :disabled="transcription === ''"
        @click="copyText(transcription, '转写文本')"
      >
        复制转写
      </button>
      <span v-if="copied" class="vp__copied">{{ copied }}</span>
      <span class="vp__spacer" />
      <span v-if="available" class="vp__provenance" :title="status?.cli ?? ''">
        modlens {{ status?.version ?? '?' }} · provider {{ status?.provider ?? '?' }}
      </span>
      <span v-else-if="status?.cli" class="vp__provenance" :title="status.cli">
        未启用 · {{ status.cliSource ?? '' }}
      </span>
    </template>
  </ShellDialog>
</template>

<style scoped>
.vp__why {
  margin: 0 0 10px;
  color: var(--dsw-alias-label-caption);
  font-size: 11.5px;
  line-height: 17px;
}

.vp__banner {
  margin-bottom: 12px;
  padding: 10px 12px;
  border: 0.5px solid var(--dsw-alias-border-l1);
  border-radius: 8px;
  background: var(--dsw-alias-bg-layer-1);
}

.vp__banner--warn {
  border-color: var(--dsw-alias-state-warn-secondary);
}

.vp__banner--error {
  border-color: var(--dsw-alias-state-error-primary);
}

.vp__bannerTop {
  display: flex;
  align-items: center;
  gap: 10px;
}

.vp__bannerTitle {
  font-size: 12.5px;
  font-weight: 600;
}

.vp__banner--warn .vp__bannerTitle {
  color: var(--dsw-alias-state-warn-secondary);
}

.vp__banner--error .vp__bannerTitle {
  color: var(--dsw-alias-state-error-primary);
}

.vp__bannerText {
  margin: 6px 0 0;
  color: var(--dsw-alias-label-secondary);
  font-size: 12px;
  line-height: 18px;
}

.vp__bannerHint {
  margin: 4px 0 0;
  color: var(--dsw-alias-label-caption);
  font-family: var(--dsw-font-family-code);
  font-size: 11px;
  line-height: 16px;
  word-break: break-word;
}

.vp__grid {
  display: grid;
  grid-template-columns: 300px 1fr;
  gap: 14px;
  align-items: start;
}

.vp__col {
  display: flex;
  flex-direction: column;
  gap: 8px;
  min-width: 0;
}

.vp__row {
  display: flex;
  flex-direction: column;
  align-items: stretch;
  gap: 8px;
}

.vp__input {
  flex: 1;
  min-width: 0;
  padding: 6px 10px;
  border: 0.5px solid var(--dsw-alias-border-l2);
  border-radius: 8px;
  background: var(--dsw-static-neutral-bluish-900);
  outline: none;
  color: var(--dsw-alias-label-primary);
  font-size: 12px;
}

.vp__input:focus {
  border-color: var(--dsw-alias-state-business-primary);
}

.vp__input--dir {
  font-family: var(--dsw-font-family-code);
  font-size: 11.5px;
}

.vp__hint {
  margin: 0;
  min-height: 16px;
  color: var(--dsw-alias-label-caption);
  font-size: 11px;
  line-height: 16px;
}

.vp__list {
  height: 380px;
  padding: 4px;
  border: 0.5px solid var(--dsw-alias-border-l1);
  border-radius: 8px;
  background: var(--dsw-static-neutral-bluish-1000);
  overflow-y: auto;
}

.vp__listEmpty {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  height: 100%;
  padding: 0 12px;
  color: var(--dsw-alias-label-caption);
  font-size: 11.5px;
  line-height: 17px;
  text-align: center;
}

.vp__item {
  display: flex;
  flex-direction: column;
  gap: 2px;
  width: 100%;
  padding: 7px 8px;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: inherit;
  cursor: pointer;
  text-align: left;
}

.vp__item:hover {
  background: var(--dsw-alias-interactive-bg-hover);
}

.vp__item--active {
  background: var(--dsw-alias-bg-layer-3);
}

.vp__itemName {
  min-width: 0;
  overflow: hidden;
  color: var(--dsw-alias-label-primary);
  font-family: var(--dsw-font-family-code);
  font-size: 11.5px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.vp__item--active .vp__itemName {
  color: var(--dsw-alias-state-success-secondary);
}

.vp__itemMeta {
  color: var(--dsw-alias-label-caption);
  font-size: 10.5px;
}

.vp__status {
  display: flex;
  align-items: center;
  gap: 7px;
  margin: 0;
  min-height: 17px;
  color: var(--dsw-alias-label-tertiary);
  font-size: 11.5px;
}

.vp__status--ok {
  color: var(--dsw-alias-state-success-secondary);
}

.vp__status--error {
  color: var(--dsw-alias-state-error-primary);
  word-break: break-word;
}

.vp__status--idle {
  color: var(--dsw-alias-label-caption);
}

.vp__facts,
.vp__uncertainty {
  margin: 0;
  color: var(--dsw-alias-label-caption);
  font-size: 11px;
  line-height: 16px;
}

.vp__uncertainty {
  color: var(--dsw-alias-state-warn-secondary);
}

.vp__box {
  display: flex;
  flex-direction: column;
  min-width: 0;
  border: 0.5px solid var(--dsw-alias-border-l1);
  border-radius: 8px;
  background: var(--dsw-static-neutral-bluish-1000);
  overflow: hidden;
}

.vp__boxHead {
  flex: none;
  padding: 6px 10px;
  border-bottom: 0.5px solid var(--dsw-alias-border-l1);
  color: var(--dsw-alias-label-caption);
  font-size: 11px;
}

.vp__pre {
  margin: 0;
  height: 268px;
  padding: 8px 10px;
  overflow: auto;
  color: var(--dsw-alias-label-secondary);
  font-family: var(--dsw-font-family-code);
  font-size: 11px;
  line-height: 16px;
  white-space: pre-wrap;
  word-break: break-word;
}

/* The transcription is prose, not JSON: shorter box, primary label colour, readable line height. */
.vp__pre--transcription {
  height: auto;
  max-height: 150px;
  color: var(--dsw-alias-label-primary);
  font-size: 12px;
  line-height: 18px;
}

.vp__empty {
  display: grid;
  place-items: center;
  height: 268px;
  padding: 0 18px;
  color: var(--dsw-alias-label-caption);
  font-size: 11.5px;
  line-height: 18px;
  text-align: center;
}

.vp__spacer {
  flex: 1;
}

.vp__copied {
  color: var(--dsw-alias-state-success-secondary);
  font-size: 11px;
}

.vp__provenance {
  min-width: 0;
  overflow: hidden;
  color: var(--dsw-alias-label-caption);
  font-family: var(--dsw-font-family-code);
  font-size: 10.5px;
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>
