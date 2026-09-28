<script setup lang="ts">
/**
 * Bundled-component inventory.
 *
 * Answers "what did this install bring, and is it working?" — which needs TWO independent
 * facts, because either alone is misleading:
 *
 *   - present: the file shipped (read from disk by the bridge)
 *   - loaded : the CLI reported it for a session (from `system/init`)
 *
 * A component can be present but not loaded, and that gap is the thing worth surfacing. So when
 * a session exists, each entry is cross-checked against the session's own skills/plugins/MCP
 * lists and a mismatch is shown rather than hidden.
 *
 * The "not bundled" list is included on purpose: "why isn't X here" is a recurring question, and
 * the answer is a measured fact about each package rather than a preference.
 */
import { computed, onMounted, ref } from 'vue'
import type { BundledInventory, Catalog } from '../types'
import { useBridge } from '../composables/useBridge'

const props = withDefaults(
  defineProps<{
    catalog: Catalog | null
    /** Names the CLI reported as loaded for the active session, if one is open. */
    loadedSkills?: string[]
    loadedPlugins?: string[]
    loadedMcpServers?: string[]
  }>(),
  { loadedSkills: () => [], loadedPlugins: () => [], loadedMcpServers: () => [] },
)

const bridge = useBridge()
const inventory = ref<BundledInventory | null>(null)
const loading = ref(false)
// The "未内置的插件与原因" list was removed by request. The record itself is kept in the bridge
// (`NOT_BUNDLED` in bundled.mjs) and in the README, because "why isn't X bundled" is a recurring
// question whose answer is a fact about the package rather than an opinion — it just no longer
// needs to occupy a settings page.

onMounted(async () => {
  loading.value = true
  inventory.value = await bridge.refreshBundled()
  loading.value = false
})

/** Is this component reported as loaded by the running session? Null when no session is open. */
function loadedState(component: { loadedAs?: { kind: string; name: string } }): boolean | null {
  const as = component.loadedAs
  if (!as) return null
  const hasSession = props.loadedSkills.length > 0 || props.loadedPlugins.length > 0
  if (!hasSession) return null
  if (as.kind === 'skill') return props.loadedSkills.includes(as.name)
  if (as.kind === 'plugin') return props.loadedPlugins.includes(as.name)
  if (as.kind === 'mcp') return props.loadedMcpServers.includes(as.name)
  return null
}

const KIND_LABEL: Record<string, string> = {
  core: '内核',
  skill: '技能',
  plugin: '插件',
  mcp: 'MCP',
}

/** Everything the CLI loaded that the installer did NOT ship: the CLI's own built-ins. */
const cliBuiltins = computed(() => {
  const shipped = new Set(
    (inventory.value?.bundled ?? [])
      .map((component) => component.loadedAs?.name)
      .filter((name): name is string => Boolean(name)),
  )
  return props.loadedSkills.filter((name) => !shipped.has(name))
})

void loading
</script>

<template>
  <div>
    <h3 class="st__h">内置插件</h3>
    <p class="st__sub">
      本安装包携带的组件，以及它们是否真的被当前会话加载。两者不一致时会标出来 ——
      文件在但没加载，才是需要排查的情况。
    </p>

    <div v-if="!inventory" class="st__hint">正在读取清单…</div>

    <template v-else>
      <!-- shipped components -->
      <div class="st__field">
        <label class="st__label">随包携带（{{ inventory.bundled.length }}）</label>
        <div class="inv">
          <div v-for="component in inventory.bundled" :key="component.id" class="inv__row">
            <div class="inv__top">
              <span class="inv__name">{{ component.name }}</span>
              <span class="inv__kind">{{ KIND_LABEL[component.kind] ?? component.kind }}</span>
              <span class="inv__version">{{ component.version }}</span>

              <span class="inv__spacer" />

              <!-- presence: read from disk -->
              <span
                class="inv__badge"
                :class="component.present ? 'inv__badge--ok' : 'inv__badge--bad'"
                :title="component.absolutePath ?? ''"
              >
                {{ component.present === null ? '路径未知' : component.present ? '文件在位' : '文件缺失' }}
              </span>

              <!-- loaded: reported by the CLI, only knowable with a session open -->
              <span
                v-if="loadedState(component) !== null"
                class="inv__badge"
                :class="loadedState(component) ? 'inv__badge--ok' : 'inv__badge--warn'"
              >
                {{ loadedState(component) ? '已加载' : '未加载' }}
              </span>
              <span v-else class="inv__badge inv__badge--dim" title="打开一个会话后才能核对加载状态">
                待核对
              </span>
            </div>

            <p class="inv__summary">{{ component.summary }}</p>

            <div class="inv__meta">
              <code v-if="component.package">{{ component.package }}</code>
              <span v-if="component.license">{{ component.license }}</span>
              <span v-if="component.author">{{ component.author }}</span>
              <a v-if="component.homepage" :href="component.homepage" target="_blank" rel="noreferrer">
                主页
              </a>
            </div>

            <p v-if="component.setupHint" class="inv__hint">{{ component.setupHint }}</p>
            <p v-if="component.absolutePath" class="inv__path">{{ component.absolutePath }}</p>
          </div>
        </div>
      </div>

      <!-- CLI built-ins, so the inventory is not silently partial -->
      <div v-if="cliBuiltins.length > 0" class="st__field">
        <label class="st__label">CLI 自带（{{ cliBuiltins.length }}）</label>
        <p class="st__hint" style="margin-top: 0">
          来自 claude.exe 自身，不是本安装包携带的：
        </p>
        <div class="inv__chips">
          <span v-for="name in cliBuiltins" :key="name" class="inv__chip">{{ name }}</span>
        </div>
      </div>

      <div v-if="inventory.sidecarRoot" class="st__field">
        <label class="st__label">组件根目录</label>
        <p class="inv__path" style="margin-top: 0">{{ inventory.sidecarRoot }}</p>
      </div>
    </template>
  </div>
</template>

<style scoped>
.inv {
  display: grid;
  gap: 8px;
}

.inv__row {
  padding: 10px 12px;
  border: 0.5px solid var(--dsw-alias-border-l1);
  border-radius: 10px;
  background: var(--dsw-alias-bg-layer-1);
}

.inv__top {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 7px;
}

.inv__name {
  font-size: 12.5px;
  font-weight: 600;
}

.inv__kind,
.inv__version {
  flex: none;
  padding: 1px 6px;
  border-radius: 4px;
  background: var(--dsw-alias-bg-layer-3);
  color: var(--dsw-alias-label-tertiary);
  font-size: 10px;
}

.inv__version {
  font-family: var(--dsw-font-family-code);
}

.inv__spacer {
  flex: 1;
  min-width: 8px;
}

.inv__badge {
  flex: none;
  padding: 1px 7px;
  border-radius: 5px;
  font-size: 10.5px;
  font-weight: 600;
}

.inv__badge--ok {
  background: var(--dsw-alias-state-success-tertiary);
  color: var(--dsw-alias-state-success-secondary);
}

.inv__badge--bad {
  background: var(--dsw-alias-interactive-bg-hover-danger);
  color: var(--dsw-alias-state-error-primary);
}

.inv__badge--warn {
  background: var(--dsw-alias-state-warn-tertiary);
  color: var(--dsw-alias-state-warn-secondary);
}

.inv__badge--dim {
  background: var(--dsw-alias-bg-layer-2);
  color: var(--dsw-alias-label-caption);
}

.inv__summary {
  margin: 5px 0 0;
  color: var(--dsw-alias-label-secondary);
  font-size: 12px;
  line-height: 18px;
}

.inv__meta {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  margin-top: 5px;
  color: var(--dsw-alias-label-caption);
  font-size: 11px;
}

.inv__meta code {
  font-family: var(--dsw-font-family-code);
}

.inv__hint {
  margin: 5px 0 0;
  color: var(--dsw-alias-label-caption);
  font-size: 11.5px;
  line-height: 17px;
}

.inv__path {
  margin: 5px 0 0;
  overflow: hidden;
  color: var(--dsw-alias-label-caption);
  font-family: var(--dsw-font-family-code);
  font-size: 10.5px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.inv__chips {
  display: flex;
  flex-wrap: wrap;
  gap: 5px;
  margin-top: 6px;
}

.inv__chip {
  padding: 2px 8px;
  border: 0.5px solid var(--dsw-alias-border-l1);
  border-radius: 999px;
  background: var(--dsw-alias-bg-layer-1);
  color: var(--dsw-alias-label-tertiary);
  font-family: var(--dsw-font-family-code);
  font-size: 10.5px;
}
</style>
