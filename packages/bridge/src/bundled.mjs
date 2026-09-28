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
    version: '0.1.0',
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

/** Everything the installer ships, in display order. */
export function bundledInventory() {
  return [...CORE_COMPONENTS, ...BUNDLED_COMPONENTS]
}

/**
 * Components that were deliberately NOT bundled, with the measured reason.
 *
 * Kept in the repo rather than only in a commit message: "why isn't X here" is a recurring
 * question, and the answer is a fact about the package, not an opinion.
 */
export const NOT_BUNDLED = [
  {
    name: 'dsh-cost-meter',
    reason: 'DSH-BOUND：CLI 与 UI 两条依赖链都进入 @deepseek-ai/dsh-*，无 DSH 运行时无法工作。',
    portable:
      '已按其思路自建费用核算：内置 DeepSeek 峰谷价目表，按轮计费并区分缓存命中/未命中；未沿用其 provider-pricing.json（14 个服务商中不含 DeepSeek）。',
  },
  {
    name: '@jieai/dsh-plugin-vet',
    reason: 'CLI 外壳 DSH-BOUND（gate.js → tools/scan-plugin.js → @deepseek-ai/dsh-tools）。',
    portable: '静态扫描引擎 lib/scanner-bin/** 零 DSH 依赖，已原样内置为「设置 → 安全审计」。',
  },
  {
    name: 'dsh-vision-router',
    reason: '主体是 DSH LLM provider 包装；doctor CLI 可移植但功能与 modlens 重叠。',
    portable: '无独有能力需要内置。',
  },
  {
    name: 'dsh-chat-import',
    reason:
      '可移植的 CLI 部分（export-md / doctor）面向 DSH 会话存储，本应用没有这种存储；完整导入路径需要 DSH 宿主。',
    portable:
      '已按其思路自建「设置 → 导入会话」：直接读取 Claude Code 自己的 projects/*.jsonl，用 --resume 继续，并同样支持导出 Markdown。',
  },
]

void bundledInventory
