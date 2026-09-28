<script setup lang="ts">
/**
 * Catalog panel: skills (slash commands), subagent types, and model capabilities.
 *
 * All of it comes from the CLI's `initialize` reply, which reports the session's real
 * capabilities — so this panel shows what THIS session can actually do rather than a
 * hardcoded list that drifts from the CLI.
 */
import { computed, ref } from 'vue'
import type { Catalog } from '../types'

const props = defineProps<{
  catalog: Catalog | null
  /** The model the session is currently on, if known. */
  activeModel?: string | null
  /**
   * Whether a session is open. The catalog comes from the CLI's per-session initialize reply, so
   * with no session there is nothing to fetch — and a spinner that never resolves reads as a hang
   * rather than as "nothing is open".
   */
  hasSession?: boolean
}>()

const emit = defineEmits<{
  (e: 'close'): void
}>()

const tab = ref<'skills' | 'agents' | 'models'>('skills')
const query = ref('')

function matches(entry: { name: string; description: string }): boolean {
  const needle = query.value.trim().toLowerCase()
  if (!needle) return true
  return (
    entry.name.toLowerCase().includes(needle) || entry.description.toLowerCase().includes(needle)
  )
}

const skills = computed(() => (props.catalog?.commands ?? []).filter(matches))
const agents = computed(() => (props.catalog?.agents ?? []).filter(matches))
const models = computed(() => props.catalog?.models ?? [])

/** Skills the CLI marks as built in, versus ones discovered on disk. */
const builtinCount = computed(() => (props.catalog?.commands ?? []).filter((c) => c.builtin).length)
</script>

<template>
  <div class="cat">
    <div class="cat__scrim" @click="emit('close')" />

    <div class="cat__panel" role="dialog" aria-label="技能与子代理">
      <header class="cat__head">
        <span class="cat__title">技能与子代理</span>
        <span v-if="catalog?.ready" class="cat__meta">
          {{ catalog.commands.length }} 个技能 · {{ catalog.agents.length }} 个子代理类型
          <template v-if="builtinCount > 0">· {{ builtinCount }} 个内置</template>
        </span>
        <span class="cat__spacer" />
        <button class="iconButton" type="button" title="关闭" @click="emit('close')">
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" />
          </svg>
        </button>
      </header>

      <div class="cat__bar">
        <div class="tabs">
          <button class="tab" :class="{ 'tab--active': tab === 'skills' }" type="button" @click="tab = 'skills'">
            技能 ({{ catalog?.commands.length ?? 0 }})
          </button>
          <button class="tab" :class="{ 'tab--active': tab === 'agents' }" type="button" @click="tab = 'agents'">
            子代理 ({{ catalog?.agents.length ?? 0 }})
          </button>
          <button class="tab" :class="{ 'tab--active': tab === 'models' }" type="button" @click="tab = 'models'">
            模型 ({{ catalog?.models.length ?? 0 }})
          </button>
        </div>
        <input
          v-if="tab !== 'models'"
          v-model="query"
          class="cat__search"
          spellcheck="false"
          placeholder="筛选…"
        />
      </div>

      <div v-if="hasSession === false" class="cat__waiting">
        技能与子代理来自 CLI 的 initialize 握手，需要先打开一个会话。
      </div>

      <div v-else-if="!catalog?.ready" class="cat__waiting">
        <span class="spinner" />
        等待 CLI 的 initialize 握手返回目录…
      </div>

      <div v-else class="cat__body">
        <!-- skills / slash commands -->
        <template v-if="tab === 'skills'">
          <div v-if="skills.length === 0" class="cat__empty">没有匹配的技能</div>
          <div v-for="skill in skills" :key="skill.name" class="cat__row">
            <div class="cat__rowTop">
              <code class="cat__name">/{{ skill.name }}</code>
              <span v-if="skill.builtin" class="cat__tag">内置</span>
              <span v-if="skill.argumentHint" class="cat__hint">{{ skill.argumentHint }}</span>
            </div>
            <p class="cat__desc">{{ skill.description || '（无描述）' }}</p>
          </div>
        </template>

        <!-- subagent types -->
        <template v-else-if="tab === 'agents'">
          <div v-if="agents.length === 0" class="cat__empty">没有匹配的子代理类型</div>
          <div v-for="agent in agents" :key="agent.name" class="cat__row">
            <div class="cat__rowTop">
              <code class="cat__name">{{ agent.name }}</code>
              <span v-if="agent.builtin" class="cat__tag">内置</span>
            </div>
            <p class="cat__desc">{{ agent.description || '（无描述）' }}</p>
          </div>
        </template>

        <!-- models -->
        <template v-else>
          <div v-if="models.length === 0" class="cat__empty">CLI 未报告可用模型</div>
          <div v-for="model in models" :key="model.value" class="cat__row">
            <div class="cat__rowTop">
              <code class="cat__name">{{ model.value }}</code>
              <span v-if="model.value === activeModel" class="cat__tag cat__tag--active">当前</span>
              <span v-if="model.supportsEffort" class="cat__tag">effort</span>
              <span v-if="model.supportsFastMode" class="cat__tag">fast</span>
            </div>
            <p class="cat__desc">{{ model.displayName }}<template v-if="model.resolvedModel"> · {{ model.resolvedModel }}</template></p>
            <p v-if="model.effortLevels.length > 0" class="cat__desc cat__desc--dim">
              推理档位：{{ model.effortLevels.join(' / ') }}
            </p>
          </div>
        </template>
      </div>

      <footer v-if="catalog?.account" class="cat__foot">
        <span>凭据来源 {{ catalog.account.tokenSource ?? '未知' }}</span>
        <span class="statsPills__sep" />
        <span>provider {{ catalog.account.apiProvider ?? '未知' }}</span>
        <template v-if="catalog.permissionMode">
          <span class="statsPills__sep" />
          <span>权限模式 {{ catalog.permissionMode }}</span>
        </template>
      </footer>
    </div>
  </div>
</template>

<style scoped>
.cat {
  position: fixed;
  inset: 0;
  z-index: 50;
  display: grid;
  place-items: center;
  padding: 32px;
}

.cat__scrim {
  position: absolute;
  inset: 0;
  background: rgba(0, 0, 0, 0.5);
}

.cat__panel {
  position: relative;
  display: flex;
  flex-direction: column;
  width: 100%;
  max-width: 760px;
  max-height: 100%;
  border: 0.5px solid var(--dsw-alias-border-l2);
  border-radius: 16px;
  background: var(--dsw-alias-bg-layer-2);
  box-shadow: 0 16px 48px rgba(0, 0, 0, 0.5);
  overflow: hidden;
}

.cat__head {
  display: flex;
  flex: none;
  align-items: center;
  gap: 10px;
  padding: 12px 16px;
  border-bottom: 0.5px solid var(--dsw-alias-border-l1);
}

.cat__title {
  flex: none;
  font-size: 14px;
  font-weight: 600;
}

.cat__meta {
  min-width: 0;
  overflow: hidden;
  color: var(--dsw-alias-label-caption);
  font-size: 11.5px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.cat__spacer {
  flex: 1;
}

.cat__bar {
  display: flex;
  flex: none;
  align-items: center;
  gap: 12px;
  padding: 10px 16px;
}

.cat__search {
  flex: 1;
  min-width: 0;
  max-width: 220px;
  margin-left: auto;
  padding: 6px 10px;
  border: 0.5px solid var(--dsw-alias-border-l2);
  border-radius: 8px;
  background: var(--dsw-static-neutral-bluish-900);
  outline: none;
  color: var(--dsw-alias-label-primary);
  font-size: 12px;
}

.cat__search:focus {
  border-color: var(--dsw-alias-state-business-primary);
}

.cat__body {
  flex: 1;
  min-height: 240px;
  padding: 0 16px 12px;
  overflow-y: auto;
}

.cat__waiting {
  display: flex;
  flex: 1;
  align-items: center;
  justify-content: center;
  gap: 9px;
  min-height: 240px;
  color: var(--dsw-alias-label-caption);
  font-size: 12.5px;
}

.cat__empty {
  padding: 28px 4px;
  color: var(--dsw-alias-label-caption);
  font-size: 12.5px;
  text-align: center;
}

.cat__row {
  padding: 9px 10px;
  border-radius: 8px;
  border-bottom: 0.5px solid var(--dsw-alias-border-l1);
}

.cat__row:hover {
  background: var(--dsw-alias-interactive-bg-hover);
}

.cat__rowTop {
  display: flex;
  align-items: center;
  gap: 7px;
  margin-bottom: 3px;
}

.cat__name {
  color: var(--dsw-alias-label-primary);
  font-family: var(--dsw-font-family-code);
  font-size: 12.5px;
  font-weight: 600;
}

.cat__tag {
  flex: none;
  padding: 1px 6px;
  border-radius: 4px;
  background: var(--dsw-alias-bg-layer-3);
  color: var(--dsw-alias-label-tertiary);
  font-size: 10px;
  font-weight: 500;
}

.cat__tag--active {
  background: var(--dsw-alias-state-success-tertiary);
  color: var(--dsw-alias-state-success-secondary);
}

.cat__hint {
  min-width: 0;
  overflow: hidden;
  color: var(--dsw-alias-label-caption);
  font-family: var(--dsw-font-family-code);
  font-size: 11px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.cat__desc {
  margin: 0;
  color: var(--dsw-alias-label-secondary);
  font-size: 12px;
  line-height: 18px;
}

.cat__desc--dim {
  margin-top: 3px;
  color: var(--dsw-alias-label-caption);
  font-size: 11.5px;
}

.cat__foot {
  display: flex;
  flex: none;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  padding: 9px 16px;
  border-top: 0.5px solid var(--dsw-alias-border-l1);
  color: var(--dsw-alias-label-caption);
  font-size: 11.5px;
}
</style>
