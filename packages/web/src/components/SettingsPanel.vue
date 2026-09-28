<script setup lang="ts">
/**
 * Settings.
 *
 * Structure follows the Harness settings page: a left section rail with general / permission /
 * models, and a scrolling body on the right.
 *
 * Nothing here stores an API key. A key is supplied per session and lives only in the bridge's
 * child process, so this page can never leak one.
 */
import { computed, ref } from 'vue'
import type { Catalog, TranscriptSummary } from '../types'
import { useSettings, PERMISSION_PRESETS, PERMISSION_CONFIRM, EFFORT_LEVELS } from '../composables/useSettings'
import type { Bridge } from '../composables/useBridge'
import BundledPanel from './BundledPanel.vue'
import ImportPanel from './ImportPanel.vue'
import AuditPanel from './AuditPanel.vue'

const props = defineProps<{
  catalog: Catalog | null
  /** The UI's bridge handle, passed to the panels that fetch their own data. */
  bridge: Bridge
  /** Directory the audit panel starts on, e.g. the active session's workspace. */
  auditSuggestedPath?: string | null
  /** The model the running session is on, for the model picker's "current" marker. */
  activeModel?: string | null
  /** The RUNNING session's actual permission mode, which may differ from the default preset. */
  sessionPermissionMode?: string | null
  /** Session count, so the permission note can say whether it affects running sessions. */
  sessionCount?: number
  /**
   * What the CLI reported as loaded for the active session. Passed in rather than derived here,
   * because the inventory's job is to compare the bundle against the runtime.
   */
  loadedSkills?: string[]
  loadedPlugins?: string[]
  loadedMcpServers?: string[]
}>()

const emit = defineEmits<{
  (e: 'close'): void
  /** Ask the shell to switch the RUNNING session's permission mode. */
  (e: 'apply-mode', mode: string): void
  /** Close the panel and open the new-session form, for the no-session case. */
  (e: 'new-session'): void
  /** Reopen a past conversation from disk as a live, resumable session. */
  (e: 'open-transcript', transcript: TranscriptSummary): void
}>()

const store = useSettings()
const { DEFAULT_BASE_URL } = store

/**
 * Whether there is a session for "apply to current session" to act on.
 *
 * Without this the button looked live and did nothing when clicked, which is the worst possible
 * outcome: a silent no-op reads as a broken app rather than as "no session is selected".
 */
const hasActiveSession = computed(() => Boolean(props.sessionPermissionMode !== null && props.sessionPermissionMode !== undefined))
const section = ref<'general' | 'permission' | 'models' | 'pricing' | 'bundled' | 'import' | 'audit' | 'about'>('general')

/**
 * Which configured provider a rate row appears to describe, for a "prefilled from X" hint.
 *
 * A hint only — nothing here enforces a link between a row and a provider, because a user may
 * legitimately price several providers with one catch-all row.
 */
function providerForTable(table: { match: string }) {
  const needle = table.match.trim().toLowerCase()
  if (!needle) return null
  const provider = store.settings.value.providers.find((entry) =>
    entry.models.some((model) => model.model.toLowerCase().includes(needle)),
  )
  return provider?.name ?? null
}

/**
 * A read-only summary of what the pricer will actually use.
 *
 * The built-in table and the user's rows are shown together because that is the order they are
 * consulted in: a custom row silently overriding DeepSeek's numbers is the single most surprising
 * thing this feature can do, so it is stated rather than left to be discovered.
 */
const activeRateSummary = computed(() => {
  const rows: Array<{ name: string; detail: string }> = [
    { name: 'DeepSeek（内置）', detail: 'deepseek-flash / deepseek-v4-pro，分高峰与空闲两档' },
  ]
  for (const table of store.settings.value.priceTables) {
    const peak = table.peakMultiplier && table.peakMultiplier > 1 ? `，高峰 ×${table.peakMultiplier}` : '，全天同价'
    rows.push({
      name: `${table.label || table.match || '(未命名)'}（自定义）`,
      detail: `匹配 “${table.match || '*'}”：输入 ${table.cacheMiss} / 缓存 ${table.cacheHit} / 输出 ${table.output} 元每百万${peak}`,
    })
  }
  return rows
})

// Development affordance: `?settings=permission|models|bundled|import|audit|about` opens straight to
// a section, so each page is reachable in a headless screenshot without clicking through the rail.
const requestedSection = new URLSearchParams(location.search).get('settings')
if (
  requestedSection === 'permission' ||
  requestedSection === 'models' ||
  requestedSection === 'pricing' ||
  requestedSection === 'bundled' ||
  requestedSection === 'import' ||
  requestedSection === 'audit' ||
  requestedSection === 'about'
) {
  section.value = requestedSection
}

// --- permission -------------------------------------------------------------

const pendingDangerous = ref<string | null>(null)
const acknowledged = ref(false)

/**
 * Selecting a preset only ever changes the DEFAULT for new sessions immediately. Applying it to
 * the running session is a separate, explicit action — an escalation should never happen as a
 * side effect of browsing settings.
 */
function selectPreset(id: string) {
  const preset = PERMISSION_PRESETS.find((p) => p.id === id)
  if (!preset) return
  if (preset.dangerous && store.settings.value.permissionPreset !== id) {
    pendingDangerous.value = id
    acknowledged.value = false
    return
  }
  store.settings.value.permissionPreset = id
}

function confirmDangerous() {
  if (!acknowledged.value || !pendingDangerous.value) return
  store.settings.value.permissionPreset = pendingDangerous.value
  pendingDangerous.value = null
}

function cancelDangerous() {
  pendingDangerous.value = null
  acknowledged.value = false
}

/** Presets map to CLI modes; this is the mode the running session would switch to. */
const activePresetMode = computed(() => store.activePreset().mode)

// --- models -----------------------------------------------------------------

/**
 * The add-a-model form: exactly the three things an endpoint needs, plus whether to remember the key.
 *
 * There is no provider-NAME field. A provider name is a label for an endpoint, and the user has no
 * opinion about it — asking for one is what produced a provider named `qwen3.8-flash`. It is derived
 * from the host instead, and an existing provider with the same host is REUSED rather than duplicated,
 * so adding two models on one endpoint does not create two providers.
 */
interface ProviderDraft {
  model: string
  baseUrl: string
  apiKey: string
  persistKey: boolean
}

const newProvider = ref<ProviderDraft>({
  model: '',
  baseUrl: '',
  apiKey: '',
  persistKey: false,
})
const showNewKey = ref(false)
const testing = ref(false)
/** Result of the last connection test, cleared whenever any field changes. */
const testResult = ref<{ ok: boolean; message: string } | null>(null)
/** Set when the user tries to save without having tested, so the warning appears once. */
const saveWithoutTestWarning = ref(false)

const canTestConnection = computed(
  () =>
    newProvider.value.model.trim() !== '' &&
    newProvider.value.baseUrl.trim() !== '' &&
    newProvider.value.apiKey.trim() !== '',
)
const canSaveProvider = computed(() => canTestConnection.value)

/** Any edit invalidates a previous test: it was about the OLD values. */
function resetTestState() {
  testResult.value = null
  saveWithoutTestWarning.value = false
}

/** A readable provider name from the host, since the user is no longer asked for one. */
function providerNameFromUrl(baseUrl: string): string {
  try {
    const host = new URL(baseUrl.trim()).host.replace(/^www\./, '')
    const known = store.VENDOR_PRESETS.find((preset) => preset.baseUrl && preset.baseUrl.includes(host))
    if (known) return known.name
    // A bare IP (a local or self-hosted gateway) has no domain to derive a name from, and taking its
    // first dotted segment yields something like "127", which reads as a mistake.
    if (/^\d{1,3}(\.\d{1,3}){3}(:\d+)?$/.test(host) || host.startsWith('[')) return `本地端点 ${host}`
    // `api.deepseek.com` -> `deepseek`; `dashscope.aliyuncs.com` -> `aliyuncs`.
    const parts = host.split('.').filter((part) => part !== 'api' && part !== 'com' && part !== 'cn')
    return parts[0] ? parts[0] : host
  } catch {
    return '自定义端点'
  }
}

async function runConnectionTest() {
  if (!canTestConnection.value) return
  testing.value = true
  testResult.value = null
  saveWithoutTestWarning.value = false
  try {
    // The bridge makes the call: the page cannot reach a vendor that sends no CORS headers.
    testResult.value = await props.bridge.testConnection({
      baseUrl: newProvider.value.baseUrl.trim(),
      apiKey: newProvider.value.apiKey.trim(),
      model: newProvider.value.model.trim(),
    })
  } catch (error) {
    testResult.value = { ok: false, message: String((error as Error).message ?? error) }
  } finally {
    testing.value = false
  }
}

/**
 * Save: reuse the provider that already serves this host, otherwise create one.
 *
 * Reusing by HOST rather than by exact URL matters because a vendor's endpoint is commonly written
 * both with and without a trailing `/v1`, and treating those as two providers would fragment a single
 * account's models across two entries.
 */
function saveProviderFromForm() {
  if (!canSaveProvider.value) return
  const baseUrl = newProvider.value.baseUrl.trim()
  const model = newProvider.value.model.trim()
  const apiKey = newProvider.value.apiKey.trim()

  // Saving without a passing test is allowed — an endpoint may be briefly down — but it is not silent.
  if (!testResult.value?.ok) {
    saveWithoutTestWarning.value = true
  }

  let host = ''
  try {
    host = new URL(baseUrl).host
  } catch {
    host = baseUrl
  }

  const existing = store.settings.value.providers.find((provider) => {
    try {
      return new URL(provider.baseUrl).host === host
    } catch {
      return provider.baseUrl === baseUrl
    }
  })

  if (existing) {
    // Key and URL are refreshed from what was just tested, so a corrected key updates in place.
    store.updateProvider(existing.id, { baseUrl, apiKey, persistKey: newProvider.value.persistKey })
    if (!existing.models.some((entry) => entry.model === model)) {
      store.addModel(existing.id, { model, label: '' })
    }
  } else {
    const created = store.addProvider({
      name: providerNameFromUrl(baseUrl),
      baseUrl,
      apiKey,
      persistKey: newProvider.value.persistKey,
      models: [],
    })
    store.addModel(created.id, { model, label: '' })
  }

  // Clear the secret-looking fields; keep the URL so adding a second model is one field away.
  newProvider.value = { model: '', baseUrl, apiKey: '', persistKey: newProvider.value.persistKey }
  resetTestState()
  showNewKey.value = false
}

const modelDraft = ref<Record<string, { model: string; label: string }>>({})
/**
 * Per-provider message for a rejected "添加模型" click.
 *
 * `commitModel` used to `return` silently on an empty field. A click that does nothing and says
 * nothing is indistinguishable from a broken app — and this is exactly how a user concluded "添加模型
 * 之后还是没有": the model name had gone into the PROVIDER NAME field, the model field was empty, and
 * the button appeared to do nothing. The provider name is the loudest text in that block, so it is an
 * easy field to mistake for the model.
 */
const modelDraftError = ref<Record<string, string>>({})
const revealedKeys = ref<Set<string>>(new Set())

/** Catalog models the CLI reported. Anthropic's names, offered only on request. */
const catalogModels = computed(() => props.catalog?.models ?? [])

function draftFor(providerId: string) {
  if (!modelDraft.value[providerId]) modelDraft.value[providerId] = { model: '', label: '' }
  return modelDraft.value[providerId]
}

function commitModel(providerId: string) {
  const draft = draftFor(providerId)
  const name = draft.model.trim()
  if (!name) {
    // Say WHY nothing happened instead of returning silently. Also note the likeliest mix-up out
    // loud, because the field above (the provider name) is the most prominent text in the block.
    modelDraftError.value[providerId] = `请先填写模型名 —— 上面「${providerName(providerId)}」是服务商名称，不是模型`
    return
  }
  store.addModel(providerId, { model: name, label: draft.label.trim() })
  modelDraft.value[providerId] = { model: '', label: '' }
  delete modelDraftError.value[providerId]
}

/** Clear the rejection message as soon as the user starts fixing it. */
function clearModelError(providerId: string) {
  if (modelDraftError.value[providerId]) delete modelDraftError.value[providerId]
}

function providerName(providerId: string) {
  return store.providerById(providerId)?.name ?? '该服务商'
}

function toggleKey(id: string) {
  const next = new Set(revealedKeys.value)
  if (next.has(id)) next.delete(id)
  else next.add(id)
  revealedKeys.value = next
}

/**
 * Vendor quick-fill. Fills the BASE-URL only — the model name and key are the user's to type, and
 * pre-filling a model name would be inventing a fact about their account.
 */
const newProviderPresetId = ref('')
const baseUrlPlaceholder = computed(() => 'https://…/anthropic（Anthropic 兼容地址）')

function applyVendorPreset(id: string) {
  newProviderPresetId.value = id
  if (id === 'custom') return
  const preset = store.VENDOR_PRESETS.find((entry) => entry.id === id)
  if (!preset) return
  newProvider.value = { ...newProvider.value, baseUrl: preset.baseUrl }
  resetTestState()
}

/** One-click fill for the endpoint this build is aimed at, so a first run is not a research task. */
const canAddModel = computed(() => store.settings.value.providers.length > 0)
</script>

<template>
  <div class="st">
    <div class="st__scrim" @click="emit('close')" />

    <div class="st__panel" role="dialog" aria-label="设置">
      <header class="st__head">
        <span class="st__title">设置</span>
        <span class="st__spacer" />
        <button class="iconButton" type="button" title="关闭" @click="emit('close')">
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" />
          </svg>
        </button>
      </header>

      <div class="st__body">
        <!-- ------------------------------------------------------------ rail -- -->
        <nav class="st__rail">
          <button class="st__railItem" :class="{ 'st__railItem--on': section === 'general' }" type="button" @click="section = 'general'">
            通用
          </button>
          <button class="st__railItem" :class="{ 'st__railItem--on': section === 'permission' }" type="button" @click="section = 'permission'">
            权限
          </button>
          <button class="st__railItem" :class="{ 'st__railItem--on': section === 'models' }" type="button" @click="section = 'models'">
            模型
          </button>
          <button class="st__railItem" :class="{ 'st__railItem--on': section === 'pricing' }" type="button" @click="section = 'pricing'">
            费用核算
          </button>
          <button class="st__railItem" :class="{ 'st__railItem--on': section === 'bundled' }" type="button" @click="section = 'bundled'">
            内置插件
          </button>
          <button class="st__railItem" :class="{ 'st__railItem--on': section === 'import' }" type="button" @click="section = 'import'">
            导入会话
          </button>
          <button class="st__railItem" :class="{ 'st__railItem--on': section === 'audit' }" type="button" @click="section = 'audit'">
            安全审计
          </button>
          <button class="st__railItem" :class="{ 'st__railItem--on': section === 'about' }" type="button" @click="section = 'about'">
            关于
          </button>
        </nav>

        <!-- ------------------------------------------------------------- body -- -->
        <div class="st__content">
          <!-- general -->
          <template v-if="section === 'general'">
            <h3 class="st__h">通用</h3>

            <div class="st__field">
              <label class="st__label" for="lang">界面语言</label>
              <select id="lang" v-model="store.settings.value.language" class="st__select">
                <option value="zh-CN">简体中文</option>
                <option value="en">English</option>
              </select>
              <p class="st__hint">当前仅界面固定文案区分语言，模型输出语言由提示词决定。</p>
            </div>

            <div class="st__field">
              <label class="st__label">发送快捷键</label>
              <label class="st__check">
                <input v-model="store.settings.value.sendOnEnter" type="checkbox" />
                <span>Enter 发送，Shift+Enter 换行</span>
              </label>
              <p class="st__hint">关闭后改为 Ctrl+Enter 发送。</p>
            </div>

            <div class="st__field">
              <label class="st__label">端点配置位置</label>
              <p class="st__hint" style="margin-top: 0">
                Base URL 与 API-KEY 现在归属各个「服务商」，在
                <button class="st__link" type="button" @click="section = 'models'">设置 → 模型</button>
                里维护。这样同一个模型名在不同端点上可以被区分开，也可以同时保存多个服务商。
              </p>
            </div>

            <div class="st__field">
              <button class="st__ghost" type="button" @click="store.reset()">恢复默认设置</button>
              <p class="st__hint">只重置界面偏好与默认值；不会删除任何会话或凭据。</p>
            </div>
          </template>

          <!-- permission -->
          <template v-else-if="section === 'permission'">
            <h3 class="st__h">权限</h3>
            <p class="st__sub">选择新会话的默认权限模式</p>

            <div class="st__presets">
              <button
                v-for="preset in PERMISSION_PRESETS"
                :key="preset.id"
                class="st__preset"
                :class="{
                  'st__preset--on': store.settings.value.permissionPreset === preset.id,
                  'st__preset--danger': preset.dangerous,
                }"
                type="button"
                @click="selectPreset(preset.id)"
              >
                <div class="st__presetTop">
                  <span class="st__radio" />
                  <span class="st__presetLabel">{{ preset.label }}</span>
                  <span class="st__presetMode">{{ preset.mode }}</span>
                </div>
                <p class="st__presetDesc">{{ preset.description }}</p>
              </button>
            </div>

            <div class="st__field st__field--boxed">
              <label class="st__label">应用到当前会话</label>

              <template v-if="hasActiveSession">
                <p class="st__hint" style="margin-top: 0">
                  当前会话的实际模式为
                  <code>{{ props.sessionPermissionMode }}</code>
                  ，与新会话默认值（<code>{{ activePresetMode }}</code>）可能不同。
                  应用会立即切换运行中的会话，无需重启。
                </p>
                <div class="st__row">
                  <button
                    class="st__primary"
                    type="button"
                    :disabled="props.sessionPermissionMode === activePresetMode"
                    @click="emit('apply-mode', activePresetMode)"
                  >
                    {{
                      props.sessionPermissionMode === activePresetMode
                        ? '当前会话已是该模式'
                        : `将「${store.activePreset().label}」应用到当前会话`
                    }}
                  </button>
                  <span v-if="sessionCount" class="st__hint">共 {{ sessionCount }} 个会话</span>
                </div>
              </template>

              <!-- No session: say so instead of offering a button that cannot do anything. -->
              <template v-else>
                <p class="st__hint" style="margin-top: 0">
                  当前没有打开的会话，因此没有可切换的对象。上面的选择已作为
                  <strong>新会话的默认权限模式</strong>保存，新建会话时会自动生效。
                </p>
                <div class="st__row">
                  <button class="st__primary" type="button" @click="emit('new-session')">
                    关闭设置并新建会话
                  </button>
                </div>
              </template>
            </div>
          </template>

          <!-- models -->
          <template v-else-if="section === 'models'">
            <h3 class="st__h">模型</h3>
            <p class="st__sub">
              一个模型的身份是「服务商 + 模型名」：同一个模型名在不同端点上可能是完全不同的东西，
              真正决定谁来回答的是端点。可以同时保存多个服务商。
            </p>

            <div class="st__field">
              <label class="st__label" for="defModel">新会话默认模型</label>
              <select id="defModel" v-model="store.settings.value.defaultModelRef" class="st__select">
                <option value="">跟随默认服务商（不指定 --model）</option>
                <option
                  v-for="option in store.modelOptions()"
                  :key="option.ref"
                  :value="option.ref"
                >
                  {{ option.label }} — {{ option.providerName }}
                </option>
              </select>
              <p class="st__hint">仅影响新会话；运行中的会话在输入框的模型下拉里切换。</p>
            </div>

            <!-- providers -->
            <div class="st__field">
              <label class="st__label">服务商</label>
              <p class="st__hint" style="margin-top: 0">
                每个服务商需要 Anthropic 兼容的 Base URL 与 API-KEY；模型逐个添加。
                会话按所选模型自动使用对应服务商的地址与 Key。
              </p>

              <div v-for="provider in store.settings.value.providers" :key="provider.id" class="st__provider">
                <div class="st__providerHead">
                  <span class="st__providerName">{{ provider.name }}</span>
                  <span v-if="provider.isDefault" class="st__chipTag">默认</span>
                  <button
                    v-if="!provider.isDefault"
                    class="st__link"
                    type="button"
                    @click="store.setDefaultProvider(provider.id)"
                  >
                    设为默认
                  </button>
                  <button class="st__link st__link--danger" type="button" @click="store.removeProvider(provider.id)">
                    删除
                  </button>
                </div>

                <code class="st__providerUrl">{{ provider.baseUrl }}</code>

                <div class="st__row" style="margin-top: 8px">
                  <input
                    :value="provider.apiKey"
                    class="st__input"
                    :type="revealedKeys.has(provider.id) ? 'text' : 'password'"
                    spellcheck="false"
                    placeholder="API-KEY"
                    @input="store.updateProvider(provider.id, { apiKey: ($event.target as HTMLInputElement).value })"
                  />
                  <button class="st__ghost" type="button" @click="toggleKey(provider.id)">
                    {{ revealedKeys.has(provider.id) ? '隐藏' : '显示' }}
                  </button>
                  <label class="st__check st__check--inline">
                    <input
                      :checked="provider.persistKey"
                      type="checkbox"
                      @change="store.updateProvider(provider.id, { persistKey: ($event.target as HTMLInputElement).checked })"
                    />
                    <span>记住到本机</span>
                  </label>
                </div>
                <p v-if="!provider.persistKey" class="st__hint">
                  Key 默认不写入本地存储，重开应用需重新填写。
                </p>

                <div v-if="provider.models.length > 0" class="st__modelList">
                  <div v-for="model in provider.models" :key="model.id" class="st__modelRow">
                    <code class="st__modelId">{{ model.model }}</code>
                    <span v-if="model.label" class="st__modelLabel">{{ model.label }}</span>
                    <!--
                      Reasoning effort. Applies when a session STARTS on this model: the CLI takes
                      it as a `--effort` argument and has no control request for it, so changing it
                      mid-session relaunches the child (the conversation is resumed, not lost).
                    -->
                    <label class="st__effort" :title="`推理挡位（${model.model} 启动时生效）`">
                      <span class="st__effortLabel">推理挡位</span>
                      <select
                        class="st__input st__input--effort"
                        :value="model.effort ?? ''"
                        @change="store.setModelEffort(provider.id, model.id, ($event.target as HTMLSelectElement).value)"
                      >
                        <option value="">默认</option>
                        <option v-for="level in EFFORT_LEVELS" :key="level" :value="level">{{ level }}</option>
                      </select>
                    </label>
                    <button class="st__link st__link--danger" type="button" @click="store.removeModel(provider.id, model.id)">
                      移除
                    </button>
                  </div>
                </div>
                <p v-else class="st__hint">
                  尚未添加模型 —— <strong>在下面填模型名并点「添加模型」</strong>，它才会出现在输入框的模型列表里。
                  服务商名称（本块标题）只是给这组配置起的名，不是模型。
                </p>

                <div class="st__row" style="margin-top: 6px">
                  <input
                    v-model="draftFor(provider.id).model"
                    class="st__input"
                    spellcheck="false"
                    placeholder="模型名，如 deepseek-chat"
                    @input="clearModelError(provider.id)"
                    @keydown.enter="commitModel(provider.id)"
                  />
                  <input
                    v-model="draftFor(provider.id).label"
                    class="st__input st__input--narrow"
                    spellcheck="false"
                    placeholder="显示名（可选）"
                    @keydown.enter="commitModel(provider.id)"
                  />
                  <button class="st__ghost" type="button" @click="commitModel(provider.id)">添加模型</button>
                </div>

                <p v-if="modelDraftError[provider.id]" class="st__hint st__hint--error">
                  {{ modelDraftError[provider.id] }}
                </p>

                <!--
                  Balance endpoint. There is no standard balance API, so this is the escape hatch for
                  vendors we do not ship an adapter for (DeepSeek is matched automatically by host).
                  Left empty, an unknown vendor reports "no balance API" instead of guessing.
                -->
                <details class="st__details">
                  <summary class="st__detailsHead">账户余额（可选）</summary>
                  <p class="st__hint">
                    DeepSeek 的余额接口已内置，无需填写。其他厂商各家接口不同，填上「余额地址」与
                    「取值路径」即可读取，例如路径 <code>data.0.balance</code>。
                  </p>
                  <div class="st__row">
                    <input
                      :value="provider.balanceUrl ?? ''"
                      class="st__input"
                      spellcheck="false"
                      placeholder="余额接口地址，如 https://api.example.com/user/balance"
                      @change="store.updateProvider(provider.id, { balanceUrl: ($event.target as HTMLInputElement).value })"
                    />
                    <input
                      :value="provider.balancePath ?? ''"
                      class="st__input st__input--narrow"
                      spellcheck="false"
                      placeholder="取值路径"
                      @change="store.updateProvider(provider.id, { balancePath: ($event.target as HTMLInputElement).value })"
                    />
                    <input
                      :value="provider.currency ?? ''"
                      class="st__input st__input--narrow"
                      spellcheck="false"
                      placeholder="币种 CNY"
                      @change="store.updateProvider(provider.id, { currency: ($event.target as HTMLInputElement).value })"
                    />
                  </div>
                </details>
              </div>

              <!--
                Add a model. THREE fields only — model name, API-KEY, Base-URL — because those are
                exactly the three things an Anthropic-compatible endpoint needs to answer a request.
                The previous flow made the user name a provider, then find a second row to add a model
                to it; that split is where "the model never appeared" came from, and the provider name
                is not something the user has an opinion about anyway (it is derived from the host).
              -->
              <div class="st__provider st__provider--draft">
                <div class="st__row st__row--tight">
                  <select
                    class="st__select st__input--narrow"
                    :value="newProviderPresetId"
                    title="用已核对过的端点快速填入 Base-URL"
                    @change="applyVendorPreset(($event.target as HTMLSelectElement).value)"
                  >
                    <option value="">常用端点…</option>
                    <option v-for="preset in store.VENDOR_PRESETS" :key="preset.id" :value="preset.id">
                      {{ preset.name }}
                    </option>
                    <option value="custom">自定义</option>
                  </select>
                  <span class="st__hint" style="margin: 0">选一个可自动填 Base-URL，也可以直接手填</span>
                </div>

                <div class="st__row">
                  <input
                    v-model="newProvider.model"
                    class="st__input"
                    spellcheck="false"
                    placeholder="模型名称，如 deepseek-chat"
                    @input="resetTestState"
                  />
                </div>
                <div class="st__row">
                  <input
                    v-model="newProvider.apiKey"
                    class="st__input"
                    :type="showNewKey ? 'text' : 'password'"
                    spellcheck="false"
                    placeholder="API-KEY"
                    @input="resetTestState"
                  />
                  <button class="st__ghost" type="button" @click="showNewKey = !showNewKey">
                    {{ showNewKey ? '隐藏' : '显示' }}
                  </button>
                </div>
                <div class="st__row">
                  <input
                    v-model="newProvider.baseUrl"
                    class="st__input"
                    spellcheck="false"
                    :placeholder="baseUrlPlaceholder"
                    @input="resetTestState"
                  />
                </div>

                <div class="st__row" style="margin-top: 4px">
                  <button
                    class="st__ghost"
                    type="button"
                    :disabled="testing || !canTestConnection"
                    @click="runConnectionTest"
                  >
                    {{ testing ? '测试中…' : '测试连接' }}
                  </button>
                  <button
                    class="st__primary"
                    type="button"
                    :disabled="!canSaveProvider"
                    @click="saveProviderFromForm"
                  >
                    保存
                  </button>
                  <label class="st__check st__check--inline">
                    <input v-model="newProvider.persistKey" type="checkbox" />
                    <span>记住 KEY 到本机</span>
                  </label>
                </div>

                <!-- The test result, and why saving without one is allowed. -->
                <p
                  v-if="testResult"
                  class="st__hint"
                  :class="testResult.ok ? 'st__hint--ok' : 'st__hint--error'"
                >
                  {{ testResult.message }}
                  <template v-if="testResult.ok"> · 现在可以保存</template>
                </p>
                <p v-else-if="saveWithoutTestWarning" class="st__hint st__hint--error">
                  还没测试过连接。保存后如果端点或 KEY 有误，会话会在第一次请求时报错 —— 建议先点「测试连接」。
                </p>
              </div>
            </div>

            <p class="st__hint">
              只列出上面这些服务商实际提供的模型。CLI 自带的
              <strong>Anthropic 模型名</strong>（{{ catalogModels.map((m) => m.value).join(' / ') || '当前不可用' }}）
              不再提供：在中继端点上它们由<strong>服务端自动映射</strong>，选它并不等于选了某个具体模型，
              而是把选择权交给了端点 —— 那与"选模型"是两件事。
            </p>
          </template>

          <!-- cost accounting rates for vendors the built-in table does not cover -->
          <template v-else-if="section === 'pricing'">
            <h3 class="st__h">费用核算</h3>
            <p class="st__sub">
              侧栏的「费用」需要一个价目表才能算。内置的只有 DeepSeek 一家；接到其他厂商
              （通义千问 / 智谱 / Kimi / 阶跃星辰 / 讯飞星火 …）时，在这里填上你自己的单价即可生效。
            </p>

            <div class="st__field st__field--boxed">
              <p class="st__hint" style="margin-top: 0">
                为什么不是内置好？各家价格按<strong>模型档位、区域、计费方式</strong>（按量 / 批量 /
                缓存）各不相同，而且会变。随安装包发一份价目表，几个月后就是「自信地算错」——
                那比不显示更糟。填你自己账单上核对过的数字，当天就是对的，过期了也一眼看得出来。
              </p>
            </div>

            <div v-if="store.settings.value.priceTables.length === 0" class="st__hint">
              还没有自定义价目。没有匹配的价目时，费用一栏会<strong>留空并说明有几轮未计价</strong>，
              而不是显示 ¥0.00。
            </div>

            <div v-for="table in store.settings.value.priceTables" :key="table.id" class="pt__row">
              <div class="pt__head">
                <input
                  v-model="table.label"
                  class="field__input pt__label"
                  placeholder="名称，如 通义千问"
                  spellcheck="false"
                />
                <input
                  v-model="table.match"
                  class="field__input pt__match"
                  placeholder="匹配模型名，如 qwen"
                  spellcheck="false"
                />
                <button class="st__ghost" type="button" @click="store.removePriceTable(table.id)">删除</button>
              </div>
              <div class="pt__rates">
                <label class="pt__rate">
                  <span>输入（未命中缓存）</span>
                  <input v-model.number="table.cacheMiss" class="field__input" type="number" min="0" step="0.01" />
                </label>
                <label class="pt__rate">
                  <span>输入（命中缓存）</span>
                  <input v-model.number="table.cacheHit" class="field__input" type="number" min="0" step="0.01" />
                </label>
                <label class="pt__rate">
                  <span>输出</span>
                  <input v-model.number="table.output" class="field__input" type="number" min="0" step="0.01" />
                </label>
                <label class="pt__rate">
                  <span>高峰倍率（可选）</span>
                  <input
                    v-model.number="table.peakMultiplier"
                    class="field__input"
                    type="number"
                    min="1"
                    step="0.1"
                    placeholder="1 = 全天同价"
                  />
                </label>
              </div>
              <p class="st__hint">
                单位：元 / 百万 token。<code>{{ table.match || '*' }}</code>
                会匹配任何包含该片段的模型名（不区分大小写，留空则匹配全部）。
                <template v-if="providerForTable(table)">已按「{{ providerForTable(table) }}」的模型名预填。</template>
              </p>
            </div>

            <div class="st__field">
              <div class="pt__actions">
                <button
                  class="st__ghost"
                  type="button"
                  @click="store.addPriceTable({ match: '', label: '', cacheMiss: 0, cacheHit: 0, output: 0 })"
                >
                  添加一行
                </button>
                <button
                  v-for="provider in store.settings.value.providers"
                  :key="provider.id"
                  class="st__ghost"
                  type="button"
                  :title="`用 ${provider.name} 的第一个模型名预填匹配前缀`"
                  @click="store.seedPriceTable(provider.id)"
                >
                  从「{{ provider.name }}」预填
                </button>
              </div>
              <p class="st__hint">
                预填只写名称与匹配前缀，<strong>单价一律留 0</strong> —— 替你猜一个价格，
                正是这里要避免的事。
              </p>
            </div>

            <div class="st__field st__field--boxed">
              <label class="st__label">当前生效的价目</label>
              <!--
                A dedicated list rather than `st__kv`: that grid is sized for short keys, and a
                label like "DeepSeek（内置）" wraps into two broken lines inside it.
              -->
              <div class="pt__summary">
                <div v-for="row in activeRateSummary" :key="row.name" class="pt__summaryRow">
                  <span class="pt__summaryName">{{ row.name }}</span>
                  <span class="pt__summaryDetail">{{ row.detail }}</span>
                </div>
              </div>
              <p class="st__hint">
                自定义价目<strong>优先于</strong>内置价目，所以在 DeepSeek 上也可以用它覆盖内置数字，
                不必等新版本。
              </p>
            </div>
          </template>

          <!-- bundled components -->
          <BundledPanel
            v-else-if="section === 'bundled'"
            :catalog="catalog"
            :loaded-skills="loadedSkills"
            :loaded-plugins="loadedPlugins"
            :loaded-mcp-servers="loadedMcpServers"
          />

          <!-- existing Claude Code conversations -->
          <ImportPanel
            v-else-if="section === 'import'"
            :bridge="bridge"
            @open-transcript="(transcript) => emit('open-transcript', transcript)"
          />

          <!-- security audit of a plugin / skill directory -->
          <AuditPanel
            v-else-if="section === 'audit'"
            :bridge="bridge"
            :suggested-path="auditSuggestedPath ?? null"
          />

          <!-- about -->
          <template v-else>
            <h3 class="st__h">关于</h3>
            <div class="st__kv">
              <span class="st__kvK">客户端</span>
              <span class="st__kvV">Claude Code · CN</span>
              <span class="st__kvK">界面</span>
              <span class="st__kvV">Vue 3 + Tauri（WebView2）</span>
              <span class="st__kvK">桥接</span>
              <span class="st__kvV">本地 Node 进程，HTTP + SSE</span>
              <span class="st__kvK">claude.exe</span>
              <span class="st__kvV">官方原生二进制，未做修改</span>
            </div>
            <p class="st__hint">
              凭据不写入本页存储：API Key 只随建会话请求传给本地桥，仅存在于子进程生命周期内。
            </p>
          </template>
        </div>
      </div>
    </div>

    <!-- full-access confirmation -->
    <div v-if="pendingDangerous" class="cfm">
      <div class="cfm__scrim" @click="cancelDangerous" />
      <div class="cfm__panel">
        <h4 class="cfm__title">{{ PERMISSION_CONFIRM.title }}</h4>
        <p class="cfm__desc">{{ PERMISSION_CONFIRM.description }}</p>
        <label class="st__check">
          <input v-model="acknowledged" type="checkbox" />
          <span>{{ PERMISSION_CONFIRM.acknowledge }}</span>
        </label>
        <div class="cfm__actions">
          <button class="st__ghost" type="button" @click="cancelDangerous">{{ PERMISSION_CONFIRM.cancel }}</button>
          <button class="cfm__danger" type="button" :disabled="!acknowledged" @click="confirmDangerous">
            {{ PERMISSION_CONFIRM.enable }}
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.st {
  position: fixed;
  inset: 0;
  z-index: 60;
  display: grid;
  place-items: center;
  padding: 28px;
}

.st__scrim {
  position: absolute;
  inset: 0;
  background: rgba(0, 0, 0, 0.55);
}

.st__panel {
  position: relative;
  display: flex;
  flex-direction: column;
  width: 100%;
  max-width: 820px;
  height: 100%;
  max-height: 620px;
  border: 0.5px solid var(--dsw-alias-border-l2);
  border-radius: 16px;
  background: var(--dsw-alias-bg-layer-2);
  box-shadow: 0 16px 48px rgba(0, 0, 0, 0.55);
  overflow: hidden;
}

.st__head {
  display: flex;
  flex: none;
  align-items: center;
  gap: 10px;
  padding: 12px 16px;
  border-bottom: 0.5px solid var(--dsw-alias-border-l1);
}

.st__title {
  font-size: 14px;
  font-weight: 600;
}

.st__spacer {
  flex: 1;
}

.st__body {
  display: grid;
  grid-template-columns: 148px minmax(0, 1fr);
  flex: 1;
  min-height: 0;
}

.st__rail {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 10px 8px;
  border-right: 0.5px solid var(--dsw-alias-border-l1);
  background: var(--dsw-alias-bg-layer-1);
}

.st__railItem {
  padding: 7px 10px;
  border-radius: 8px;
  color: var(--dsw-alias-label-secondary);
  font-size: 13px;
  text-align: left;
}

.st__railItem:hover {
  background: var(--dsw-alias-interactive-bg-hover);
}

.st__railItem--on {
  background: var(--dsw-alias-interactive-bg-active);
  color: var(--dsw-alias-label-primary);
  font-weight: 500;
}

.st__content {
  min-width: 0;
  padding: 16px 20px 24px;
  overflow-y: auto;
}






.st__input,
.st__select {
  width: 100%;
  min-width: 0;
  padding: 7px 11px;
  border: 0.5px solid var(--dsw-alias-border-l2);
  border-radius: 8px;
  background: var(--dsw-static-neutral-bluish-900);
  outline: none;
  color: var(--dsw-alias-label-primary);
  font-size: 12.5px;
}

.st__input:focus,
.st__select:focus {
  border-color: var(--dsw-alias-state-business-primary);
}

.st__input--narrow {
  flex: 0 1 150px;
}


.st__check {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  color: var(--dsw-alias-label-secondary);
  font-size: 13px;
  line-height: 20px;
  cursor: pointer;
}

.st__check input {
  margin-top: 2px;
}

/* Inline variant for checkboxes that sit inside a control row. */
.st__check--inline {
  flex: none;
  align-items: center;
  white-space: nowrap;
}

.st__check--inline input {
  margin-top: 0;
}

.st__row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  margin-top: 8px;
}

.st__ghost {
  flex: none;
  padding: 8px 15px;
  border: 0.5px solid var(--dsw-alias-border-l2);
  border-radius: 8px;
  background: var(--dsw-alias-bg-layer-2);
  color: var(--dsw-alias-label-primary);
  font-size: 12.5px;
}

.st__ghost:hover:not(:disabled) {
  background: var(--dsw-alias-interactive-bg-hover-solid);
}

.st__ghost:disabled {
  opacity: 0.45;
}

.st__primary {
  flex: none;
  padding: 7px 14px;
  border-radius: 8px;
  background: var(--dsw-alias-button-info-fill);
  color: #fff;
  font-size: 12.5px;
  font-weight: 500;
}

.st__primary:hover {
  background: var(--dsw-alias-button-info-hover);
}

.st__link {
  flex: none;
  padding: 3px 0;
  color: var(--dsw-alias-link);
  font-size: 12px;
  line-height: 19px;
}

.st__link--danger {
  color: var(--dsw-alias-state-error-primary);
}

/* Collapsed-by-default extras: keeps a provider row readable while leaving the escape hatches
   discoverable, instead of hiding them behind a separate page. */
.st__details {
  margin-top: 10px;
}

.st__detailsHead {
  color: var(--dsw-alias-label-caption);
  font-size: 12px;
  line-height: 19px;
  cursor: pointer;
}

.st__detailsHead:hover {
  color: var(--dsw-alias-label-secondary);
}

/* presets */
.st__presets {
  display: grid;
  gap: 8px;
  margin-bottom: 18px;
}

.st__preset {
  padding: 11px 13px;
  border: 0.5px solid var(--dsw-alias-border-l2);
  border-radius: 10px;
  background: var(--dsw-alias-bg-layer-1);
  text-align: left;
}

.st__preset:hover {
  border-color: var(--dsw-alias-border-l3);
}

.st__preset--on {
  border-color: var(--dsw-alias-state-business-primary);
  background: var(--dsw-alias-state-business-tertiary);
}

.st__preset--danger.st__preset--on {
  border-color: var(--dsw-alias-state-error-primary);
  background: var(--dsw-alias-interactive-bg-hover-danger);
}

.st__presetTop {
  display: flex;
  align-items: center;
  gap: 9px;
}

.st__radio {
  flex: none;
  width: 13px;
  height: 13px;
  border: 1.5px solid var(--dsw-alias-border-l3);
  border-radius: 50%;
}

.st__preset--on .st__radio {
  border-color: var(--dsw-alias-state-business-primary);
  background: radial-gradient(circle, var(--dsw-alias-state-business-primary) 0 45%, transparent 46%);
}

.st__preset--danger.st__preset--on .st__radio {
  border-color: var(--dsw-alias-state-error-primary);
  background: radial-gradient(circle, var(--dsw-alias-state-error-primary) 0 45%, transparent 46%);
}

.st__presetLabel {
  font-size: 13px;
  font-weight: 600;
}

.st__presetMode {
  margin-left: auto;
  color: var(--dsw-alias-label-caption);
  font-family: var(--dsw-font-family-code);
  font-size: 10.5px;
}

.st__presetDesc {
  margin: 5px 0 0 22px;
  color: var(--dsw-alias-label-tertiary);
  font-size: 12px;
  line-height: 18px;
}

/* models */
.st__chips {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.st__chip {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 5px 10px;
  border: 0.5px solid var(--dsw-alias-border-l2);
  border-radius: 999px;
  background: var(--dsw-alias-bg-layer-1);
  color: var(--dsw-alias-label-secondary);
  font-family: var(--dsw-font-family-code);
  font-size: 11.5px;
}

.st__chip:hover {
  border-color: var(--dsw-alias-border-l3);
  color: var(--dsw-alias-label-primary);
}

.st__chip--on {
  border-color: var(--dsw-alias-state-business-primary);
  background: var(--dsw-alias-state-business-tertiary);
  color: var(--dsw-static-deepseek-400);
}

.st__chipTag {
  padding: 0 5px;
  border-radius: 4px;
  background: var(--dsw-alias-bg-layer-3);
  color: var(--dsw-alias-label-caption);
  font-family: var(--dsw-font-family);
  font-size: 10px;
}

.st__provider {
  margin-bottom: 10px;
  padding: 10px 12px;
  border: 0.5px solid var(--dsw-alias-border-l1);
  border-radius: 10px;
  background: var(--dsw-alias-bg-layer-1);
}

.st__provider--draft {
  background: transparent;
  border-style: dashed;
}

.st__providerHead {
  display: flex;
  align-items: center;
  gap: 9px;
}

.st__providerName {
  font-size: 12.5px;
  font-weight: 600;
}

.st__providerHead .st__link:first-of-type {
  margin-left: auto;
}

.st__providerHead .st__link + .st__link {
  margin-left: 0;
}

.st__providerUrl {
  display: block;
  min-width: 0;
  margin-top: 3px;
  overflow: hidden;
  color: var(--dsw-alias-label-caption);
  font-family: var(--dsw-font-family-code);
  font-size: 11px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.st__modelList {
  margin-top: 7px;
  display: grid;
  gap: 3px;
}

.st__modelRow {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 4px 6px;
  border-radius: 6px;
  background: var(--dsw-alias-bg-layer-2);
}

.st__modelId {
  font-family: var(--dsw-font-family-code);
  font-size: 11.5px;
}

.st__modelLabel {
  color: var(--dsw-alias-label-caption);
  font-size: 11.5px;
}

.st__modelRow .st__link {
  margin-left: auto;
}

/*
 * The effort selector sits between the model name and the 移除 link, so the row keeps one line
 * and the model name stays the widest element.
 */
.st__effort {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-left: 4px;
}

.st__effortLabel {
  color: var(--dsw-alias-label-caption);
  font-size: 11.5px;
}

.st__input--effort {
  width: auto;
  min-width: 76px;
  padding: 2px 4px;
  font-size: 11.5px;
}

.st__kv {
  display: grid;
  grid-template-columns: 92px minmax(0, 1fr);
  gap: 6px 12px;
  margin-bottom: 14px;
  font-size: 12px;
}

.st__kvK {
  color: var(--dsw-alias-label-caption);
}

.st__kvV {
  color: var(--dsw-alias-label-secondary);
}

/* confirmation */
.cfm {
  position: fixed;
  inset: 0;
  z-index: 70;
  display: grid;
  place-items: center;
  padding: 32px;
}

.cfm__scrim {
  position: absolute;
  inset: 0;
  background: rgba(0, 0, 0, 0.6);
}

.cfm__panel {
  position: relative;
  width: 100%;
  max-width: 460px;
  padding: 20px 22px;
  border: 0.5px solid var(--dsw-alias-border-l2);
  border-radius: 14px;
  background: var(--dsw-alias-bg-layer-2);
  box-shadow: 0 16px 48px rgba(0, 0, 0, 0.6);
}

.cfm__title {
  margin: 0 0 8px;
  font-size: 15px;
  font-weight: 600;
}

.cfm__desc {
  margin: 0 0 14px;
  color: var(--dsw-alias-label-secondary);
  font-size: 12.5px;
  line-height: 19px;
}

.cfm__actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 16px;
}

.cfm__danger {
  padding: 7px 15px;
  border-radius: 8px;
  background: var(--dsw-alias-state-error-primary);
  color: #fff;
  font-size: 12.5px;
  font-weight: 600;
}

.cfm__danger:disabled {
  opacity: 0.45;
}
</style>
