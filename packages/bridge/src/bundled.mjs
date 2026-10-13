/**
 * Registry of what this client bundles, and under what terms.
 *
 * WHY A REGISTRY RATHER THAN DERIVING IT: the CLI reports what it LOADED (skills, plugins, MCP
 * servers) but not what the INSTALLER shipped, and the two are not the same — a bundled skill
 * can fail to load, and a file can ship without any loader knowing about it. An inventory that
 * cannot show a broken bundle is useless for the question users actually ask ("what did this
 * install bring?").
 *
 * Each entry therefore carries the evidence path so the UI can report presence independently of
 * the runtime, and `loadedAs` so it can be cross-checked against what the session actually got.
 */

/** Third-party components redistributed inside the installer. */
export const BUNDLED_COMPONENTS = [
  {
    id: 'modlens',
    name: 'ModLens',
    kind: 'skill',
    package: '@liustack/modlens',
    version: '3.26.5',
    homepage: 'https://github.com/liustack/modlens',
    license: 'MIT',
    author: 'liustack',
    summary: '给纯文本模型装上视觉：把图片转成结构化 JSON 证据（逐字转写、版面区域、语义）。',
    /**
     * How the CLI should report it once loaded. Cross-checking this against the runtime is the
     * whole point: a mismatch means the bundle is present but not actually active.
     */
    loadedAs: { kind: 'skill', name: 'modlens' },
    /** Relative to the sidecar root; presence here proves the file shipped. */
    evidencePath: 'skills/.claude/skills/modlens/SKILL.md',
    /** What the user must do before it can do its job. */
    setupHint: '需要一个视觉 provider（Gemini / OpenAI 兼容 / Claude CLI 等），运行 modlens doctor 查看缺什么。',
    /** Vendored in-repo so a build needs no network. */
    vendored: true,
  },
]

/** First-party shell components, listed so the inventory is complete rather than third-party-only. */
export const CORE_COMPONENTS = [
  {
    id: 'bridge',
    name: '会话桥',
    kind: 'core',
    version: '0.2.0',
    summary: '本地 Node 进程：管 claude.exe 会话、控制通道（审批/对话框）、HTTP + SSE 接口。',
    evidencePath: 'bridge/cli.mjs',
  },
  {
    id: 'runtime',
    name: 'Node 运行时',
    kind: 'core',
    // `process.version` already carries the leading "v"; strip it so the UI can add its own.
    version: process.version.replace(/^v/, ''),
    summary: '随包携带的 node.exe，保证目标机器无需预装 Node。',
    evidencePath: 'node.exe',
  },
  {
    id: 'vet-engine',
    name: '插件审计引擎',
    kind: 'core',
    version: 'static-v26',
    summary: '内置 @jieai/dsh-plugin-vet 的静态扫描引擎（20 条规则）：在信任第三方插件/技能前先审计。',
    /**
     * Presence is proven by the ENGINE entry point, not by `node_modules/typescript`: the engine
     * resolves its one dependency relative to itself, so a missing typescript shows up as a failed
     * scan rather than a missing file, and `scannerStatus()` reports that case explicitly.
     */
    evidencePath: 'vet/scanner-bin/index.js',
  },
]

/**
 * The upstream plugin set this client was asked to build in, one entry per plugin.
 *
 * WHY THE UPSTREAM NAME AND VERSION ARE RECORDED EVEN WHEN NOTHING OF THE PACKAGE SHIPPED: the
 * question "did you build in dsh-cost-meter?" has two different true answers — "yes, its capability"
 * and "no, its code" — and a list that only says "内置" hides which one applies. `port.kind` states
 * it, `port.evidence` names the file that proves a native implementation exists, and `port.endpoint`
 * names the route that exposes it, so every claim in this window can be checked from outside.
 *
 * Versions are the ones observed on the reference machine (`~/.dsh/profiles/desktop`), which is what
 * a port is written against; where the vendored copy differs, `vendoredVersion` says so.
 */
export const BUILTIN_PLUGINS = [
  {
    id: 'vet',
    name: '@jieai/dsh-plugin-vet',
    version: '0.3.12',
    summary: '第三方插件/技能的静态审计：20 条规则扫逃逸、动态执行、硬编码密钥、供应链风险。',
    port: {
      kind: 'vendored',
      detail: 'CLI 外壳 DSH-BOUND，静态扫描引擎零 DSH 依赖，原样内置为「设置 → 安全审计」。',
      evidence: 'vet/scanner-bin/index.js',
      endpoint: 'POST /api/vet/scan',
      feature: 'audit',
    },
  },
  {
    id: 'modlens',
    name: '@liustack/modlens',
    version: '3.26.1',
    vendoredVersion: '3.26.5',
    summary: '给纯文本模型装上视觉：图片 → 结构化 JSON 证据（逐字转写、版面区域、语义、不确定项）。',
    port: {
      kind: 'vendored',
      detail: '随包携带为技能，并新增桥接端点，可直接对某张图片取证据。',
      evidence: 'skills/.claude/skills/modlens/SKILL.md',
      endpoint: 'POST /api/vision/read',
      feature: 'vision',
    },
  },
  {
    id: 'hindsight',
    name: '@vectorize-io/hindsight-coding-agents',
    version: '0.8.0',
    summary: '跨会话记忆：把项目里定下来的事实、决定和坑存下来，下个会话直接用，不重复推导。',
    port: {
      kind: 'native',
      detail: '自建「项目记忆」：按工作目录存条目，新建会话时经 --append-system-prompt 注入（上限 4000 字，最近的优先）。',
      evidence: 'bridge/memory.mjs',
      endpoint: '/api/memory',
      feature: 'memory',
    },
  },
  {
    id: 'billion-context',
    name: 'billion-context-dsh',
    version: '0.2.26',
    summary: '上下文管理：看清 token 用量与缓存命中，需要时主动压缩，而不是等到被截断。',
    port: {
      kind: 'native',
      detail: '自建「上下文」：按本会话事件统计输入/输出/缓存命中，一键触发 CLI 的 /compact。',
      evidence: 'bridge/context.mjs',
      endpoint: 'GET /api/context',
      feature: 'context',
    },
  },
  {
    id: 'chat-import',
    name: 'dsh-chat-import',
    version: '0.17.1',
    summary: '把历史对话导进来继续：读磁盘上已有的会话，按工作目录分组，可继续可导出。',
    port: {
      kind: 'native',
      detail: '自建「导入会话」：直读 Claude Code 自己的 projects/*.jsonl，用 --resume 继续。',
      evidence: 'bridge/transcripts.mjs',
      endpoint: 'GET /api/transcripts',
      feature: 'import',
    },
  },
  {
    id: 'cost-meter',
    name: 'dsh-cost-meter',
    version: '1.7.28',
    summary: '费用核算：按轮计价，区分缓存命中与未命中，按服务商价目表折算成人民币。',
    port: {
      kind: 'native',
      detail: '自建计价：内置 DeepSeek 峰谷价目表，按轮结算并区分缓存命中/未命中。',
      evidence: 'bridge/pricing.mjs',
      endpoint: 'GET /api/sessions/:id/cost',
      feature: 'cost',
    },
  },
  {
    id: 'rule-engine',
    name: 'dsh-rule-engine',
    version: '0.6.4',
    summary: '规则引擎：把「这种情况要这样做」写成规则，命中时给标签、给提示，必要时补进提示词。',
    port: {
      kind: 'native',
      detail: '自建「规则引擎」：规则存本机，发送前在桥里判定 —— 命中即标注、可追加提示、拦截会先请你确认一次。',
      evidence: 'bridge/rules.mjs',
      endpoint: '/api/rules',
      feature: 'rules',
    },
  },
  {
    id: 'defend',
    name: 'dsh-defend',
    version: '0.3.21',
    summary: '安全防护：在工具结果流出前扫一遍，命中密钥、危险命令就拦下来并留痕。',
    port: {
      kind: 'native',
      detail: '自建「安全防护」：扫会话事件与待发送内容；拦截级命中会在发送前请你确认一次，记录里只留隐去后的片段。',
      evidence: 'bridge/defend.mjs',
      endpoint: '/api/defend',
      feature: 'defend',
    },
  },
  {
    id: 'time-machine',
    name: '@goodandready/dsh-time-machine',
    version: '0.1.22',
    summary: '工作区检查点：改动前拍一张快照，跑歪了可以比对差异并回滚单个文件。',
    port: {
      kind: 'native',
      detail: '自建「时间机器」：快照存在本机数据目录，支持列出、比对、单文件回滚；不依赖 git。',
      evidence: 'bridge/checkpoints.mjs',
      endpoint: '/api/checkpoints',
      feature: 'time-machine',
    },
  },
  {
    id: 'git-panel',
    name: '@xbzbing/dsh-git-panel',
    version: '1.4.0',
    summary: '代码管理面板：状态、差异、提交历史，改动一眼看清，不用切到终端。',
    port: {
      kind: 'native',
      detail: '自建「代码管理」：调用本机 git 读状态/差异/历史；未装 git 时明确说明而不是假装可用。',
      evidence: 'bridge/gitpanel.mjs',
      endpoint: '/api/git',
      feature: 'git',
    },
  },
]

/** Everything the installer ships, in display order. */
export function bundledInventory() {
  return [...CORE_COMPONENTS, ...BUNDLED_COMPONENTS]
}

/**
 * The 插件管理 window's list: one row per upstream plugin, with the port described.
 *
 * Shape kept deliberately identical to the reference app's plugin list (name, version, and a
 * 内置 badge per row) so the two windows read the same, plus the fields that make the badge
 * checkable.
 */
export function builtinPluginList() {
  return BUILTIN_PLUGINS.map((plugin) => ({
    id: plugin.id,
    name: plugin.name,
    version: plugin.version,
    vendoredVersion: plugin.vendoredVersion ?? null,
    bundled: true,
    summary: plugin.summary,
    port: plugin.port,
  }))
}

/** One plugin's port record, for the feature panels that want to name their own provenance. */
export function pluginById(id) {
  return BUILTIN_PLUGINS.find((plugin) => plugin.id === id) ?? null
}

/**
 * Components that were deliberately NOT bundled, with the measured reason.
 *
 * Kept in the repo rather than only in a commit message: "why isn't X here" is a recurring
 * question, and the answer is a fact about the package, not an opinion.
 */
export const NOT_BUNDLED = [
  {
    name: 'dsh-vision-router',
    reason: '主体是 DSH LLM provider 包装；doctor CLI 可移植但功能与 modlens 重叠。',
    portable: '无独有能力需要内置。',
  },
]

void bundledInventory
