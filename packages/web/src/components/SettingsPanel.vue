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
import { useSettings, PERMISSION_PRESETS, PERMISSION_CONFIRM } from '../composables/useSettings'
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
 * Settings → 模型 is a list of cards, and each card is ONE usable model.
 *
 * A card is created with 「+ 新建」, filled in and saved — and once saved it is READ-ONLY, with 删除
 * as its only action. That asymmetry is the point: a saved card has exactly one representation in the
 * store, so nothing on screen can disagree with what a session will use, and "which card is the real
 * one" never becomes a question. Editing in place, by contrast, needed a draft per card, a dirty
 * marker, and a save that could silently not have run.
 *
 * The four fields are exactly what an Anthropic-compatible endpoint needs to answer a request.
 * Everything that used to sit beside them is gone on purpose:
 *   - 常用平台 duplicated the 服务商 choice — a vendor IS the platform — so 服务商 is the dropdown now,
 *     and picking one still fills the verified Base URL.
 *   - 推理挡位 moved to the COMPOSER, where it can be changed mid-conversation instead of only at
 *     card-creation time.
 *   - The key-visibility toggle and the balance-endpoint override were knobs a first run never touches.
 */
interface CardDraft {
  /** Selected platform preset, '' for none, or 'custom'. Drives the name and the Base URL. */
  presetId: string
  name: string
  model: string
  baseUrl: string
  apiKey: string
}

/**
 * The one in-progress card, or null.
 *
 * Deliberately NOT in the store until 保存: a card that is visible but unsaved is a record the rest
 * of the app cannot see, and keeping it out of `providers` means an abandoned draft leaves nothing
 * behind — no stub to prune on the next launch, and no half-filled entry for the composer to trip on.
 */
const draft = ref<CardDraft | null>(null)
const testing = ref(false)
/** The draft's connection-test result, or why a save was refused. Never both. */
const draftMessage = ref<{ ok: boolean; text: string } | null>(null)

/** Catalog models the CLI reported. Anthropic's names, listed for context only. */
const catalogModels = computed(() => props.catalog?.models ?? [])

const baseUrlPlaceholder = 'https://…/anthropic（Anthropic 兼容地址）'

function startDraft() {
  draft.value = { presetId: '', name: '', model: '', baseUrl: '', apiKey: '' }
  draftMessage.value = null
}

function cancelDraft() {
  draft.value = null
  draftMessage.value = null
}

/**
 * Apply the chosen platform.
 *
 * Fills the NAME, and the Base URL ONLY where one was verified. Several platforms are listed for
 * their console link alone, and writing their empty address here would silently wipe what the user
 * had already typed. The model name and key stay the user's to type — pre-filling a model would be
 * inventing a fact about their account — so a known model name is offered as a PLACEHOLDER instead,
 * which suggests without asserting.
 */
function applyPreset() {
  const current = draft.value
  if (!current) return
  draftMessage.value = null
  if (!current.presetId) return
  if (current.presetId === 'custom') {
    current.name = ''
    return
  }
  const preset = store.VENDOR_PRESETS.find((entry) => entry.id === current.presetId)
  if (!preset) return
  current.name = preset.name
  if (preset.baseUrl) current.baseUrl = preset.baseUrl
}

const draftModelPlaceholder = computed(() => {
  const preset = store.VENDOR_PRESETS.find((entry) => entry.id === draft.value?.presetId)
  return preset?.modelHint ? `如 ${preset.modelHint}` : '如 deepseek-chat'
})

/** A connection test exercises the endpoint, the key and the model — all three are required for it. */
const canTestDraft = computed(() => {
  const current = draft.value
  return Boolean(current && current.model.trim() && current.baseUrl.trim() && current.apiKey.trim())
})

async function runConnectionTest() {
  const current = draft.value
  if (!current || !canTestDraft.value) return
  testing.value = true
  draftMessage.value = null
  try {
    // The bridge makes the call: the page cannot reach a vendor that sends no CORS headers.
    const result = await props.bridge.testConnection({
      baseUrl: current.baseUrl.trim(),
      apiKey: current.apiKey.trim(),
      model: current.model.trim(),
    })
    draftMessage.value = { ok: result.ok, text: result.message }
  } catch (error) {
    draftMessage.value = { ok: false, text: String((error as Error).message ?? error) }
  } finally {
    testing.value = false
  }
}

/** A readable provider name from the host, used when 自定义 leaves the name empty. */
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

/**
 * Save the draft.
 *
 * A missing API-KEY does NOT block the save: an endpoint can be configured before its key is issued,
 * and the shell already reports 缺少 API-KEY for exactly that state. A missing model name or Base URL
 * DOES block, and the reason is STATED — a disabled button explains nothing about why, which is how
 * "保存之后什么都没出现" happened before.
 */
function saveDraft() {
  const current = draft.value
  if (!current) return

  const model = current.model.trim()
  const baseUrl = current.baseUrl.trim()
  const missing: string[] = []
  if (!model) missing.push('模型名称')
  if (!baseUrl) missing.push('Base URL')
  if (missing.length > 0) {
    draftMessage.value = { ok: false, text: `请先填写：${missing.join('、')}` }
    return
  }

  const created = store.addProvider({
    name: current.name.trim() || providerNameFromUrl(baseUrl),
    baseUrl,
    apiKey: current.apiKey.trim(),
    /**
     * The key IS written to this machine's localStorage.
     *
     * There is no 记住到本机 checkbox any more, and a key that vanished on every restart would make
     * the app unusable rather than safer: the card is stored locally either way, so the only thing
     * the old flag changed was whether the user had to re-type their credential every launch.
     */
    persistKey: true,
    models: [],
  })
  store.setProviderModel(created.id, model)

  draft.value = null
  draftMessage.value = null
}

function removeSaved(providerId: string) {
  store.removeProvider(providerId)
}
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
              真正决定谁来回答的是端点。
            </p>

            <div class="st__cardsHead">
              <span class="st__label" style="margin: 0">模型选项卡</span>
              <span class="st__spacer" />
              <button class="st__ghost" type="button" :disabled="draft !== null" @click="startDraft">
                + 新建
              </button>
            </div>

            <!--
              The draft: the ONLY editable card, and the only way one is created. Four fields, three
              buttons, nothing else.
            -->
            <div v-if="draft" class="st__provider st__provider--draft">
              <div class="st__row">
                <label class="st__fieldLabel" for="draft-provider">服务商</label>
                <select id="draft-provider" v-model="draft.presetId" class="st__select" @change="applyPreset">
                  <option value="">请选择…</option>
                  <option v-for="preset in store.VENDOR_PRESETS" :key="preset.id" :value="preset.id">
                    {{ preset.name }}{{ preset.baseUrl ? '' : '（地址需自查）' }}
                  </option>
                  <option value="custom">自定义</option>
                </select>
              </div>

              <div class="st__row">
                <label class="st__fieldLabel" for="draft-model">模型名称</label>
                <input
                  id="draft-model"
                  v-model="draft.model"
                  class="st__input"
                  spellcheck="false"
                  :placeholder="draftModelPlaceholder"
                />
              </div>

              <div class="st__row">
                <label class="st__fieldLabel" for="draft-url">Base URL</label>
                <input
                  id="draft-url"
                  v-model="draft.baseUrl"
                  class="st__input"
                  spellcheck="false"
                  :placeholder="baseUrlPlaceholder"
                />
              </div>

              <div class="st__row">
                <label class="st__fieldLabel" for="draft-key">API-KEY</label>
                <input
                  id="draft-key"
                  v-model="draft.apiKey"
                  class="st__input"
                  type="password"
                  spellcheck="false"
                  placeholder="API-KEY"
                />
              </div>

              <p v-if="draftMessage" class="st__hint" :class="draftMessage.ok ? 'st__hint--ok' : 'st__hint--error'">
                {{ draftMessage.text }}
              </p>

              <div class="st__row">
                <button class="st__ghost" type="button" @click="cancelDraft">取消</button>
                <button
                  class="st__ghost"
                  type="button"
                  :disabled="testing || !canTestDraft"
                  @click="runConnectionTest"
                >
                  {{ testing ? '测试中…' : '测试连接' }}
                </button>
                <button class="st__primary" type="button" @click="saveDraft">保存</button>
              </div>
            </div>

            <p v-if="store.settings.value.providers.length === 0 && !draft" class="st__empty">
              还没有任何模型。点右上角「+ 新建」，填上服务商、模型名称、Base URL 与 API-KEY 再保存，
              它就会出现在输入框的模型下拉里。
            </p>

            <!--
              Saved cards are read-only, with 删除 as the only action. Everything a saved card needs to
              say is here: which platform, which model, and which endpoint it will be reached through.
            -->
            <div v-for="provider in store.settings.value.providers" :key="provider.id" class="st__provider">
              <div class="st__providerHead">
                <span v-if="provider.isDefault" class="st__chipTag">默认</span>
                <span class="st__providerName">{{ provider.name }}</span>
                <code class="st__modelId">{{ provider.models[0]?.model }}</code>
                <span class="st__spacer" />
                <button class="st__link st__link--danger" type="button" @click="removeSaved(provider.id)">
                  删除
                </button>
              </div>
              <code class="st__providerUrl">{{ provider.baseUrl }}</code>
            </div>

            <!--
              Platform directory. Getting a KEY is the step that actually blocks a first run, and it
              happens on a vendor's website — not inside this app — so the links are collected here
              instead of leaving the user to search for the right console.
            -->
            <div class="st__field">
              <label class="st__label">国内模型平台官网</label>
              <p class="st__hint" style="margin-top: 0">
                到任一平台注册并创建 API-KEY，回到上面的「+ 新建」填入即可直连。
                标了「已验证地址」的平台选中后会自动填好 Base-URL；其余只保证官网链接，
                Anthropic 兼容地址请以该平台自己的文档为准。
              </p>
              <div class="st__vendors">
                <div v-for="preset in store.VENDOR_PRESETS" :key="preset.id" class="st__vendor">
                  <span class="st__vendorName">{{ preset.name }}</span>
                  <span v-if="preset.baseUrl" class="st__chipTag">已验证地址</span>
                  <span v-if="preset.note" class="st__vendorNote">{{ preset.note }}</span>
                  <span class="st__spacer" />
                  <a
                    v-if="preset.consoleUrl"
                    class="st__link"
                    :href="preset.consoleUrl"
                    target="_blank"
                    rel="noreferrer"
                  >开放平台 ↗</a>
                  <a
                    v-if="preset.docsUrl"
                    class="st__link"
                    :href="preset.docsUrl"
                    target="_blank"
                    rel="noreferrer"
                  >文档 ↗</a>
                </div>
              </div>
            </div>

            <p class="st__hint">
              只列出上面这些选项卡实际提供的模型。CLI 自带的
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

            <!--
              The author's statement. It is the one block in settings that is not explaining a
              control, so it is set apart deliberately: white on a raised panel, where every other
              section uses the muted caption colour for prose.
            -->
            <div class="st__author">
              <p class="st__authorLead">青岛理工大学 2022 级毕业生水哥，励志做中国人的 AI 和智能体。</p>
              <p class="st__authorBody">
                这是 Claude Code 二次 Harness 化开发版 ClaudeCode-CN，剔除了所有风控点并将原有的 CLI
                终端图形化。
              </p>
              <p class="st__authorBody">
                此项目在 GitHub 上开源：
                <a
                  class="st__authorLink"
                  href="https://github.com/WPH666-py/ChinaClaude"
                  target="_blank"
                  rel="noreferrer"
                >github.com/WPH666-py/ChinaClaude</a>。
                需要再次开发的同学，请备注原作者为水哥。
              </p>
              <p class="st__authorBody">
                对此产品如有任何疑问，请邮件联系
                <a class="st__authorLink" href="mailto:943050454@qq.com">943050454@qq.com</a>，水哥感激不尽。
              </p>
            </div>

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

/* The per-card 保存 button: smaller than a page-level action, because it acts on one card. */
.st__ghost--sm {
  padding: 5px 12px;
  font-size: 12px;
}

/* A card with unsaved edits gets the one button on the panel that is worth pressing. */
.st__ghost--on {
  border-color: transparent;
  background: var(--dsw-alias-brand-primary, #4d6bfe);
  color: #fff;
}

.st__ghost--on:hover:not(:disabled) {
  background: var(--dsw-alias-brand-primary-hover, #3f5ae0);
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

/* The draft card is the only editable one, so it is the only one that looks like a form. */
.st__provider--draft {
  background: transparent;
  border-style: dashed;
}

/* Header row above the card stack: a label on the left, 新建 pushed right. */
.st__cardsHead {
  display: flex;
  align-items: center;
  gap: 9px;
  margin-top: 12px;
}

.st__empty {
  margin: 6px 0 0;
  padding: 14px 12px;
  border: 0.5px dashed var(--dsw-alias-border-l1);
  border-radius: 10px;
  color: var(--dsw-alias-label-caption);
  font-size: 12.5px;
  text-align: center;
}

.st__providerHead {
  display: flex;
  align-items: center;
  gap: 9px;
}

/*
 * A saved card's summary line: platform name, then the model it serves. The name is the loudest
 * element because that is what the user chose; the model id is code because it is sent verbatim.
 */
.st__providerName {
  font-size: 12.5px;
  font-weight: 600;
}

.st__modelId {
  min-width: 0;
  overflow: hidden;
  color: var(--dsw-alias-label-caption);
  font-family: var(--dsw-font-family-code);
  font-size: 11.5px;
  text-overflow: ellipsis;
  white-space: nowrap;
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

.st__providerHead .st__link:first-of-type {
  margin-left: auto;
}

.st__providerHead .st__link + .st__link {
  margin-left: 0;
}

/* A labelled input row: the label is a fixed gutter so the four fields line up. */
.st__fieldLabel {
  flex: none;
  width: 62px;
  color: var(--dsw-alias-label-caption);
  font-size: 12px;
}

/* Platform directory: one row per vendor, links pushed right by the row's spacer. */
.st__vendors {
  display: grid;
  gap: 4px;
  margin-top: 6px;
}

.st__vendor {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 5px 8px;
  border-radius: 6px;
  background: var(--dsw-alias-bg-layer-2);
}

.st__vendorName {
  flex: none;
  font-size: 12.5px;
  font-weight: 600;
}

.st__vendorNote {
  min-width: 0;
  overflow: hidden;
  color: var(--dsw-alias-label-caption);
  font-size: 11px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/*
 * The effort selector sits beside the model name, so that row keeps one line and the name stays the
 * widest element.
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

/*
 * The author's statement.
 *
 * White on a raised panel, which is the one place in this panel that departs from the muted caption
 * colour used for explanatory prose. That is the point: every other section explains a control, and
 * this one is the author speaking, so it should read as a statement rather than as another hint.
 */
.st__author {
  margin-bottom: 14px;
  padding: 12px 14px;
  border: 0.5px solid var(--dsw-alias-border-l2);
  border-radius: 10px;
  background: var(--dsw-alias-bg-layer-2);
  color: #fff;
}

.st__authorLead {
  margin: 0 0 8px;
  color: #fff;
  font-size: 13px;
  font-weight: 600;
  line-height: 20px;
}

.st__authorBody {
  margin: 0 0 6px;
  color: #fff;
  font-size: 12.5px;
  line-height: 20px;
}

.st__authorBody:last-child {
  margin-bottom: 0;
}

/* Underlined rather than recoloured, so the block stays white while the links stay findable. */
.st__authorLink {
  color: #fff;
  text-decoration: underline;
  text-underline-offset: 2px;
  word-break: break-all;
}

.st__authorLink:hover {
  color: var(--dsw-alias-link);
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
