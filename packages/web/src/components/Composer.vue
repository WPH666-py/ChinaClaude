<script setup lang="ts">
/**
 * Composer.
 *
 * Geometry follows the upstream input card: a 22px capsule holding an auto-growing draft area
 * and a toolbar row with the attach control and mode chips on the left, the model trigger and
 * the 34px send circle on the right.
 *
 * The permission and model triggers are real popup selects. The permission list is the
 * Harness-style preset set (仅可查看 / 需逐步审批 / 工作区内修改 / 完全权限), each mapped to the
 * CLI mode it actually selects; picking one switches the RUNNING session through the control
 * channel rather than waiting for a relaunch.
 *
 * Enter sends, Shift+Enter inserts a newline. While a turn runs the send circle becomes a stop
 * control, which is the only way to interrupt the child CLI from the UI.
 */
import { computed, nextTick, ref, watch } from 'vue'
import type { CatalogModel } from '../types'
import { useSettings, PERMISSION_PRESETS } from '../composables/useSettings'
import { useBridge } from '../composables/useBridge'

const props = defineProps<{
  disabled: boolean
  /** A turn is in flight (running, awaiting approval, or awaiting a dialog). */
  busy: boolean
  /** True specifically while the CLI is parked on an approval ask. */
  awaitingApproval: boolean
  /** True specifically while the CLI is parked on a host dialog. */
  awaitingDialog: boolean
  model: string
  permissionMode: string
  /** Models the CLI reported for this session. */
  catalogModels?: CatalogModel[]
  /** What the CLI says it is actually running, when no explicit model was chosen. */
  resolvedModel?: string | null
  /**
   * Whether this session holds an endpoint and a credential.
   *
   * Passed in rather than derived from the provider list, because that list is NOT what authorises a
   * call — the child process's environment is, captured when the session started, and deleting a
   * provider afterwards cannot revoke it. "Not in the list" and "cannot call" are therefore different
   * states and the UI must be able to tell them apart.
   */
  hasCredentials?: boolean
}>()

const emit = defineEmits<{
  (e: 'send', text: string): void
  (e: 'stop'): void
  /** `ref` is "providerId::model"; an empty value means "follow the provider default". */
  (e: 'change-model', ref: string): void
  (e: 'change-mode', mode: string): void
  (e: 'open-settings'): void
}>()

const store = useSettings()
const bridge = useBridge()
const text = ref('')
const box = ref<HTMLTextAreaElement | null>(null)
const fileInput = ref<HTMLInputElement | null>(null)
const attaching = ref(false)
/** Why the last attach attempt failed, shown inline so a click never fails silently. */
const attachError = ref<string | null>(null)
const openMenu = ref<'mode' | 'model' | null>(null)

/** Read one File as a data URL; the bridge turns it back into bytes on disk. */
function readAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result ?? ''))
    reader.onerror = () => reject(new Error(`读取 ${file.name} 失败`))
    reader.readAsDataURL(file)
  })
}

/**
 * Store the picked files and append their paths to the draft.
 *
 * The PATH is what gets inserted, not the file content: Claude Code reads files by path, and a
 * pasted blob would be re-sent on every turn.
 */
async function onFilesPicked(event: Event) {
  const input = event.target as HTMLInputElement
  const files = Array.from(input.files ?? [])
  // Reset immediately so picking the SAME file twice still fires a change event.
  input.value = ''
  if (files.length === 0) return

  attaching.value = true
  attachError.value = null
  try {
    const payload = await Promise.all(files.map(async (file) => ({ name: file.name, dataUrl: await readAsDataUrl(file) })))
    const result = await bridge.saveAttachments(payload)
    const landed = (result.results ?? []).filter((entry) => entry.ok)
    const failed = (result.results ?? []).filter((entry) => !entry.ok)

    if (landed.length > 0) {
      const lines = landed.map((entry) => entry.path)
      text.value = text.value.trim().length > 0 ? `${text.value.replace(/\s+$/, '')}\n${lines.join('\n')}` : lines.join('\n')
      nextTick(() => {
        autoGrow()
        box.value?.focus()
      })
    }
    if (failed.length > 0) {
      attachError.value = failed.map((entry) => `${entry.name}：${entry.error}`).join('；')
    }
  } catch (error) {
    attachError.value = String((error as Error).message ?? error)
  } finally {
    attaching.value = false
  }
}

const canSend = computed(() => !props.disabled && !props.busy && text.value.trim().length > 0)

/** The preset matching the session's CURRENT mode, for the trigger label. */
const currentPreset = computed(() => {
  const mode = props.permissionMode || store.activePreset().mode
  return PERMISSION_PRESETS.find((preset) => preset.mode === mode) ?? null
})

const modeLabel = computed(() => currentPreset.value?.label ?? props.permissionMode ?? '权限模式')

/**
 * Every selectable model, as a (provider, model) pair.
 *
 * The CLI's own list is deliberately NOT the primary source: those are Anthropic model names,
 * and against a relay endpoint they are answered by server-side mapping rather than being a real
 * choice. It only appears when the user opts in from settings.
 */
const modelOptions = computed(() => store.modelOptions())

/** The option matching what this session is actually running, if we can identify it. */
const currentOption = computed(() => {
  if (!props.model) return null
  return modelOptions.value.find((option) => option.model === props.model) ?? null
})

/**
 * The trigger label.
 *
 * When the session runs a model that no configured provider owns, the label must say WHICH kind of
 * "not configured" this is, because the two behave differently and the old wording conflated them:
 *
 *   - the session HAS credentials (it was started while a provider existed, or through the manual
 *     endpoint form) -> it still works, because the endpoint decides, not this local list. Saying
 *     "未配置" there was actively misleading: the user watched it work and concluded the app was
 *     broken.
 *   - the session has NO credentials -> a call really will fail.
 *
 * So the first case is named as "不在清单中" — a claim about the catalog — and impossibility is only
 * asserted when there is genuinely nothing to call with.
 */
const modelLabel = computed(() => {
  if (props.model) {
    if (currentOption.value) return `${props.model} · ${currentOption.value.providerName}`
    return props.hasCredentials ? `${props.model} · 不在清单中` : `${props.model} · 无凭据`
  }
  const provider = store.defaultProvider()
  return provider ? `${provider.name} 默认` : ''
})

/**
 * Whether a model can be chosen at all.
 *
 * With no configured provider there is nothing a choice could mean, so the trigger is hidden
 * rather than shown as "未配置": an empty selector that explains nothing is worse than an absent
 * one, and the model name the CLI happens to be running is Anthropic's, not the user's.
 */
const hasConfiguredModels = computed(() => modelOptions.value.length > 0)

/** True when the session runs a model no configured provider owns (a stale reference). */
const modelUnconfigured = computed(
  () => hasConfiguredModels.value && Boolean(props.model) && !currentOption.value,
)

/**
 * The same condition WITHOUT the "models are configured" guard.
 *
 * The fallback chip (shown when the catalog is empty) used to read "未配置模型" unconditionally, which
 * was wrong for a session that has a model and is callable: it described the empty catalog as though
 * it were a property of the session. This lets that branch name the model it is actually running.
 */
const modelUnlisted = computed(() => Boolean(props.model) && !currentOption.value)

/** Names the default provider so "reset" says where the model will come from. */
const defaultProviderLabel = computed(() => {
  const provider = store.defaultProvider()
  return provider ? `${provider.name} 默认模型` : '默认模型'
})

const placeholder = computed(() => {
  if (props.disabled) return '请先新建会话'
  if (props.awaitingApproval) return '等待你授权后才能继续…'
  if (props.awaitingDialog) return '等待你在上方做出选择…'
  if (props.busy) return '正在执行，可随时中断…'
  return '描述你的任务，Enter 发送，Shift+Enter 换行'
})

function autoGrow() {
  const element = box.value
  if (!element) return
  element.style.height = 'auto'
  element.style.height = `${Math.min(element.scrollHeight, 200)}px`
}

function submit() {
  if (!canSend.value) return
  emit('send', text.value.trim())
  text.value = ''
  requestAnimationFrame(autoGrow)
}

/** Ctrl+Enter sends when the Enter-to-send preference is off. */
function onKeydown(event: KeyboardEvent) {
  if (event.key !== 'Enter') return
  const enterSends = store.settings.value.sendOnEnter ? !event.shiftKey : event.ctrlKey || event.metaKey
  if (!enterSends) return
  event.preventDefault()
  submit()
}

function focus() {
  box.value?.focus()
}

defineExpose({ focus })

function pickMode(mode: string) {
  openMenu.value = null
  emit('change-mode', mode)
}

function pickModel(ref: string) {
  openMenu.value = null
  emit('change-model', ref)
}

// Close a popup when the pointer goes down anywhere else. Capture phase so it also closes
// when the click lands on a button that would otherwise reopen the menu.
function onDocPointerDown(event: PointerEvent) {
  const target = event.target as HTMLElement | null
  if (target?.closest('[data-popup]')) return
  openMenu.value = null
}

watch(openMenu, (value) => {
  if (value) document.addEventListener('pointerdown', onDocPointerDown, true)
  else document.removeEventListener('pointerdown', onDocPointerDown, true)
})
</script>

<template>
  <div class="composer">
    <div class="composer__card">
      <div class="composer__scroll">
        <textarea
          ref="box"
          v-model="text"
          class="composer__input"
          rows="1"
          spellcheck="false"
          :placeholder="placeholder"
          @input="autoGrow"
          @keydown="onKeydown"
        />
      </div>

      <div class="composer__row">
        <!--
          A failed attach must say so. The button used to be disabled placeholders; silently doing
          nothing after a click is the same failure in a different costume.
        -->
        <div v-if="attachError" class="composer__attachError">
          <span>附件保存失败：{{ attachError }}</span>
          <button type="button" class="composer__attachDismiss" @click="attachError = null">关闭</button>
        </div>
        <div class="composer__tools">
          <!--
            Attach files. This was a disabled placeholder labelled "暂未实现" for a long time, which
            is worse than absent: it invites a click and then refuses. It now stores the bytes via
            the bridge and appends the resulting PATH, because Claude Code reads files by path.
          -->
          <input
            ref="fileInput"
            class="composer__file"
            type="file"
            multiple
            @change="onFilesPicked"
          />
          <button
            class="composer__add"
            type="button"
            :disabled="disabled || attaching"
            :title="attaching ? '正在保存附件…' : '添加文件（将以路径插入输入框）'"
            @click="fileInput?.click()"
          >
            <svg v-if="!attaching" width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <path d="M8 3.5v9M3.5 8h9" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" />
            </svg>
            <span v-else class="composer__spinner" />
          </button>

          <!-- permission preset -->
          <div class="pop" data-popup>
            <button class="composer__select" type="button" :disabled="disabled" @click="openMenu = openMenu === 'mode' ? null : 'mode'">
              <span>{{ modeLabel }}</span>
              <span class="reason__caret" />
            </button>

            <div v-if="openMenu === 'mode'" class="pop__menu">
              <button
                v-for="preset in PERMISSION_PRESETS"
                :key="preset.id"
                class="pop__item"
                :class="{ 'pop__item--on': currentPreset?.id === preset.id, 'pop__item--danger': preset.dangerous }"
                type="button"
                @click="pickMode(preset.mode)"
              >
                <span class="pop__itemLabel">{{ preset.label }}</span>
                <code class="pop__itemMode">{{ preset.mode }}</code>
                <span class="pop__itemDesc">{{ preset.description }}</span>
              </button>
              <button class="pop__foot" type="button" @click="openMenu = null; emit('open-settings')">
                在设置里管理权限…
              </button>
            </div>
          </div>
        </div>

        <div class="composer__trailing">
          <!-- model: only offered once a provider exists, otherwise there is nothing to choose -->
          <div v-if="hasConfiguredModels" class="pop" data-popup>
            <button class="composer__select" type="button" :disabled="disabled" @click="openMenu = openMenu === 'model' ? null : 'model'">
              <span v-if="modelUnconfigured" class="composer__warn" title="该模型不属于任何已配置的服务商">
                !
              </span>
              <span>{{ modelLabel }}</span>
              <span class="reason__caret" />
            </button>

            <div v-if="openMenu === 'model'" class="pop__menu pop__menu--right">
              <button
                class="pop__item"
                :class="{ 'pop__item--on': !model }"
                type="button"
                @click="pickModel('')"
              >
                <span class="pop__itemLabel">{{ defaultProviderLabel }}</span>
                <span class="pop__itemDesc">由默认服务商决定具体模型</span>
              </button>

              <button
                v-for="option in modelOptions"
                :key="option.ref"
                class="pop__item"
                :class="{ 'pop__item--on': model === option.model }"
                type="button"
                @click="pickModel(option.ref)"
              >
                <span class="pop__itemLabel">{{ option.label }}</span>
                <!-- The provider is shown because a bare model name does not identify an endpoint. -->
                <span class="pop__itemMode">{{ option.providerName }}</span>
                <span v-if="option.model !== option.label" class="pop__itemDesc">{{ option.model }}</span>
              </button>

              <button class="pop__foot" type="button" @click="openMenu = null; emit('open-settings')">
                在设置里管理服务商与模型…
              </button>
            </div>
          </div>
          <button v-else class="composer__select composer__select--link" type="button" @click="emit('open-settings')">
            <!--
              Name the running model when there is one. "未配置模型" is only true when the session
              genuinely has no model; with a model present it claimed a problem the session does not
              have (it is callable — the endpoint decides, not this list).
            -->
            <span v-if="modelUnlisted" class="composer__warn" title="该模型不在已配置的服务商清单里；会话仍使用启动时的端点">
              !
            </span>
            <span>{{ modelLabel || '未配置模型' }}</span>
            <span class="composer__selectHint">去设置</span>
          </button>

          <button v-if="busy" class="composer__stop" type="button" @click="$emit('stop')">
            <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
              <rect x="2" y="2" width="8" height="8" rx="1.5" fill="currentColor" />
            </svg>
            中断
          </button>
          <button v-else class="composer__send" type="button" :disabled="!canSend" title="发送" @click="submit">
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <path d="M8 12.5v-9M8 3.5L4.5 7M8 3.5L11.5 7" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" />
            </svg>
          </button>
        </div>
      </div>
    </div>

    <div class="composer__hint">
      <template v-if="awaitingApproval">等待你在上方授权，授权后会自动继续</template>
      <template v-else-if="awaitingDialog">等待你在上方做出选择</template>
      <template v-else>工具执行会真实读写文件与运行命令，请在受控目录内使用</template>
    </div>
  </div>
</template>

<style scoped>
.pop {
  position: relative;
  display: inline-flex;
}

.pop__menu {
  position: absolute;
  bottom: calc(100% + 8px);
  left: 0;
  z-index: 30;
  min-width: 300px;
  max-width: 340px;
  padding: 5px;
  border: 0.5px solid var(--dsw-alias-border-l2);
  border-radius: 12px;
  background: var(--dsw-specific-menu);
  box-shadow: 0 12px 32px rgba(0, 0, 0, 0.5);
}

.pop__menu--right {
  left: auto;
  right: 0;
  min-width: 240px;
}

.pop__item {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  gap: 2px 8px;
  width: 100%;
  padding: 8px 10px;
  border-radius: 8px;
  text-align: left;
}

.pop__item:hover {
  background: var(--dsw-alias-interactive-bg-hover);
}

.pop__item--on {
  background: var(--dsw-alias-interactive-bg-active);
}

.pop__itemLabel {
  font-size: 12.5px;
  font-weight: 500;
}

.pop__item--danger .pop__itemLabel {
  color: var(--dsw-alias-state-error-primary);
}

.pop__itemMode {
  color: var(--dsw-alias-label-caption);
  font-family: var(--dsw-font-family-code);
  font-size: 10.5px;
}

.pop__itemDesc {
  grid-column: 1 / -1;
  color: var(--dsw-alias-label-tertiary);
  font-size: 11.5px;
  line-height: 16px;
}

.pop__empty {
  padding: 12px 10px;
  color: var(--dsw-alias-label-caption);
  font-size: 12px;
}

.pop__foot {
  width: 100%;
  margin-top: 4px;
  padding: 7px 10px;
  border-top: 0.5px solid var(--dsw-alias-border-l1);
  color: var(--dsw-alias-link);
  font-size: 11.5px;
  text-align: left;
}

/* Warn mark on the model trigger when the running model belongs to no configured provider. */
.composer__warn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: none;
  width: 13px;
  height: 13px;
  border-radius: 50%;
  background: var(--dsw-alias-state-warn-primary);
  color: #1a1a1a;
  font-size: 9px;
  font-weight: 700;
  line-height: 1;
}
</style>
