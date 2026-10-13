<script setup lang="ts">
/**
 * 插件管理 — the window the menu bar opens, and the hub for every built-in plugin feature.
 *
 * WHY IT IS BOTH A LIST AND A LAUNCHER: the reference app's window is read-only on purpose (every
 * plugin arrives with the release, so an install button could only move the profile away from the
 * set the build was verified with — and a plugin that fails to compose takes the whole app down).
 * That argument still holds here, so nothing installs from this window. What it CAN do is open the
 * feature a plugin was built in for, which is the thing a user actually wanted when they clicked
 * the row.
 *
 * The badge is not decoration: `port.kind` distinguishes a package we SHIP (`vendored`) from a
 * capability we WROTE (`native`), and the endpoint + evidence path under each row are what make
 * that claim checkable instead of marketing.
 */
import { computed, onMounted, ref } from 'vue'
import ShellDialog from './ShellDialog.vue'
import MemoryPanel from './MemoryPanel.vue'
import VisionPanel from './VisionPanel.vue'
import TimeMachinePanel from './TimeMachinePanel.vue'
import GitPanel from './GitPanel.vue'
import DefendPanel from './DefendPanel.vue'
import RulesPanel from './RulesPanel.vue'
import ContextPanel from './ContextPanel.vue'
import CostPanel from './CostPanel.vue'
import { shellGet } from '../composables/useShellApi'
import type { BridgeEvent, PricedTimeline, SessionView } from '../types'

interface PluginPort {
  kind: 'vendored' | 'native'
  detail: string
  evidence: string
  endpoint: string
  feature: string
}

interface PluginRow {
  id: string
  name: string
  version: string
  vendoredVersion: string | null
  bundled: boolean
  summary: string
  port: PluginPort
}

const props = defineProps<{
  /** Panels that act on a workspace need one; absent simply disables those rows. */
  cwd?: string | null
  sessionId?: string | null
  sessionEvents?: BridgeEvent[]
  sessions?: SessionView[]
  sessionCost?: PricedTimeline | null
  modelContext?: { window?: number; model?: string } | null
}>()

const emit = defineEmits<{
  (e: 'close'): void
  (e: 'open-settings', section: string): void
  (e: 'select-session', id: string): void
}>()

const plugins = ref<PluginRow[]>([])
const loading = ref(true)
const error = ref<string | null>(null)
const expanded = ref<string | null>(null)
/** Which feature window is on top of this one, if any. */
const openFeature = ref<string | null>(null)

const PORT_LABEL: Record<string, string> = { vendored: '内置包', native: '自建实现' }

async function load() {
  loading.value = true
  error.value = null
  try {
    const answer = await shellGet<{ plugins: PluginRow[] }>('/api/plugins')
    plugins.value = answer.plugins
  } catch (problem) {
    error.value = problem instanceof Error ? problem.message : String(problem)
  } finally {
    loading.value = false
  }
}

/** Features that live in the settings window rather than in a panel of their own. */
function settingsSectionFor(feature: string): string | null {
  if (feature === 'audit') return 'audit'
  if (feature === 'import') return 'import'
  return null
}

const FEATURE_PANELS = {
  memory: MemoryPanel,
  vision: VisionPanel,
  'time-machine': TimeMachinePanel,
  git: GitPanel,
  defend: DefendPanel,
  rules: RulesPanel,
  context: ContextPanel,
  cost: CostPanel,
} as const

type FeatureKey = keyof typeof FEATURE_PANELS

const activePanel = computed(() => {
  const key = openFeature.value as FeatureKey | null
  return key && key in FEATURE_PANELS ? FEATURE_PANELS[key] : null
})

function openPlugin(row: PluginRow) {
  const section = settingsSectionFor(row.port.feature)
  if (section) {
    emit('open-settings', section)
    return
  }
  if (row.port.feature in FEATURE_PANELS) openFeature.value = row.port.feature
}

/** Rows that cannot run without a workspace say so up front rather than failing after a click. */
const NEEDS_WORKSPACE = new Set(['memory', 'time-machine', 'git'])
function disabledReason(row: PluginRow): string | null {
  if (NEEDS_WORKSPACE.has(row.port.feature) && !props.cwd) return '需要先打开一个工作目录'
  if (row.port.feature === 'context' && !props.sessionId) return '需要先打开一个会话'
  return null
}

/**
 * The context window wants the currency amount, not the whole priced timeline.
 *
 * Mapped here rather than widened in that panel: `PricedTimeline` carries per-model breakdowns the
 * window never shows, and handing it over whole would invite a second, subtly different reading of
 * the same numbers — the exact way two cost displays end up disagreeing.
 */
const contextCost = computed(() =>
  props.sessionCost
    ? { cost: props.sessionCost.totalCny, currency: 'CNY', usesTimeOfDay: props.sessionCost.usesTimeOfDay }
    : null,
)

onMounted(load)
</script>

<template>
  <ShellDialog title="插件管理" :meta="`已内置 ${plugins.length} 个插件的能力`" :width="820" @close="emit('close')">
    <template #actions>
      <button class="btnGhost" type="button" :disabled="loading" @click="load">
        {{ loading ? '读取中…' : '刷新' }}
      </button>
    </template>

    <p class="pm__lead">
      这一版把这些插件的能力直接做进了客户端，随安装包一起发布：不需要联网安装，也不存在版本漂移。
      每一条都写明是「内置包」还是「自建实现」，以及可核对的入口。
    </p>

    <div v-if="error" class="pm__error">{{ error }}</div>
    <div v-else-if="loading && plugins.length === 0" class="pm__waiting"><span class="spinner" />正在读取内置清单…</div>

    <ul v-else class="pm__list">
      <li v-for="row in plugins" :key="row.id" class="pm__item" :class="{ 'pm__item--open': expanded === row.id }">
        <button class="pm__row" type="button" @click="expanded = expanded === row.id ? null : row.id">
          <span class="pm__identity">
            <span class="pm__name">{{ row.name }}</span>
            <span class="pm__version">{{ row.version }}</span>
            <span v-if="row.vendoredVersion" class="pm__vendored">随包 {{ row.vendoredVersion }}</span>
          </span>
          <span class="pm__actions">
            <span class="pm__kind">{{ PORT_LABEL[row.port.kind] ?? row.port.kind }}</span>
            <span class="pm__badge" :title="row.port.detail">内置</span>
          </span>
        </button>

        <div v-if="expanded === row.id" class="pm__detail">
          <p class="pm__summary">{{ row.summary }}</p>
          <p class="pm__port">{{ row.port.detail }}</p>
          <div class="pm__meta">
            <code>{{ row.port.endpoint }}</code>
            <code>{{ row.port.evidence }}</code>
          </div>
          <div class="pm__cta">
            <button class="btnPrimary" type="button" :disabled="disabledReason(row) !== null" @click="openPlugin(row)">
              打开功能
            </button>
            <span v-if="disabledReason(row)" class="pm__hint">{{ disabledReason(row) }}</span>
          </div>
        </div>
      </li>
    </ul>

    <template #footer>
      <span>全部插件随构建发布：安装、卸载、换版本都不开放，避免把已验证的组合改掉。</span>
    </template>
  </ShellDialog>

  <!-- Feature windows render above this one, each owning its own data. -->
  <MemoryPanel v-if="openFeature === 'memory'" :cwd="cwd ?? null" @close="openFeature = null" />
  <VisionPanel v-else-if="openFeature === 'vision'" :cwd="cwd ?? null" @close="openFeature = null" />
  <TimeMachinePanel v-else-if="openFeature === 'time-machine'" :cwd="cwd ?? null" @close="openFeature = null" />
  <GitPanel v-else-if="openFeature === 'git'" :cwd="cwd ?? null" @close="openFeature = null" />
  <DefendPanel v-else-if="openFeature === 'defend'" @close="openFeature = null" />
  <RulesPanel v-else-if="openFeature === 'rules'" @close="openFeature = null" />
  <ContextPanel
    v-else-if="openFeature === 'context'"
    :events="sessionEvents ?? []"
    :cost="contextCost"
    :session-id="sessionId ?? null"
    :model-context="modelContext ?? null"
    @close="openFeature = null"
  />
  <CostPanel
    v-else-if="openFeature === 'cost'"
    :sessions="sessions ?? []"
    :active-id="sessionId ?? null"
    @close="openFeature = null"
    @select="(id: string) => emit('select-session', id)"
  />
</template>

<style scoped>
.pm__lead {
  margin: 0 0 12px;
  color: var(--dsw-alias-label-secondary);
  font-size: 12px;
  line-height: 19px;
}

.pm__waiting {
  display: flex;
  align-items: center;
  gap: 9px;
  padding: 26px 4px;
  color: var(--dsw-alias-label-caption);
  font-size: 12.5px;
}

.pm__error {
  padding: 10px 12px;
  border: 0.5px solid var(--dsw-alias-state-error-primary);
  border-radius: 8px;
  background: var(--dsw-alias-interactive-bg-hover-danger);
  color: var(--dsw-alias-state-error-primary);
  font-size: 12px;
}

.pm__list {
  margin: 0;
  padding: 0;
  list-style: none;
}

.pm__item {
  border-bottom: 0.5px solid var(--dsw-alias-border-l1);
}

.pm__item--open {
  background: var(--dsw-alias-bg-layer-1);
  border-radius: 8px;
}

.pm__row {
  display: flex;
  width: 100%;
  align-items: center;
  gap: 10px;
  padding: 11px 6px;
  text-align: left;
}

.pm__identity {
  display: flex;
  min-width: 0;
  align-items: baseline;
  gap: 8px;
}

.pm__name {
  font-size: 13px;
  font-weight: 500;
}

.pm__version {
  color: var(--dsw-alias-label-tertiary);
  font-family: var(--dsw-font-family-code);
  font-size: 11.5px;
}

.pm__vendored {
  padding: 1px 6px;
  border-radius: 4px;
  background: var(--dsw-alias-bg-layer-3);
  color: var(--dsw-alias-label-caption);
  font-size: 10px;
}

.pm__actions {
  display: flex;
  flex: none;
  align-items: center;
  gap: 8px;
  margin-left: auto;
}

.pm__kind {
  color: var(--dsw-alias-label-caption);
  font-size: 10.5px;
}

.pm__badge {
  padding: 2px 10px;
  border: 0.5px solid var(--dsw-alias-border-l2);
  border-radius: 999px;
  color: var(--dsw-alias-label-tertiary);
  font-size: 10.5px;
}

.pm__detail {
  padding: 2px 8px 14px;
}

.pm__summary {
  margin: 0;
  color: var(--dsw-alias-label-secondary);
  font-size: 12px;
  line-height: 18px;
}

.pm__port {
  margin: 5px 0 0;
  color: var(--dsw-alias-label-tertiary);
  font-size: 11.5px;
  line-height: 18px;
}

.pm__meta {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  margin-top: 6px;
  color: var(--dsw-alias-label-caption);
  font-family: var(--dsw-font-family-code);
  font-size: 10.5px;
}

.pm__cta {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-top: 10px;
}

.pm__hint {
  color: var(--dsw-alias-label-caption);
  font-size: 11px;
}
</style>
