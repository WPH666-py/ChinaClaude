# ChinaClaude 0.3.0

**一句话**：把 DSH 生态里的「工作台」和「服务商连接器」按 Harness-CN 的做法做进客户端 —— 工作区文件树 / 预览 / 搜索 / 变更审阅，以及 OpenCode Go 一把 Key 直连。

安装包（二选一，都是单文件、离线可用）：

| 文件 | 安装方式 |
| --- | --- |
| `ChinaClaude_0.3.0_x64-setup.exe` | NSIS，当前用户安装，不需要管理员 |
| `ChinaClaude_0.3.0_x64_zh-CN.msi` | MSI，装到 `Program Files`，需要管理员 |

---

## 新增：工作台（`dsh-workbench` 0.16.1）

对话右侧多一个「工作台」窗口，用来回答「这个工作区里有什么、这个文件长什么样、这次改了什么」：

- **文件树**：一次只列一层，`node_modules` 这类重目录标出来但不展开；面包屑与上级导航；
- **预览**：文本（带行号）、Markdown（只读渲染）、图片（内联 data URL）；超过 1 MB 的文本只给前 1 MB 并明说；
- **搜索**：工作区内按子串找，跳过二进制与大文件，命中带 `路径:行号`；
- **变更**：读 git 的状态与差异；没装 git 或目录不是仓库时给一句话和安装提示，**不是**一个看起来"没有改动"的空列表。
- **按轮差异**：桥在每次 `tool_use`（Write / Edit / MultiEdit / NotebookEdit）**执行前**把该文件的前像快照到数据目录，之后用前像与当前内容算行级 diff；「变更」页可以按轮次切换，看到这一轮到底改了哪几行。同一轮里第二次写同一文件不会覆盖前像（否则只能看到最后一次编辑）；超过 4 MB 的文件标记为「未快照」并说明原因，不会从列表里消失。

路径安全是这一块的底线：每次请求的 `cwd` 与相对路径都在桥里做 `realpath` 双侧收敛，`..`、绝对路径、符号链接越界一律拒绝 —— 页面永远不能用一个编出来的路径读到工作区外面。

## 新增：连接器（`dsh-opencode-go` 等 3 个上游）

「插件管理 → 连接器」窗口现在有三行，状态是**当场探测**的，不是写死的：

| 上游 | 状态 | 说明 |
| --- | --- | --- |
| `dsh-opencode-go` | 可用 | 上游自带 Anthropic 兼容路由（`/inference/go/anthropic`），填一把 Bearer Key 即可：拉模型目录 → 加入模型列表，另可查额度 |
| `dsh-connect-workbuddy` | **CLI 路由** | 桌面端 token 加密不可读，但 WorkBuddy 自带 CodeBuddy CLI：桥把 Anthropic 请求扁平化后调 `codebuddy -p`（`dontAsk`、`--tools ""` 只读），把答案包回 Anthropic JSON / SSE。首次需在 CLI 里 `/login` 一次；未登录返回 401 `unauthenticated` |
| `dsh-connect-trae` | 只登记 | 本机实测：`storage.json` 无 token、`state.vscdb` 328 个键里只有 GitHub secret、没有对话 CLI（`trae.cmd` 只启 IDE、`ctx-cli.exe` 是上下文工具）、`ahanet/server.json` 是 TNC DNS 配置。没有真实报文前不做猜测式代理 |

**为什么不给 trae 一个"能用"的假象**：本应用只讲一种协议（Anthropic Messages），Trae 需要先在本机加一层翻译代理才可能接通，而它的登录态既不在可读文件里、也没有官方 CLI。把不可用的东西标成可用，用户第一次发消息就会失败 —— 那正是这个项目已经付过一次代价的失败方式（0.2.2 的"双击没反应"）。所以界面直说"只登记、不接管对话"，并把原因和上游仓库链接一起给出。

**WorkBuddy 路由是怎么验的**：CLI 在未登录时**退出码为 0**、只在 stderr 写 `Authentication required` —— 只看退出码会得到「成功但空回答」。已按 stderr 判定并加回归用例；用假 CLI 验证 JSON/SSE 两种回转，用真 CLI 验证 401 与 `unauthenticated` 文案；面板上的「测试 CLI 连接」会真跑一次并以结果区分登录/未登录。

**凭据探测 + 代理骨架**：面板上的「探测本机凭据」只读地检查本机登录文件，回答"装没装、文件在哪、有没有可读的 `accessToken/refreshToken`"，**从不返回 token 值**；`GET /api/connectors/proxy?id=…` 给出代理状态（`not-needed` / `blocked-on-credential` / `blocked-on-protocol`），`POST /api/connectors/proxy` 是将来代理的入口，今天一律 **501 + `code: not-implemented`** 并说明缺什么。骨架存在的意义是把能力边界写进代码，而不是写进 README 的一句话。

## 代码管理（`@xbzbing/dsh-git-panel` 1.8.2）：暂存 / 分支 / 储藏

- **暂存与取消暂存**：可整组暂存，也可选中某个文件单独操作（文件行是按钮，嵌套按钮在 HTML 里不合法，所以动作放在差异面板下方）；
- **分支**：列出本地与远程分支并标记当前分支，切换远程分支时按 `--track` 建本地跟踪分支；不提供 `--force`，git 拒绝就是答案；
- **储藏**：保存（可带备注）、应用、弹出、删除；删除需要二次确认；
- **丢弃改动**：只对当前选中的文件，且要点第二次（5 秒内有效）才执行；
- 所有写操作仍是 argv 数组、`shell:false`、cwd 固定；`push / pull / reset / clean -fdx` 刻意不实现。

诚实说明：这台开发机**没有 git**，所以端到端往返（真建仓库、真暂存、真储藏）在这次交付里是 **SKIP**，由 `git-ops` 套件在装了 git 的机器上补齐；已经通过的是不依赖 git 的那部分——通配符拒绝、空列表拒绝、二次确认强制、非仓库降级文案，以及完全没有 git 时的「未安装」路径（11/11）。

## 新增：办公工具（`dsh-office-tools`，走 MCP）

给模型加了一条真正能落盘的办公文件通道，而不是又一个界面按钮：

- 随包一个**零依赖 MCP 服务**（`bridge/mcp.mjs`），由桥写好 `--mcp-config` 交给 `claude.exe`，会话启动时自动加载；
- 九个工具：`word_create` / `word_read` / `word_update` / `excel_create` / `excel_read` / `excel_update` / `ppt_create` / `ppt_read` / `ppt_update`；
- 自研 OOXML 引擎（`bridge/ooxml.mjs`）：自己写 ZIP 容器 + WordprocessingML / SpreadsheetML / PresentationML（含 master、layout、theme），**不新增任何 npm 依赖**；
- `excel_update` 与 `ppt_update` 是**就地改包**：只改被编辑工作表的 `<sheetData>` 或追加幻灯片，其余部件按原始字节复制 —— 样式、图表、条件格式、批注与未知部件因此不会被重建过程丢掉（测试逐字节比对未编辑部件）。
- 每个会话的 MCP 配置把 `CCCN_MCP_ROOT` 钉在该会话的工作区上，模型给的相对路径先做 realpath 收敛，越界一律拒绝；同名文件默认不覆盖。

实测：真起桥 + 真 `claude.exe`，会话 `init` 帧里 `mcp_servers` 为 `[{name:"cccn-office",status:"connected"}]`，工具列表出现 `mcp__cccn-office__word_create` 等八个；直接跑 MCP 服务能建出 `report.docx` / `budget.xlsx` / `deck.pptx` 并读回。

## 新增：远程运维（`dsh-remote-ssh-ops`）

- 主机存储（备注名 / 主机 / 端口 / 用户 / 私钥路径），存在本机数据目录；
- **首次连接必须确认指纹**：先 `ssh-keyscan` 读取服务器公钥，面板显示 `SHA256:…` 让你核对，确认后才写入自带的 `known_hosts`；没有确认过指纹的主机，执行会被桥直接拒绝；
- 远程命令（超时、输出上限、失败原因逐条翻译）与远程文件读取（`cat --` + 远端 shell 单引号转义）；
- 只支持密钥 / ssh-agent 认证：`ssh` 不能从管道读密码，所以不提供「填密码」这种点了必然失败的按钮；
- 所有写操作仅限电脑端（loopback），手机端连「添加主机」都会被 403 挡住。

## 新增：消息通道（`@xmanrui/dsh-im`）

- 五个渠道的 incoming webhook：企业微信群机器人、飞书自定义机器人、钉钉自定义机器人（支持加签）、Slack Incoming Webhook、Discord Webhook；
- 每个渠道**只允许访问自己的官方域名**（`qyapi.weixin.qq.com` / `open.feishu.cn` / `oapi.dingtalk.com` / `hooks.slack.com` / `discord.com`）：绑定的桥对手机开放，没有这条白名单，一个「发消息」接口就会变成打用户内网的 SSRF 跳板；
- 响应**永不回传 Webhook 令牌**，只给 `host…#摘要`；写操作仅限电脑端；
- 平台级失败会被如实报出：HTTP 200 但 `errcode != 0` 也算失败（这正是一句「推送成功」谎言的来源）；
- **机器人长连接**：Telegram `getUpdates` 长轮询与 Matrix `/sync`，两者都只用 HTTPS、不需要公网地址或 SDK；聊天必须显式绑定会话，未绑定时机器人回复「还没绑定」，不会猜一个会话；Telegram 记录 `update_id` 偏移、Matrix 记录 `since`，重启不重放旧消息；失败按 2s→60s 指数退避，凭证被吊销也不会打成热循环；
- QQ / 微信必须官方 SDK 与应用审核，桌面端无法只靠 HTTPS 接入——面板点名列出，不假装有。

实测（真实请求，假 Key）：配置写入后 `masked = qyapi.weixin.qq.com…#8ab96343`；向企业微信发测试消息，平台返回 `93000 invalid webhook url`，面板如实显示「平台拒绝了这条消息（93000）…」——请求确实到达了腾讯，失败原因是密钥为假。

## 验证

- `node packages/bridge/test/ooxml.mjs` — 29 项（ZIP 往返、docx 标题/段落/项目符号/表格、xlsx 多表/数字/公式、pptx 页与要点、追加与按 A1 写入、坏文件拒绝）；
- `node packages/bridge/test/mcp.mjs` — 24 项（initialize / tools/list 八个工具 / 工具调用真实落盘 / 覆盖保护 / 路径越界 / 未知方法）；
- `node packages/bridge/test/office.mjs` — 6 项（工具表与 MCP 服务声明一致、配置缺失时说不可用）；
- `workbench` 28/28、`connectors` 23/23、`git-ops` 11/11（+1 SKIP）复跑通过；`vue-tsc` 零错误；
- 会话级集成探针：init 帧 `mcp_servers` 已连接、八个工具出现。

## 已知限制

- 工作台的变更审阅只有 git 一个来源；时间机器快照与"按轮差异"留给下一批；
- 连接器只对 `opencode-go` 提供对话路由；workbuddy / trae **经确认保持「只登记」**——上游是专有 SSE + 本机 App 凭据（本机 Trae CN 的 `storage.json` 里确实没有 accessToken/refreshToken 字段），做翻译代理需要新的协议工程，不在本版范围；
- 工作台预览不做语法高亮（不引 CodeMirror，包体与启动时间优先）；
- git 的端到端往返未在本机验证（本机无 git），需在有 git 的机器上跑一次 `git-ops`；
- 办公工具覆盖 Word / Excel / PowerPoint 的建、读与追加（`word_update` / `excel_update` / `ppt_update`）；
- 写入端不做样式、图片、页眉页脚；`excel_update` 与 `ppt_update` 已改为**就地改包**（只改被编辑的工作表 `<sheetData>` / 追加幻灯片，其余部件按原始字节复制），因此样式、图表、批注与未知部件不会再被重建过程丢掉。

## 接入侦察（Trae / WorkBuddy）

详细的本机实测结论见 [TRAE-WORKBUDDY-RECON.md](TRAE-WORKBUDDY-RECON.md)。要点：

- **WorkBuddy** 走自带 CodeBuddy CLI：`/proxy/workbuddy/v1/messages` 把 Anthropic 请求翻译成一次 `codebuddy -p`，答案回转成 Anthropic JSON / SSE；首次需在该 CLI 里 `/login`。未登录时 CLI **退出码为 0**、只在 stderr 报错，已按 stderr 判定为 `401 unauthenticated`；
- **Trae** 没有对话 API、没有对话 CLI、登录态加密不可读（`storage.json` 里是 opaque 串，`state.vscdb` 只有 GitHub secret，`ctx-cli.exe` 是文件操作工具，`ahanet` 是 DNS 配置）。可用的是官方支持的反向 MCP 接入：`GET /api/connectors/trae/integration` 给出可直接粘贴的 stdio 服务器片段，让 Trae 调用本应用的工具。

## 界面改造：右侧工作台 / 三标签 / 服务器管理（0.3.0 增补）

- **主区三标签**：对话 / 轨迹 / Git 可切换；Git 打开代码管理（暂为面板形态，内嵌视图在下一版拆出）。
- **工作台改为右侧常驻侧栏**：菜单栏「工作台」切换右侧 440px 侧栏，中间区让出宽度而不是被遮盖；收起后右侧保留竖排入口条，随时可再打开。
- **顶部菜单**：去掉品牌字段与「退出」，新增「服务器管理」（`/api/health` 的桥状态：协议版本 / 应用版本 / 桥地址 / 上游地址 / 凭据 / 活动会话）。
- **连接器状态**：WorkBuddy / Trae 的 `state` 现在把本机 CLI 视为检测证据，返回 `route: "cli"` 与 CLI 路径；文案改为实际的 CLI 路由说明（`codebuddy -p` / `traecli exec`），不再显示「未安装 / 不可路由」。
- **验证**：`vue-tsc` 0 错误、`connectors` 45/45、`verify:bundle` 全绿（内嵌 WebView2）。

## 模型一键导入 / 内置 git / 内嵌 Git 视图

- **模型页导入**：设置 → 模型 新增「从 Trae 导入模型」「从 WorkBuddy 导入模型」「从 opencode 导入模型」三个按钮，走 `POST /api/models/import`；导入的是指向本桥 `/proxy/trae`、`/proxy/workbuddy` 的行（opencode 用 Key 拉真实模型目录），重复导入不会产生重复行。
- **内置便携版 git**：`vendor/git`（MinGit 2.56.0，GPL-2.0）随包进入 `sidecar/git`；`gitpanel.mjs` 的发现顺序是 `CCCN_GIT` → 随包 git → PATH → 系统安装目录，因此没装 git 的机器也能直接用 Git 标签。
- **Git 内嵌视图**：`ShellDialog` 增加 `inline` 形态（无遮罩、静态定位），Git 标签在中间区直接渲染 `GitPanel`，不再浮层。
- 说明：Trae 的登录状态可实时读到（`traecli login status`）；WorkBuddy CLI 没有 `status` 子命令，所以卡片显示「未验证」，需要点一次「测试 CLI 连接」才知道是否已登录——这一点没有用假状态糊过去。

## WorkBuddy 登录状态的显示方式（诚实版）

- **Trae**：`traecli login status` 可实时读，卡片显示「已登录/未登录」；
- **WorkBuddy**：CLI 没有 `status` 子命令（`doctor` 返回 `No mapping found`），`~/.codebuddy` 里也没有明文凭据可读。因此桥只记录**上一次「测试 CLI 连接」的结果**（`%LOCALAPPDATA%\ChinaClaude\cli-status.json`），卡片显示「上次测试：已登录/未登录 · 时间」。这不是实时状态，卡片文案也这么写，避免用猜测冒充事实。
