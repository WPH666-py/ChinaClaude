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
    id: 'web-mobile',
    name: 'dsh-web-mobile',
    version: '3.0.6',
    summary: '把本机会话搬到手机上：同一 Wi-Fi 下用手机浏览器或微信内置浏览器打开本机界面，查看并继续会话。',
    port: {
      kind: 'native',
      detail: '自建「手机访问」：桥托管与桌面同一套界面；loopback 免鉴权，非 loopback 必须先用配对码换取设备令牌；局域网监听默认关闭，开启后重启生效。',
      evidence: 'bridge/remote.mjs',
      endpoint: '/api/remote',
      feature: 'remote',
    },
  },
  {
    id: 'wechat',
    name: 'dsh-wechat',
    version: '0.10.0',
    summary: '把会话进展出站推送到企业微信群机器人：手机不用在线、无需公网或域名。',
    port: {
      kind: 'native',
      detail: '自建「微信通知」：企业微信群机器人 webhook，地址只存本机数据目录、界面仅回显掩码、仅 loopback 可改；推送默认关闭。',
      evidence: 'bridge/wechat.mjs',
      endpoint: '/api/wechat',
      feature: 'wechat',
    },
  },
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
    version: '1.8.2',
    summary: '代码管理面板：状态、差异、暂存、分支、储藏、提交历史，改动一眼看清，不用切到终端。',
    port: {
      kind: 'native',
      detail:
        '自建「代码管理」：git 以 argv 数组调用（不经 shell），支持状态 / 差异 / 暂存与取消暂存 / 分支列表与切换 / 储藏（保存·应用·弹出·删除）/ 提交；丢弃改动与删除储藏需要二次确认。推送、拉取、reset、clean -fdx 刻意不实现。未装 git 或目录不是仓库时明确说明而不是假装可用。',
      evidence: 'bridge/gitpanel.mjs',
      endpoint: '/api/git',
      feature: 'git',
    },
  },
  {
    id: 'workbench',
    name: 'dsh-workbench',
    version: '0.16.1',
    summary: '右侧工作台：工作区文件树、文件预览（文本 / Markdown / 图片）、全文搜索与变更审阅。',
    port: {
      kind: 'native',
      detail:
        '自建「工作台」：路径在工作区两侧做 realpath 收敛后才允许读写；tree / file / search / changes 四个端点与上游同名能力对应；变更审阅读 git，没有 git 时给一句话而不是空列表。不引入 CodeMirror，预览按纯文本渲染。',
      evidence: 'bridge/workbench.mjs',
      endpoint: '/api/workbench/tree',
      feature: 'workbench',
    },
  },
  {
    id: 'opencode-go',
    name: 'dsh-opencode-go',
    version: '0.1.25-pre',
    summary: 'OpenCode Go 网关：一把 Bearer Key 接入 DeepSeek / Qwen / MiniMax 等模型，按量计费。',
    port: {
      kind: 'native',
      detail:
        '自建「连接器」：上游自带 Anthropic 兼容路由（/inference/go/anthropic），因此能直接作为服务商给 claude.exe 用；模型目录与额度分别读 /v1/models 与 /v1/usage，应用后按模型写进模型列表。',
      evidence: 'bridge/connectors.mjs',
      endpoint: '/api/connectors',
      feature: 'connectors',
    },
  },
  {
    id: 'workbuddy',
    name: 'dsh-connect-workbuddy',
    version: '5.3.1',
    summary: '把本机已登录的 WorkBuddy 桌面端当作模型后端（国内版 / 国际版）。',
    port: {
      kind: 'native',
      detail:
        '登记 + 凭据探测 + **CLI 路由**：WorkBuddy 自带 CodeBuddy CLI，桥把 Anthropic 请求扁平化后调用 `codebuddy -p`（`--permission-mode dontAsk --tools ""`，只读），再把答案包回 Anthropic JSON / SSE。首次使用需在该 CLI 里 `/login` 一次（CLI 登录态与桌面 App 相互独立）；未登录返回 401 `unauthenticated`。',
      evidence: 'bridge/workbuddy.mjs',
      endpoint: '/proxy/workbuddy/v1/messages',
      feature: 'connectors',
    },
  },
  {
    id: 'office-tools',
    name: 'dsh-office-tools',
    version: '1.0.0',
    summary: '办公文件工具：让模型直接创建 / 读取 / 追加 Word 与 Excel，不用你在终端里拼脚本。',
    port: {
      kind: 'native',
      detail:
        '自建 MCP 服务（随包 node 启动，零依赖 OOXML 引擎）：word_create / word_read / word_update / excel_create / excel_read / excel_update 六个工具；路径限制在工作区内，overwrite 默认 false。桥只负责把 --mcp-config 交给 claude.exe，工具在 MCP 进程里执行。',
      evidence: 'bridge/mcp.mjs',
      endpoint: '/api/office',
      feature: 'office',
    },
  },
  {
    id: 'remote-ssh-ops',
    name: 'dsh-remote-ssh-ops',
    version: 'main',
    summary: '远程运维：SSH 主机管理、远程命令与文件读取，首次连接必须确认服务器指纹。',
    port: {
      kind: 'native',
      detail:
        '自建「远程运维」：调用系统 OpenSSH（ssh / ssh-keyscan），自带 known_hosts，首次连接先读指纹、由用户确认后才写入；未确认指纹的主机拒绝执行。仅支持密钥 / 代理认证 —— ssh 不能从管道读密码，所以不提供「填密码」这种必然失败的按钮。',
      evidence: 'bridge/ssh.mjs',
      endpoint: '/api/ssh',
      feature: 'ssh',
    },
  },
  {
    id: 'our-free-model',
    name: 'dsh-our-free-model',
    version: '2.1.0',
    summary: '无需 Key 的免费模型通道集合（OpenCode Zen / Kilo 免费池 + 13 个账号渠道），并提供本机 Anthropic 网关。',
    port: {
      kind: 'native',
      detail:
        '这是 DSH 插件，ChinaClaude 不能直接加载它；能复用的是它的**本机网关**：插件设置里的「本地转发」把 Anthropic 兼容的 /v1/messages 暴露在本机端口（独立服务默认 127.0.0.1:18900）。设置 → 模型 → 从 our-free-model 导入：填网关地址与它签发的 Key，即可把免费模型拉进列表并直接对话。未安装时按钮会提示去 DSH 里安装并开启本地转发。',
      evidence: 'bridge/server.mjs',
      endpoint: '/api/models/import',
      feature: 'connectors',
    },
  },
  {
    id: 'im',
    name: '@xmanrui/dsh-im',
    version: '5.1.0',
    summary: '消息通道：把进展推到企业微信 / 飞书 / 钉钉群（Webhook），凭据只存本机、界面只回显掩码。',
    port: {
      kind: 'native',
      detail:
        '自建「消息通道」：三个渠道的 incoming webhook（钉钉支持加签），只允许访问各自官方域名（防止被当成 SSRF 跳板）；响应永不回传 Webhook 令牌，写入仅限电脑端。官方机器人 SDK、长连接与 QQ / 微信渠道未接入。',
      evidence: 'bridge/im.mjs',
      endpoint: '/api/im',
      feature: 'im',
    },
  },
  {
    id: 'message-ops',
    name: 'dsh-message-ops',
    version: 'main',
    summary: '消息回滚：把会话退回到上一条用户消息之前，模型下一轮看不到被撤回的问答。',
    port: {
      kind: 'native',
      detail:
        '自建「消息回滚」：直接截断 Claude Code 的会话记录（~/.claude/projects/<项目>/<会话>.jsonl）到最后一条真实用户输入之前，再让会话以 --resume 重新加载。只回退整轮，不做逐条删除；工具结果不算用户消息，所以不会被误当成回滚点。会话正在写入时拒绝操作。',
      evidence: 'bridge/rollback.mjs',
      endpoint: '/api/rollback',
      feature: 'rollback',
    },
  },
  {
    id: 'ui-usage-billing',
    name: 'dsh-ui-usage-billing',
    version: 'main',
    summary: '用量与费用：把 token 用量和按价目表估算的花费放在同一页。',
    port: {
      kind: 'native',
      detail:
        '沿用本应用已有的「费用核算」页：按模型汇总输入/输出/缓存 token 与估算金额；价目表由用户自己填，不内置会过期的价格。这一项没有引入新的计费引擎，只是把它并入设置，替代原先分散在侧栏的读数。',
      evidence: 'bridge/cost.mjs',
      endpoint: '/api/cost',
      feature: 'cost',
    },
  },
  {
    id: 'modsearch',
    name: 'dsh-modsearch',
    version: 'main',
    summary: '网页搜索：在应用内直接搜，结果只回标题、链接与摘要。',
    port: {
      kind: 'native',
      detail:
        '自建「网页搜索」：桥向 DuckDuckGo 的 HTML 接口发起一次请求并解析结果，不需要 Key、不执行页面脚本、不抓取结果页正文。被限流时如实报错（对方返回验证页），不会把空结果伪装成「搜不到」。',
      evidence: 'bridge/search.mjs',
      endpoint: '/api/search',
      feature: 'search',
    },
  },
  {
    id: 'voice-mode',
    name: 'dsh-voice-mode',
    version: 'main',
    summary: '语音输入：把说的话变成输入框里的文字；输出仍由系统朗读能力负责。',
    port: {
      kind: 'native',
      detail:
        '输入框左侧的麦克风按钮走 WebView 自带的语音识别（Web Speech API），不经过桥、不上传音频到本应用以外的服务。系统没装中文语音包或权限被拒时，按钮会给出具体原因而不是静默失败。语音播报依赖同一套系统能力，当前只在识别方向接入。',
      evidence: 'web/src/components/Composer.vue',
      endpoint: 'window.SpeechRecognition',
      feature: 'voice',
    },
  },
  {
    id: 'qa-skills',
    name: 'dsh-qa-skills',
    version: 'main',
    summary: '代码测试：识别项目自带的测试命令，按一次跑一次并回显输出。',
    port: {
      kind: 'native',
      detail:
        '自建「代码测试」：只探测 package.json 的 test 脚本、pytest、go test、cargo test；命令先列出来、点了才执行，单次 3 分钟超时，不安装依赖、不进入 watch 模式。执行仅限电脑端。',
      evidence: 'bridge/qa.mjs',
      endpoint: '/api/qa',
      feature: 'qa',
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
