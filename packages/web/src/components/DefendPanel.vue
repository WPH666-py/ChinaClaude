<script setup lang="ts">
/**
 * 安全防护 — what the rule engine has seen, and a place to try it.
 *
 * WHY THE 自测 BOX IS PART OF THE WINDOW: a protection feature that only shows counters asks the user to
 * trust a number. Pasting a key into the box and watching it come back redacted is the difference
 * between "扫描 412 次" and evidence — so the box is here, not hidden behind a debug flag.
 *
 * WHY THE SELF-TEST DOES NOT TOUCH THE LOG: it calls `scanText` (pure) rather than `guard`, so trying
 * the rules out cannot inflate the very counters the panel is reporting. The copy says so, because a
 * user who expects their paste to be recorded should not have to guess.
 *
 * The route contract: GET /api/defend returns `defendStats()` verbatim, POST with { action: 'scan' |
 * 'clear' }. No bridge instance is injected into this panel, which is why the base URL is resolved here.
 */
import { computed, onMounted, ref } from 'vue'
import ShellDialog from './ShellDialog.vue'

interface DefendHit {
  id: string
  at: string
  rule: string
  /** Chinese rule name, sent by the bridge so the panel carries no second mapping table. */
  ruleName?: string
  family: string
  familyLabel?: string
  severity: 'info' | 'warn' | 'block'
  where: string
  excerpt: string
}

interface FamilyRow {
  family: string
  label?: string
  hits: number
}

interface StatsAnswer {
  ok: boolean
  error?: string
  stats?: { scans: number; hits: number; blocked: number; since: string }
  byFamily?: FamilyRow[]
  recent?: DefendHit[]
  file?: string
}

interface ScanAnswer {
  ok: boolean
  error?: string
  hits?: DefendHit[]
  truncated?: boolean
}

const emit = defineEmits<{ (e: 'close'): void }>()

/**
 * Base URL resolution, mirrored from `composables/useBridge.ts:50` rather than imported: this panel is
 * handed no bridge instance, and a panel that resolved the URL its own way would talk to
 * 127.0.0.1:43130 in a dev build whose /api is proxied by vite.
 */
function baseUrl(): string {
  const injected = (globalThis as Record<string, unknown>).__CCCN_BRIDGE_URL__
  if (typeof injected === 'string' && injected.length > 0) return injected.replace(/\/$/, '')
  const param = new URLSearchParams(location.search).get('bridge')
  if (param) return param.replace(/\/$/, '')
  return import.meta.env.DEV ? '' : 'http://127.0.0.1:43130'
}

const SEVERITY_LABEL: Record<DefendHit['severity'], string> = {
  info: '提示',
  warn: '警告',
  block: '拦截',
}

const stats = ref<StatsAnswer['stats'] | null>(null)
const byFamily = ref<FamilyRow[]>([])
const recent = ref<DefendHit[]>([])
const logFile = ref('')
const loading = ref(false)
const error = ref<string | null>(null)

/** The 自测 box: what the user pasted, and what the rules said about it. */
const probe = ref('')
const probeHits = ref<DefendHit[] | null>(null)
const probeRan = ref(false)
const probeError = ref<string | null>(null)
const testing = ref(false)

/** Two-step clear: one button, but the destructive step needs a second, deliberate click. */
const confirmingClear = ref(false)
const clearing = ref(false)

const familyMax = computed(() => Math.max(1, ...byFamily.value.map((row) => row.hits)))

/** Bar width in percent; a non-zero count always shows a visible stub, never a zero-width bar. */
function barWidth(hits: number): string {
  if (hits <= 0) return '0%'
  return `${Math.max(4, Math.round((hits / familyMax.value) * 100))}%`
}

function when(at: string | undefined): string {
  if (!at) return '未知'
  const date = new Date(at)
  if (Number.isNaN(date.getTime())) return '未知'
  return date.toLocaleString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  })
}

function severityOf(hit: DefendHit): DefendHit['severity'] {
  return hit.severity === 'block' || hit.severity === 'warn' ? hit.severity : 'info'
}

async function load() {
  loading.value = true
  error.value = null
  try {
    const response = await fetch(`${baseUrl()}/api/defend`)
    const answer = (await response.json()) as StatsAnswer
    if (!answer.ok) {
      error.value = answer.error ?? '读取防护记录失败'
      return
    }
    stats.value = answer.stats ?? null
    byFamily.value = answer.byFamily ?? []
    recent.value = answer.recent ?? []
    logFile.value = answer.file ?? ''
  } catch (cause) {
    error.value = `读取防护记录失败：${cause instanceof Error ? cause.message : String(cause)}`
  } finally {
    loading.value = false
  }
}

async function runProbe() {
  const text = probe.value
  if (text.trim() === '') return
  testing.value = true
  probeError.value = null
  try {
    const response = await fetch(`${baseUrl()}/api/defend`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'scan', text }),
    })
    const answer = (await response.json()) as ScanAnswer
    if (!answer.ok) {
      probeError.value = answer.error ?? '检测失败'
      probeHits.value = null
      probeRan.value = true
      return
    }
    probeHits.value = answer.hits ?? []
    probeRan.value = true
  } catch (cause) {
    probeError.value = `检测失败：${cause instanceof Error ? cause.message : String(cause)}`
  } finally {
    testing.value = false
  }
}

function resetProbe() {
  probe.value = ''
  probeHits.value = null
  probeRan.value = false
  probeError.value = null
}

async function clearLog() {
  if (!confirmingClear.value) {
    confirmingClear.value = true
    return
  }
  clearing.value = true
  error.value = null
  try {
    const response = await fetch(`${baseUrl()}/api/defend`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'clear' }),
    })
    const answer = (await response.json()) as { ok: boolean; error?: string }
    if (!answer.ok) error.value = answer.error ?? '清空失败'
    await load()
  } catch (cause) {
    error.value = `清空失败：${cause instanceof Error ? cause.message : String(cause)}`
  } finally {
    clearing.value = false
    confirmingClear.value = false
  }
}

onMounted(load)
</script>

<template>
  <ShellDialog title="安全防护" :meta="`${recent.length} 条最近命中`" :width="780" @close="emit('close')">
    <div class="dp__privacy">
      命中记录只保留隐去后的片段，密钥原文不会写入日志。
    </div>

    <div v-if="error" class="banner banner--error">{{ error }}</div>

    <!-- counters -->
    <div class="dp__counters">
      <div class="dp__counter">
        <span class="dp__counterValue">{{ stats?.scans ?? 0 }}</span>
        <span class="dp__counterLabel">扫描次数</span>
      </div>
      <div class="dp__counter">
        <span class="dp__counterValue">{{ stats?.hits ?? 0 }}</span>
        <span class="dp__counterLabel">命中次数</span>
      </div>
      <div class="dp__counter">
        <span class="dp__counterValue dp__counterValue--block">{{ stats?.blocked ?? 0 }}</span>
        <span class="dp__counterLabel">拦截次数</span>
      </div>
      <div class="dp__since">
        统计起点 {{ when(stats?.since) }}
        <span v-if="logFile" class="dp__file" :title="logFile">{{ logFile }}</span>
      </div>
    </div>

    <!-- per-family bars -->
    <div class="dp__section">按类型</div>
    <div class="dp__families">
      <div v-for="row in byFamily" :key="row.family" class="dp__family">
        <span class="dp__familyName">{{ row.label ?? row.family }}</span>
        <span class="dp__bar"><span class="dp__barFill" :style="{ width: barWidth(row.hits) }" /></span>
        <span class="dp__familyCount">{{ row.hits }}</span>
      </div>
      <div v-if="byFamily.length === 0" class="dp__empty">还没有数据。</div>
    </div>

    <!-- recent hits -->
    <div class="dp__section">
      最近命中
      <span v-if="loading" class="spinner" />
    </div>
    <div class="dp__list">
      <div v-if="recent.length === 0" class="dp__empty">
        还没有命中记录。桥接进程在会话事件与待发送内容上各扫一遍，命中后留在这里。
      </div>
      <div v-for="hit in recent" :key="hit.id" class="dp__row">
        <div class="dp__rowTop">
          <span class="dp__sev" :class="`dp__sev--${severityOf(hit)}`">{{ SEVERITY_LABEL[severityOf(hit)] }}</span>
          <span class="dp__familyTag">{{ hit.familyLabel ?? hit.family }}</span>
          <code class="dp__rule" :title="hit.rule">{{ hit.ruleName ?? hit.rule }}</code>
          <span class="dp__where">{{ hit.where }}</span>
          <span class="dp__time">{{ when(hit.at) }}</span>
        </div>
        <code class="dp__excerpt">{{ hit.excerpt }}</code>
      </div>
    </div>

    <!-- honest demo -->
    <div class="dp__section">自测</div>
    <p class="dp__hint">
      把一段文本粘进来，立刻看到规则命中了什么、片段被隐去成什么样。自测走的是纯扫描，不会写进上面的记录，
      也不会改变计数。
    </p>
    <textarea
      v-model="probe"
      class="dp__input"
      rows="4"
      spellcheck="false"
      placeholder="例如把一行 sk-… 或 rm -rf / 贴进来"
    />
    <div class="dp__probeActions">
      <button class="btnGhost" type="button" :disabled="testing || probe.trim() === ''" @click="runProbe">
        立即检测
      </button>
      <button class="btnGhost" type="button" :disabled="testing" @click="resetProbe">清空输入</button>
      <span v-if="testing" class="spinner" />
      <span v-if="probeRan && probeHits" class="dp__probeResult">
        {{ probeHits.length > 0 ? `命中 ${probeHits.length} 条` : '没有命中任何规则' }}
      </span>
      <span v-if="probeError" class="dp__probeError">{{ probeError }}</span>
    </div>
    <div v-if="probeRan && probeHits && probeHits.length > 0" class="dp__list dp__list--probe">
      <div v-for="hit in probeHits" :key="hit.id" class="dp__row">
        <div class="dp__rowTop">
          <span class="dp__sev" :class="`dp__sev--${severityOf(hit)}`">{{ SEVERITY_LABEL[severityOf(hit)] }}</span>
          <span class="dp__familyTag">{{ hit.familyLabel ?? hit.family }}</span>
          <code class="dp__rule">{{ hit.ruleName ?? hit.rule }}</code>
        </div>
        <code class="dp__excerpt">{{ hit.excerpt }}</code>
      </div>
    </div>

    <template #footer>
      <button class="btnGhost" type="button" :disabled="clearing" @click="clearLog">
        {{ confirmingClear ? '确认清空？再点一次' : '清空记录' }}
      </button>
      <button class="btnGhost" type="button" :disabled="loading" @click="load">刷新</button>
      <span class="dp__spacer" />
      <span class="dp__footNote">清空会同时重置计数与最近命中；日志文件只保留最近 200 条。</span>
    </template>
  </ShellDialog>
</template>

<style scoped>
.dp__privacy {
  margin-bottom: 12px;
  padding: 8px 10px;
  border-radius: 8px;
  background: var(--dsw-alias-state-success-tertiary);
  color: var(--dsw-alias-state-success-secondary);
  font-size: 11.5px;
  line-height: 17px;
}

.dp__counters {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-end;
  gap: 18px;
  padding: 10px 12px;
  border: 0.5px solid var(--dsw-alias-border-l1);
  border-radius: 10px;
  background: var(--dsw-alias-bg-layer-1);
}

.dp__counter {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.dp__counterValue {
  color: var(--dsw-alias-label-primary);
  font-size: 20px;
  font-weight: 600;
  line-height: 24px;
}

.dp__counterValue--block {
  color: var(--dsw-alias-state-error-primary);
}

.dp__counterLabel {
  color: var(--dsw-alias-label-caption);
  font-size: 11px;
}

.dp__since {
  display: flex;
  flex-direction: column;
  gap: 2px;
  margin-left: auto;
  color: var(--dsw-alias-label-caption);
  font-size: 11px;
  text-align: right;
}

.dp__file {
  max-width: 320px;
  overflow: hidden;
  font-family: var(--dsw-font-family-code);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.dp__section {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 16px 0 7px;
  color: var(--dsw-alias-label-secondary);
  font-size: 12px;
  font-weight: 600;
}

.dp__families {
  display: flex;
  flex-direction: column;
  gap: 7px;
}

.dp__family {
  display: flex;
  align-items: center;
  gap: 10px;
  font-size: 12px;
}

.dp__familyName {
  flex: none;
  width: 76px;
  color: var(--dsw-alias-label-secondary);
}

.dp__bar {
  flex: 1;
  height: 8px;
  border-radius: 999px;
  background: var(--dsw-alias-bg-layer-3);
  overflow: hidden;
}

.dp__barFill {
  display: block;
  height: 100%;
  border-radius: 999px;
  background: var(--dsw-alias-state-warn-primary);
}

.dp__familyCount {
  flex: none;
  width: 46px;
  color: var(--dsw-alias-label-tertiary);
  font-family: var(--dsw-font-family-code);
  text-align: right;
}

.dp__list {
  max-height: 240px;
  padding: 4px 8px;
  border: 0.5px solid var(--dsw-alias-border-l1);
  border-radius: 8px;
  background: var(--dsw-alias-bg-layer-1);
  overflow-y: auto;
}

.dp__list--probe {
  max-height: 180px;
  margin-top: 8px;
}

.dp__row {
  padding: 6px 2px;
  border-bottom: 0.5px solid var(--dsw-alias-border-l1);
}

.dp__row:last-child {
  border-bottom: none;
}

.dp__rowTop {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 7px;
  margin-bottom: 3px;
}

.dp__sev {
  flex: none;
  padding: 1px 7px;
  border-radius: 5px;
  font-size: 10.5px;
  font-weight: 600;
}

.dp__sev--info {
  background: var(--dsw-alias-bg-layer-3);
  color: var(--dsw-alias-label-tertiary);
}

.dp__sev--warn {
  background: var(--dsw-alias-state-warn-tertiary);
  color: var(--dsw-alias-state-warn-secondary);
}

.dp__sev--block {
  background: var(--dsw-alias-interactive-bg-hover-danger);
  color: var(--dsw-alias-state-error-primary);
}

.dp__familyTag {
  flex: none;
  padding: 1px 6px;
  border-radius: 4px;
  background: var(--dsw-alias-bg-layer-3);
  color: var(--dsw-alias-label-tertiary);
  font-size: 10px;
}

.dp__rule {
  min-width: 0;
  overflow: hidden;
  color: var(--dsw-alias-label-secondary);
  font-family: var(--dsw-font-family-code);
  font-size: 11px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.dp__where {
  color: var(--dsw-alias-label-caption);
  font-size: 11px;
}

.dp__time {
  margin-left: auto;
  color: var(--dsw-alias-label-caption);
  font-size: 11px;
}

.dp__excerpt {
  display: block;
  color: var(--dsw-alias-label-tertiary);
  font-family: var(--dsw-font-family-code);
  font-size: 11px;
  line-height: 16px;
  word-break: break-all;
}

.dp__empty {
  padding: 20px 6px;
  color: var(--dsw-alias-label-caption);
  font-size: 12px;
  line-height: 18px;
  text-align: center;
}

.dp__hint {
  margin: 0 0 8px;
  color: var(--dsw-alias-label-caption);
  font-size: 11.5px;
  line-height: 17px;
}

.dp__input {
  width: 100%;
  box-sizing: border-box;
  padding: 8px 10px;
  border: 0.5px solid var(--dsw-alias-border-l2);
  border-radius: 8px;
  background: var(--dsw-alias-bg-layer-1);
  outline: none;
  color: var(--dsw-alias-label-primary);
  font-family: var(--dsw-font-family-code);
  font-size: 12px;
  line-height: 18px;
  resize: vertical;
}

.dp__input:focus {
  border-color: var(--dsw-alias-border-l3);
}

.dp__probeActions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  margin-top: 8px;
}

.dp__probeResult {
  color: var(--dsw-alias-label-secondary);
  font-size: 11.5px;
}

.dp__probeError {
  color: var(--dsw-alias-state-error-primary);
  font-size: 11.5px;
}

.dp__spacer {
  flex: 1;
}

.dp__footNote {
  color: var(--dsw-alias-label-caption);
}
</style>
