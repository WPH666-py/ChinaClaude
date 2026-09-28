/**
 * Client-side settings store.
 *
 * Mirrors the Harness settings structure (general / permission / models).
 *
 * MODEL IDENTITY IS (provider, model). This matters more than it looks: a model id alone is
 * meaningless, because the same string can exist at several endpoints and the endpoint decides
 * what actually answers. The CLI's own model list is Anthropic's, and a relay endpoint like
 * DeepSeek's Anthropic-compatible surface answers those names by MAPPING them server-side — so
 * showing that list as "the models" would imply Claude is answering when it is not.
 *
 * CREDENTIALS: a provider owns its API key, which is why the store can hold more than one
 * provider at a time. Storing a key in localStorage is a real trade-off, so it is gated behind
 * an explicit opt-in per key (`persistKey`) and surfaced in the UI. Keys are never sent
 * anywhere except the local bridge, which forwards them to the CLI child process.
 */
import { ref, watch } from 'vue'

/**
 * Storage key version.
 *
 * Bumped whenever a default changes in a way that a PERSISTED value would fight: changing a
 * default does not touch what is already in localStorage, so a setting that used to default to
 * true keeps being true forever. Native-model visibility is exactly that case — it defaulted to
 * true before providers existed, and every install that ever ran that build would otherwise keep
 * showing Anthropic model names with no way to understand why.
 */
const STORAGE_KEY = 'cccn.settings.v3'

/**
 * Permission presets, with the wording taken from Harness-CN and the `mode` values mapped to
 * what the CLI actually accepts.
 *
 *   readOnly      -> plan            `plan` is documented as "no actual tool execution",
 *                                    the only mode that genuinely prevents writes.
 *   ask           -> default         standard behaviour: prompts for dangerous operations.
 *   workspaceWrite-> acceptEdits     auto-accepts file edits, still asks for anything else.
 *   fullAccess    -> bypassPermissions  needs the session launched with a skip-permissions
 *                                    OPTION; the bridge always does that.
 */
export const PERMISSION_PRESETS = [
  { id: 'readOnly', label: '仅可查看', mode: 'plan', description: '只分析与规划，不执行任何工具，不改动文件。' },
  { id: 'ask', label: '需逐步审批', mode: 'default', description: '默认行为：危险操作会逐次询问，由你决定是否放行。' },
  { id: 'workspaceWrite', label: '工作区内修改', mode: 'acceptEdits', description: '自动接受文件编辑，其余操作仍会询问。' },
  {
    id: 'fullAccess',
    label: '完全权限',
    mode: 'bypassPermissions',
    description: '跳过全部权限检查，敏感操作、文件修改与外部命令都会直接执行。',
    dangerous: true,
  },
]

export const PERMISSION_CONFIRM = {
  title: '确认启用完全权限？',
  description:
    '启用完全权限后，会话将减少确认步骤，并且可以直接执行更多操作，包括敏感操作、文件修改或外部命令。仅建议在你信任后续任务时使用。',
  acknowledge: '我已了解风险，并愿意继续',
  cancel: '取消',
  enable: '启用完全权限',
}

/** One model offered by a provider. */
export interface ProviderModel {
  id: string
  /** Model id sent to the CLI via --model. */
  model: string
  /** Optional display name; falls back to the model id. */
  label: string
  /**
   * Reasoning effort pinned to this model, or empty for the CLI's model default.
   *
   * Per MODEL rather than per session because that is how it is actually chosen: effort is a
   * property of how much thinking a given model should do, and the same user wants `max` on a
   * slow flagship and nothing at all on a cheap one.
   */
  effort?: string
}

/**
 * Reasoning effort levels the CLI accepts for `--effort`.
 *
 * Taken from the levels the CLI itself reports per model (`supportedEffortLevels`), not invented:
 * `xhigh` sits between `high` and `max` and is easy to miss when guessing from prose. The CLI
 * validates independently and warns instead of failing, so an unknown value degrades to the model
 * default rather than breaking a session.
 */
export const EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'] as const

/** An Anthropic-compatible endpoint plus the models it serves. */
/**
 * Known Anthropic-compatible vendors, as one-click starting points.
 *
 * WHY A LIST RATHER THAN A FREE-TEXT NAME FIELD: naming a provider is not a creative act — it is a
 * label for an endpoint — and getting it wrong is confusing in a specific way. The reported case was
 * a provider named `qwen3.8-flash`, i.e. a MODEL name where a vendor name belonged, which made the
 * model picker read `qwen3.8-flash — qwen3.8-flash`.
 *
 * A BASE URL IS INCLUDED ONLY WHEN IT WAS VERIFIED IN THE VENDOR'S OWN DOCS. A guessed endpoint fails
 * silently — the user sees an auth or 404 error and blames the app — so vendors whose Anthropic-compatible
 * address could not be confirmed are NOT listed at all; "自定义" covers them, with the URL typed from
 * their own documentation.
 *
 * Verified sources:
 *   deepseek  https://api.deepseek.com/anthropic                    (shipped default, exercised live)
 *   qwen      https://dashscope.aliyuncs.com/apps/anthropic         (Aliyun Model Studio docs)
 *   glm       https://open.bigmodel.cn/api/anthropic                (Zhipu open docs)
 *   kimi      https://api.moonshot.cn/anthropic                     (Kimi open platform docs)
 *
 * `modelHint` is a starting NAME to type into the model row. It is deliberately not auto-added:
 * several of these vendors expose no model-list endpoint, so the model must be stated explicitly, and
 * silently inventing one would hide that.
 */
export const VENDOR_PRESETS = [
  {
    id: 'deepseek',
    name: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com/anthropic',
    modelHint: 'deepseek-chat',
    docsUrl: 'https://api-docs.deepseek.com/zh-cn/',
    /** Balance and pricing are built in for this one. */
    note: '内置余额查询与价目表',
  },
  {
    id: 'qwen',
    name: '千问 Qwen',
    baseUrl: 'https://dashscope.aliyuncs.com/apps/anthropic',
    modelHint: 'qwen3.8-flash',
    docsUrl: 'https://help.aliyun.com/zh/model-studio/anthropic-api-messages',
    note: '不提供模型列表接口，模型名需手动填写',
  },
  {
    id: 'glm',
    name: '智谱 GLM',
    baseUrl: 'https://open.bigmodel.cn/api/anthropic',
    modelHint: 'glm-4.6',
    docsUrl: 'https://docs.bigmodel.cn/cn/guide/develop/claude/introduction',
    note: '',
  },
  {
    id: 'kimi',
    name: 'Kimi 月之暗面',
    baseUrl: 'https://api.moonshot.cn/anthropic',
    modelHint: 'kimi-k2-0905-preview',
    docsUrl: 'https://platform.kimi.com/docs/api/overview',
    note: '内置余额查询（/v1/users/me/balance）',
  },
] as const

export interface Provider {
  id: string
  name: string
  /** e.g. https://api.deepseek.com/anthropic */
  baseUrl: string
  apiKey: string
  /**
   * Whether `apiKey` is written to localStorage. Off by default: the session can still be
   * started with the key supplied in the form, it just is not remembered.
   */
  persistKey: boolean
  models: ProviderModel[]
  /** Set for the endpoint the user names as the default for new sessions. */
  isDefault?: boolean
  /**
   * Balance endpoint, when the vendor is not one we ship an adapter for.
   *
   * There is no standard balance API, so this is the escape hatch: any URL that returns JSON, plus
   * `balancePath` naming the number inside it (e.g. `data.0.balance`). Left empty, a known vendor is
   * matched by host and a vendor we do not know reports "no balance API" rather than guessing.
   */
  balanceUrl?: string
  /** Dotted path to the balance number inside the response, e.g. `balance_infos.0.total_balance`. */
  balancePath?: string
  /** Currency label to display, e.g. CNY. Cosmetic only; never used in arithmetic. */
  currency?: string
}

/**
 * A user-supplied price row, in CNY per 1,000,000 tokens.
 *
 * Needed because the built-in table only covers DeepSeek: measured, 16 of 16 common Qwen / GLM /
 * Kimi / 阶跃星辰 / 讯飞星火 model names were unpriced, so the cost row disappeared for anyone else.
 * Shipping five more vendors' numbers would be worse than shipping none — published prices differ
 * by tier, region and billing mode and change over time, so an installer's table is confidently
 * wrong within months. Rates the user can check against their own bill are right when typed and
 * obviously stale when they are not.
 */
export interface PriceTable {
  id: string
  /** Case-insensitive substring of the model name. Empty matches everything (a catch-all). */
  match: string
  label: string
  /** CNY per 1M tokens, cache MISS (i.e. ordinary input). */
  cacheMiss: number
  /** CNY per 1M tokens, cache HIT. Most vendors charge far less; 0 if they do not bill it. */
  cacheHit: number
  /** CNY per 1M tokens of output. */
  output: number
  /**
   * Optional peak multiplier. Leave at 1 (default) for the common case where the vendor bills the
   * same rate all day; only DeepSeek's built-in table distinguishes peak from off-peak.
   */
  peakMultiplier?: number
}

export interface Settings {
  language: 'zh-CN' | 'en'
  appearance: 'dark'
  sendOnEnter: boolean
  permissionPreset: string
  /**
   * Which model new sessions start on, as "providerId::model". Empty means the endpoint default.
   * A bare model id (no separator) is also accepted and resolves against the default provider.
   */
  defaultModelRef: string
  providers: Provider[]
  /** User price rows for cost accounting; they take precedence over the built-in table. */
  priceTables: PriceTable[]
  /**
   * REMOVED: `showNativeModels`.
   *
   * The CLI's model list is deliberately NOT offered any more. Against a relay endpoint those names
   * are Anthropic's and get remapped server-side, so picking one never selects a model — it hands
   * the choice to the endpoint, which is the opposite of what a model picker implies. The option was
   * also the source of a real trap: a reference such as `sonnet[1m]` picked while the list was
   * visible kept applying to every new session after the list was hidden, with no UI left to clear
   * it. Only models that a configured provider actually serves are selectable now.
   *
   * A persisted `showNativeModels` from an older build is ignored and stripped on load.
   */
}

const DEFAULT_BASE_URL = 'https://api.deepseek.com/anthropic'

function defaults(): Settings {
  return {
    language: 'zh-CN',
    appearance: 'dark',
    sendOnEnter: true,
    permissionPreset: 'ask',
    defaultModelRef: '',
    providers: [],
    priceTables: [],
  }
}

/** Composite reference for a (provider, model) pair. */
export function modelRef(providerId: string, model: string): string {
  return `${providerId}::${model}`
}

export function parseModelRef(ref: string): { providerId: string; model: string } {
  const index = ref.indexOf('::')
  if (index < 0) return { providerId: '', model: ref }
  return { providerId: ref.slice(0, index), model: ref.slice(index + 2) }
}

function load(): Settings {
  const base = defaults()
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return base
    const parsed = JSON.parse(raw) as Partial<Settings> & { showNativeModels?: unknown }
    const providers = Array.isArray(parsed.providers) ? parsed.providers : []
    const priceTables = Array.isArray(parsed.priceTables) ? parsed.priceTables : []
    // `showNativeModels` was removed; drop it so an old blob cannot resurrect the option.
    delete parsed.showNativeModels
    return {
      ...base,
      ...parsed,
      // Normalise the shapes that corrupt most easily on load.
      providers: providers.map((provider) => ({
        ...provider,
        apiKey: typeof provider.apiKey === 'string' ? provider.apiKey : '',
        persistKey: provider.persistKey === true,
        models: Array.isArray(provider.models) ? provider.models : [],
      })),
      /**
       * Rates are coerced to numbers because they arrive from text inputs. A NaN here would
       * propagate into a NaN total, and `priceEvents` would then report a priced turn whose cost is
       * NaN — a number the UI would happily render.
       */
      priceTables: priceTables
        .filter((table) => table && typeof table === 'object')
        .map((table) => ({
          id: typeof table.id === 'string' && table.id ? table.id : crypto.randomUUID(),
          match: typeof table.match === 'string' ? table.match : '',
          label: typeof table.label === 'string' ? table.label : '',
          cacheMiss: Number(table.cacheMiss) || 0,
          cacheHit: Number(table.cacheHit) || 0,
          output: Number(table.output) || 0,
          peakMultiplier: Number(table.peakMultiplier) > 1 ? Number(table.peakMultiplier) : undefined,
        })),
    }
  } catch {
    return base
  }
}

const settings = ref<Settings>(load())

/**
 * Drop a default-model reference that no longer resolves.
 *
 * This is the fix for a real trap: a reference picked while the CLI's native model list was
 * visible (e.g. `sonnet[1m]`) kept applying to every new session after that list was hidden,
 * with no UI left to change or clear it — so the session ran on an Anthropic model name that
 * looked like it came from nowhere. A reference that cannot be resolved is stale by definition.
 */
function pruneStaleModelRef() {
  const ref = settings.value.defaultModelRef
  if (!ref) return

  const { providerId, model } = parseModelRef(ref)

  // A bare id can only be a CLI-native alias, and those are no longer selectable, so such a
  // reference is stale by definition. This is what clears a `sonnet[1m]` left behind by an older
  // build — otherwise it would keep applying invisibly with no UI able to change it.
  if (!providerId) {
    settings.value.defaultModelRef = ''
    return
  }
  const provider = settings.value.providers.find((entry) => entry.id === providerId)
  if (!provider || !provider.models.some((entry) => entry.model === model)) {
    settings.value.defaultModelRef = ''
  }
}

pruneStaleModelRef()

watch(
  settings,
  (value) => {
    try {
      // Keys are stripped unless the user opted into persisting them, so a stolen settings blob
      // does not hand over every credential.
      const sanitised: Settings = {
        ...value,
        providers: value.providers.map((provider) => ({
          ...provider,
          apiKey: provider.persistKey ? provider.apiKey : '',
        })),
      }
      localStorage.setItem(STORAGE_KEY, JSON.stringify(sanitised))
    } catch {
      /* storage full or blocked: settings simply do not persist */
    }
  },
  { deep: true },
)

/** One selectable model in the picker. */
export interface ModelOption {
  /** "providerId::model" for a model a configured provider serves. */
  ref: string
  model: string
  label: string
  providerId: string
  providerName: string
  /** Anthropic-compatible base URL this model is reached through. */
  baseUrl: string
  apiKey: string
  /** Reasoning effort pinned to this model, empty for the CLI's default. */
  effort: string
}

export function useSettings() {
  function presetById(id: string) {
    return PERMISSION_PRESETS.find((preset) => preset.id === id) ?? PERMISSION_PRESETS[1]
  }

  function activePreset() {
    return presetById(settings.value.permissionPreset)
  }

  function providerById(id: string) {
    return settings.value.providers.find((provider) => provider.id === id) ?? null
  }

  /** The provider new sessions use unless a model says otherwise. */
  function defaultProvider() {
    return (
      settings.value.providers.find((provider) => provider.isDefault) ??
      settings.value.providers[0] ??
      null
    )
  }

  /**
   * Every model the picker can offer: exactly the models of the configured providers.
   *
   * The CLI's own list is deliberately NOT merged in — those are Anthropic names that a relay
   * endpoint remaps server-side, so offering them would present the endpoint's decision as the
   * user's choice.
   */
  function modelOptions() {
    const options: ModelOption[] = []

    for (const provider of settings.value.providers) {
      for (const model of provider.models) {
        if (!model.model) continue
        options.push({
          ref: modelRef(provider.id, model.model),
          model: model.model,
          label: model.label || model.model,
          providerId: provider.id,
          providerName: provider.name,
          baseUrl: provider.baseUrl,
          apiKey: provider.apiKey,
          effort: model.effort ?? '',
        })
      }
    }

    // Only models a CONFIGURED provider actually serves. The CLI's own list is intentionally not
    // merged in: see the note on the Settings interface.
    return options
  }

  /** Resolve a stored reference back to the option it names, or null. */
  function resolveOption(ref: string): ModelOption | null {
    if (!ref) return null
    const options = modelOptions()
    const exact = options.find((option) => option.ref === ref)
    if (exact) return exact
    // Tolerate a bare model id by matching it against any provider.
    return options.find((option) => option.model === ref) ?? null
  }

  function addProvider(provider: Omit<Provider, 'id'>) {
    const created: Provider = { ...provider, id: crypto.randomUUID() }
    // The first provider becomes the default so a fresh setup needs no extra step.
    if (settings.value.providers.length === 0) created.isDefault = true
    settings.value.providers.push(created)
    return created
  }

  function updateProvider(id: string, patch: Partial<Omit<Provider, 'id'>>) {
    const provider = providerById(id)
    if (provider) Object.assign(provider, patch)
  }

  function removeProvider(id: string) {
    settings.value.providers = settings.value.providers.filter((provider) => provider.id !== id)
    // Re-point the default if the removed provider held it.
    if (settings.value.providers.length > 0 && !settings.value.providers.some((p) => p.isDefault)) {
      settings.value.providers[0].isDefault = true
    }
    if (parseModelRef(settings.value.defaultModelRef).providerId === id) {
      settings.value.defaultModelRef = ''
    }
  }

  function setDefaultProvider(id: string) {
    for (const provider of settings.value.providers) provider.isDefault = provider.id === id
  }

  // --- price tables ---------------------------------------------------------

  function addPriceTable(table: Omit<PriceTable, 'id'>) {
    const created: PriceTable = { ...table, id: crypto.randomUUID() }
    settings.value.priceTables.push(created)
    return created
  }

  function updatePriceTable(id: string, patch: Partial<Omit<PriceTable, 'id'>>) {
    const table = settings.value.priceTables.find((entry) => entry.id === id)
    if (table) Object.assign(table, patch)
  }

  function removePriceTable(id: string) {
    settings.value.priceTables = settings.value.priceTables.filter((entry) => entry.id !== id)
  }

  /**
   * Fill in one rate row from a provider's model list, so the common case is two clicks.
   *
   * Only `match` and `label` are seeded — the NUMBERS are deliberately left at zero. Guessing a
   * vendor's prices would produce exactly the failure this whole design avoids: a confident figure
   * that is wrong.
   */
  function seedPriceTable(providerId: string) {
    const provider = providerById(providerId)
    if (!provider) return null
    const first = provider.models[0]?.model ?? ''
    // Match on the vendor-ish prefix (everything before the first dash or space) so one row covers
    // the family: "qwen-max" -> "qwen", "glm-4.6" -> "glm".
    const prefix = first.split(/[-_\s/]/)[0] ?? ''
    return addPriceTable({
      match: prefix || first,
      label: provider.name,
      cacheMiss: 0,
      cacheHit: 0,
      output: 0,
    })
  }

  function addModel(providerId: string, model: Omit<ProviderModel, 'id'>) {    const provider = providerById(providerId)
    if (provider) provider.models.push({ ...model, id: crypto.randomUUID() })
  }

  function removeModel(providerId: string, modelId: string) {
    const provider = providerById(providerId)
    if (!provider) return
    const removed = provider.models.find((model) => model.id === modelId)
    provider.models = provider.models.filter((model) => model.id !== modelId)
    if (removed && parseModelRef(settings.value.defaultModelRef).model === removed.model) {
      settings.value.defaultModelRef = ''
    }
  }

  /** Pin a reasoning effort to one model; an empty level restores the CLI's model default. */
  function setModelEffort(providerId: string, modelId: string, effort: string) {
    const model = providerById(providerId)?.models.find((entry) => entry.id === modelId)
    if (model) model.effort = effort || undefined
  }

  function reset() {
    settings.value = defaults()
  }

  return {
    settings,
    DEFAULT_BASE_URL,
    PERMISSION_PRESETS,
    VENDOR_PRESETS,
    presetById,
    activePreset,
    providerById,
    defaultProvider,
    modelOptions,
    resolveOption,
    addProvider,
    updateProvider,
    removeProvider,
    setDefaultProvider,
    addPriceTable,
    updatePriceTable,
    removePriceTable,
    seedPriceTable,
    addModel,
    setModelEffort,
    removeModel,
    reset,
  }
}
