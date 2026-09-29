# Claude Code · CN

把 Claude Code 做成一个可双击运行的 Windows 桌面客户端。界面与功能参照 Harness-CN，
后端接国内可达的 Anthropic 兼容端点。

**技术栈**：Vue 3 + Node 桥接进程 + Tauri 2（WebView2）。没有 Electron。

---

## 为什么不是 Electron

调查过程中确认的一个关键事实：Claude Code 现在的分发形态是**原生二进制**，而且它的
CLI 自带 stdio 流式协议。这意味着桌面端不需要改二进制、也不需要 Electron 那套
自定义协议 + 管道 IPC —— 一个普通 HTTP + SSE 的本地桥就够了。

| | Electron（Harness-CN 路线） | 本项目 |
| --- | --- | --- |
| 渲染内核 | 打包 Chromium（约 100 MB+） | 复用系统 WebView2 |
| 前后端通信 | `dsh-app://` 自定义协议 + 分帧管道 IPC | 本地 HTTP + SSE |
| 外壳代码 | ~1500 行 Electron 专用逻辑 | ~200 行 Rust |
| 外壳职责 | 协议代理、反向转发请求 | 只负责拉起子进程和进程生命周期 |

外壳**不代理任何业务流量**：webview 直接访问 `127.0.0.1:<port>`。这是能砍掉整套
Electron 传输层的原因。

---

## 架构

```
┌─────────────────────────────────────────────────────────┐
│ Tauri 外壳 (Rust, ~200 行)                               │
│  · spawn _sidecar/node.exe bridge/cli.mjs --port 0        │
│  · 读 CCCN_READY {...} 握手拿到端口                       │
│  · 注入 window.__CCCN_BRIDGE_URL__ 后加载 webview          │
│  · 退出时 kill 子进程                                     │
└───────────────────────┬─────────────────────────────────┘
                        │ 只传一个 URL，之后不再介入
                        ▼
┌─────────────────────────────────────────────────────────┐
│ WebView2：Vue 3 界面                                     │
│  fetch /api/*  +  读 SSE /api/sessions/:id/events         │
└───────────────────────┬─────────────────────────────────┘
                        │ HTTP + SSE（127.0.0.1）
                        ▼
┌─────────────────────────────────────────────────────────┐
│ Node 桥 (packages/bridge，零 npm 依赖)                    │
│  · 会话管理：spawn claude.exe，NDJSON 双向流               │
│  · 事件归一化：原始行 → UI 可直接渲染的事件                 │
│  · 环境发现：找 claude.exe、读 ~/.claude.json              │
└───────────────────────┬─────────────────────────────────┘
                        │ stdio: --input-format/--output-format stream-json
                        ▼
┌─────────────────────────────────────────────────────────┐
│ claude.exe (官方原生二进制，签名有效，未做任何修改)          │
└───────────────────────┬─────────────────────────────────┘
                        │ POST /v1/messages
                        ▼
               DeepSeek Anthropic 兼容端点
               https://api.deepseek.com/anthropic
```

---

## 封禁点与解法

调查结论（均有实测支撑，详见 `封禁点分析与解法.md`）：

1. **安装源不可达** → 官方包在 npmmirror 完整同步；`registry.npmjs.org` 与
   `static.rust-lang.org` 在本机均不可达，故 npm/rustup/crates.io 全部走国内镜像。
2. **API 端点不可达** → 不改客户端，改端点。DeepSeek 官方提供 Anthropic 兼容入口，
   并在服务端自动映射模型名（`claude-opus*`→`deepseek-v4-pro`，
   `claude-sonnet*`/`claude-haiku*`→`deepseek-flash`）。
3. **二进制不可 patch** → 231 MB、Authenticode 签名有效。改签名会失效且毫无必要：
   官方就提供了 `ANTHROPIC_BASE_URL` 重定向面，已实测生效。

**两个必须记住的实现细节**（实测抓包所得）：

- CLI 启动时会探测 `HEAD /api/hello`。自建中转只实现 `/v1/messages` 会导致启动阶段失败。
- 每轮请求约 70 KB system prompt。DeepSeek 端点忽略 `cache_control`，即**无 prompt 缓存**，
  成本会显著高于官方端点 —— 界面因此显示 token 用量。
  **（此条已被实测推翻，见下方更正。）**
- **更正**：上面那条是照文档推断的，实际是**错的**。DeepSeek 忽略的是显式的 `cache_control`
  标记，不是缓存本身 —— 服务端自动 KV 缓存照常生效。实测一轮真实请求报告
  `输入 10,831 · 输出 536 · 缓存命中 68,736`。界面保留缓存命中数就是为了能持续核对这类
  文档与实现的差距。

---

## 目录

```
packages/
  bridge/              零依赖 Node 桥
    src/session.mjs      单个会话：spawn、解析、归一化事件
    src/server.mjs       HTTP + SSE 接口
    src/discovery.mjs    找 claude.exe、读 CLI 配置
    src/cli.mjs          入口 + CCCN_READY 握手
    test/                端到端与 UI 流程验证
  web/                 Vue 3 界面
    src/composables/useBridge.ts   与桥交互的唯一出口
    src/components/                Sidebar / Transcript / ToolCard / Composer
  desktop/             Tauri 外壳
    src-tauri/src/main.rs          进程生命周期 + 握手 + URL 注入
    scripts/prepare-sidecar.mjs    暂存运行时与桥
_sidecar/              构建产物：node.exe + bridge/
```

---

## 桥的接口

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/health` | 存活、二进制路径、端点、凭据状态 |
| GET | `/api/discovery` | 发现结果：claude.exe、`~/.claude.json`、运行时、最近项目 |
| GET | `/api/directories/roots` | 目录选择器的快速访问项（主目录/桌面/文档/下载/盘符） |
| GET | `/api/directories?path=&hidden=` | 列出一级子目录；`hidden=1` 显示点目录与系统 junction |
| GET | `/api/sessions` | 会话列表 |
| POST | `/api/sessions` | 建会话；body 可含 `cwd/baseUrl/authToken/model/permissionMode` |
| GET | `/api/sessions/:id/events` | SSE 事件流（可重连，先补发历史） |
| POST | `/api/sessions/:id/messages` | 发送一轮用户输入（回合进行中返回 409） |
| GET | `/api/sessions/:id/permissions` | 当前待审批的工具调用 |
| POST | `/api/sessions/:id/permissions` | 应答审批：`{requestId, behavior:'allow'\|'deny', scope:'once'\|'session'}` |
| GET | `/api/sessions/:id/catalog` | 技能 / 子代理类型 / 模型能力（来自 initialize 回复） |
| POST | `/api/sessions/:id/model` | 切换运行中会话的模型：`{model}`；空值 = 重置为会话默认 |
| POST | `/api/sessions/:id/permission-mode` | 切换运行中会话的权限模式：`{mode}` |
| GET | `/api/sessions/:id/dialogs` | 当前待应答的宿主对话框 |
| POST | `/api/sessions/:id/dialogs` | 应答对话框：`{requestId, behavior:'completed'\|'cancelled', result?}` |
| DELETE | `/api/sessions/:id` | 关闭会话（结束子进程 stdin 后强杀） |
| DELETE | `/api/sessions/:id?purge=1` | **移除**会话（列表里不再出现） |
| GET | `/api/sessions/:id/cost` | 本会话费用：按轮计价，返回 `{cost, model, currency:'CNY'}` |
| GET | `/api/transcripts?q=` | 磁盘上已有的 Claude Code 历史会话，按工作目录分组 |
| POST | `/api/transcripts/export` | 把一个历史会话导出为 Markdown：`{sessionId}` |
| GET | `/api/vet/status` | 审计引擎是否可用，以及规则集版本 |
| POST | `/api/vet/scan` | 审计一个目录：`{path, scanBasis?, osv?}` |
| POST | `/api/attachments` | 保存附件（base64），返回可直接交给 agent 的绝对路径 |
| GET | `/api/attachments` | 附件用量（数量与总字节） |
| DELETE | `/api/attachments` | 清空附件目录 |
| POST | `/api/balance` | 读取服务商账户余额：`{baseUrl, apiKey, balanceUrl?, balancePath?}` |

事件类型：`init` `thinking` `thinking_tokens` `text` `tool_use` `tool_result` `user`
`result` `log` `error` `closed`。

此外还有 `permission_request` / `permission_settled` / `permission_denied` 与
`dialog_request` / `dialog_settled`（见下文两节）。

每个事件都带单调递增的 `seq`，SSE 帧同时输出 `id:`，因此客户端重连时带 `Last-Event-ID`
即可**只收到缺失部分**，而不是整段历史重放（否则时间线会累积重复事件）。

### 工具审批（图形化）

CLI 的控制通道与消息流共用 stdout。开启方式只有一个开关：

```
--permission-prompt-tool stdio
```

**这是实测出来的，不是文档推断。** 只传 `--permission-prompts host`（默认值）时，CLI 会对
本该询问的调用**直接自动拒绝**，一个 `control_request` 都不会发出 —— 界面永远等不到审批。
加上这个 flag 后立刻收到：

```json
{ "type": "control_request", "request_id": "<uuid>",
  "request": { "subtype": "can_use_tool", "tool_name": "Write", "input": { },
    "description": "...", "permission_suggestions": [
      { "type": "setMode", "mode": "acceptEdits", "destination": "session" } ],
    "tool_use_id": "toolu_..." } }
```

宿主回一帧 `control_response`（`subtype:"success"`，`response` 为 `PermissionResult`：
`{behavior:'allow'|'deny', message?, updatedPermissions?, toolUseID}`）即可放行或拒绝。
界面上"自动接受本会话的文件编辑"这类按钮，用的就是 CLI 自己给的 `permission_suggestions`，
不自行发明规则。

CLI 还会给出自己的护栏：`default_to_no`（高风险，不该被一次误点批准）、
`suppress_always_allow_rule`（不该提供"总是允许"），卡片按这些字段调整呈现。

**另一个实测结论，曾经把我卡住很久**：CLI 在收到第一轮输入之前**不输出任何东西** ——
连 `system/init` 都没有。所以"就绪"必须定义为"可写 stdin"，而不是"已初始化"。若先等 init
再发首轮消息会死锁：没消息 → 没 init → 不 ready → 不发消息。

### 宿主对话框（`request_user_dialog`）

与审批同一套控制通道，但是**另一类请求**，并且有一个前置条件：CLI 只会发出
`initialize.supportedDialogKinds` 里**声明过**的 kind，缺失即 fail-closed（该功能降级为
无对话框行为）。所以桥在 spawn 时立刻发送：

```json
{ "type":"control_request", "request_id":"<uuid>",
  "request": { "subtype":"initialize",
    "supportedDialogKinds": ["refusal_fallback_prompt"],
    "forwardSubagentText": true,
    "agentProgressSummaries": true } }
```

实测回复是 `subtype:"success"`，并带 `pending_permission_requests` /
`pending_user_dialog_requests` —— 后加入的客户端据此得知**已经在等待中**的请求，而不必等重放。

`dialog_kind` 是**开放字符串联合**（协议加 kind 不需要升版本），所以界面做**通用渲染**：
从 payload 里找 `options`/`choices` 一类数组生成按钮，找不到就提供"确认 / 取消"。
取消发送 `{behavior:'cancelled'}`，CLI 会套用该对话框自己的默认行为 —— 因此任何未知 kind
都有一条协议认可的出路。

声明列表刻意保持很短：**只声明界面真能应答的 kind**。多声明一个自己处理不了的 kind，
比不声明更糟 —— 那会把一个没人能应答的对话框挂在那里。

### 技能与子代理

同一份 `initialize` 回复还携带了会话的真实能力清单，界面直接把它当数据源，
而不是维护一份会和 CLI 漂移的硬编码列表：

| 字段 | 内容 | 界面 |
| --- | --- | --- |
| `commands` | 43 个技能 / 斜杠命令，含完整描述与参数提示 | 「技能与子代理」面板的技能页 |
| `agents` | 5 个子代理类型（Explore / Plan / general-purpose / …） | 同面板的子代理页 |
| `models` | 6 个模型，含 `supportsEffort`、档位、fast mode 能力 | 同面板的模型页 |
| `account` | 凭据来源（如 `ANTHROPIC_AUTH_TOKEN`）、provider | 面板页脚 |

**子代理转录的归属靠唯一一个字段**：`parent_tool_use_id`。CLI 把它放在**帧信封上**
（与 `message` 同级，不是 message 里的字段），非空即表示该消息产生于由那个 tool_use
启动的子代理内部。界面据此把子事件收进启动它的 `Task` 卡片里，主时间线保持干净。

`forwardSubagentText` 必须声明，否则 CLI 根本不下发子代理的文本。
> 验证方式上有个取舍值得说明：合成 mock **无法**真实产生子代理帧（那是 CLI 自己 agent
> loop 里 mint 的），手搓 SSE 信封只会测到 mock 自己。所以这一块分成两层：
> 真实 CLI 验证 `Task` 调用与 catalog；`normalizeEvent` 用合成帧做单元测试验证归属。

### 会话内切换模型与权限

两者都走 CLI 的控制通道，因此**不重启、不丢上下文**：

| 操作 | 控制请求 | 语义 |
| --- | --- | --- |
| 切换模型 | `set_model` | 空值 / `null` / `"default"` 都表示**重置回会话默认模型** |
| 切换权限 | `set_permission_mode` | 见下表；`bypassPermissions` 需要启动时带跳过权限的 **选项** |

权限四档（文案取自 Harness-CN，右侧是它实际映射的 CLI 模式）：

| 界面档位 | CLI 模式 | 依据（二进制内文案） |
| --- | --- | --- |
| 仅可查看 | `plan` | "Planning mode, no actual tool execution" —— 唯一真正阻止写入的模式 |
| 需逐步审批 | `default` | "Standard behavior, prompts for dangerous operations" |
| 工作区内修改 | `acceptEdits` | "Auto-accept file edit operations" |
| 完全权限 | `bypassPermissions` | 带二次确认弹窗 |

**`完全权限` 能用的前提**：CLI 会拒绝 `bypassPermissions`，除非进程启动时带过跳过权限的
flag（报错原文：`Cannot set permission mode to bypassPermissions because the session was not
launched with --dangerously-skip-permissions`）。桥始终加 `--allow-dangerously-skip-permissions`
——它与 `--dangerously-skip-permissions` 的区别正是这里需要的：**开启该选项但不启用它**，
会话仍以配置的模式启动，只有用户主动选「完全权限」才会升级。

**一个反复出现的坑：`initialize` 回复是握手快照。** 切换模型或权限后 CLI 不会重发它，
所以直接读 `payload.current_permission_mode` 会永远停在旧值 —— 界面会表现为"切了没反应"。
桥改为本地追踪值优先，`resolvedModel` 则始终保留 CLI 在 `system/init` 里报的实际模型。

另外 `system/init`（带实际模型名）**只有发过一轮才会到达**，所以会话刚建好、还没说过话时
模型名是取不到的 —— 这是真实空窗期，不是 bug，界面此时显示"默认模型"。

### 模型的身份是「服务商 + 模型名」

一个模型名单独是没有意义的：同一个字符串在不同端点上可能是完全不同的东西，**真正决定谁
来回答的是端点**。所以设置里的模型配置以「服务商」为单位：

| 字段 | 说明 |
| --- | --- |
| 名称 | 显示用 |
| Base URL | Anthropic 兼容端点，如 `https://api.deepseek.com/anthropic` |
| API-KEY | 该端点的凭据，**默认不写入本地存储**（需显式勾选「记住到本机」） |
| 模型 | 逐个添加的模型名 + 可选显示名 |
| 默认 | 可把某个服务商设为新会话默认 |

可同时保存多个服务商；会话按所选模型自动使用对应服务商的地址与 Key。

> **已更新（本轮）**：上表「名称」一栏现在叫**服务商**，并且**新增时可以留空**（留空则按 Base URL
> 的主机名自动命名）。更重要的是，**这四个字段保存之后都能直接改** —— 早期版本里名称与 Base URL
> 保存后是只读文本，改名或换端点只能删掉重建，而重建又要把模型名重敲一遍。新增与修改现在走同一条
> 路径：**主机名相同的服务商会复用而不是新建**，所以在一个端点上加第二个模型不会分裂成两个服务商。

> **已删除：「新会话默认模型」下拉。** 它和服务商列表是**两个能各自说话的地方**，一旦对不上就会
> 出现"设置里找不到这个模型，新会话却在用它"，而且没有任何界面能解释这件事。现在新会话只用默认
> 服务商的第一个模型 —— 上表「默认」那一行的含义因此被收紧 —— 这个选择只在一处表达。旧版本
> 留下的 `defaultModelRef` 在加载时被清掉。

> **本轮新增：页面底部「国内模型平台官网」。** 拿到 Key 这一步发生在厂商自己的网站上，不在这个
> 应用里，所以把开放平台与文档入口直接列出来，而不是让用户去搜。新增服务商表单里的常用平台下拉
> **只自动填「已核对过端点」的那几家**（DeepSeek / 千问 / 智谱 / Kimi，标了「已验证地址」）；
> 其余平台（阶跃星辰 / MiniMax / 火山方舟 / 千帆 / 混元 / 星火 / 商汤 / 硅基流动）**只保证官网
> 链接是对的**，Base URL 留空由用户照文档填 —— 猜一个填进去，用户只会在第一次请求时收到一个
> 看不懂的 404。

> **最终形态（以此为准，上面两条被它取代）：一张选项卡 = 一个模型。**
>
> 上表那套「服务商里挂一串模型」的结构被取消了。现在设置 → 模型里只有一条条并列的选项卡，每张
> 内置**服务商 / 模型名称 / Base URL / API-KEY** 四项，各自带「保存」与「删除」。之所以改成这样，
> 是因为原结构把"建服务商"和"给它加第一个模型"拆成了两个步骤、两个位置：填完表单点保存什么也
> 没发生（保存按钮要三个字段都非空才亮，而亮不起来的按钮不会解释原因），用户看到的结论就是
> "新建选项卡没有显示在前端"。
>
> 几个随之确定的点：
>
> - **编辑是草稿，点「保存」才生效**，未保存的卡片打「未保存」标记。改一下就即时生效的写法没法
>   回答"我到底改上没有"，而这个面板里改的是端点与凭据。
> - **一项服务商只存一个模型**，由 `splitOneModelPerCard()` 在加载时保证：旧版本可以造出"一个
>   服务商挂多个模型"，那种记录没有自洽的编辑器（两张卡片写同一条记录，改一张会静默改另一张），
>   所以按模型**拆开**而不是丢弃，每个模型继承原来的端点与 Key —— 那正是用户当初在第二张卡片里
>   会手打的東西。
> - **`+ 新建` 立刻产生一条真实记录**，这样它才可见可编辑；因此需要一个反向规则
>   `dropCardStubs()`：既没有模型、也没有端点、也没有名字的卡片视为空壳，加载时丢掉，
>   否则点一下新建再关掉设置就会永久留下一条空记录。
> - **API-KEY 为空不阻止保存**（端点可以先配好、Key 后发；首屏已经会报「缺少 API-KEY」），
>   但**模型名称与 Base URL 为空会阻止**，并说明缺哪一个 —— 少了这两项这张卡片永远不可能工作。
> - **「测试连接」的结果只在它还描述当前字段时显示**（结果带着测试时的取值签名）。把「连接正常」
>   留在改过的 URL 旁边，等于对一件从没测过的事给出肯定结论。

> **再改（本轮）：选项卡收敛成四项，已保存的只能删。** 上面那条的"卡片 = 一条配置"不变，变的是
> 卡片本身长什么样：
>
> | | 新建（草稿） | 已保存 |
> | --- | --- | --- |
> | 字段 | 服务商 / 模型名称 / Base URL / API-KEY | 只读摘要：平台名 · 模型名 · 端点 |
> | 按钮 | 取消 / 测试连接 / 保存 | 删除 |
> | 其他 | 无 | 无 |
>
> - **「服务商」本身就是下拉框**，选项是那 12 个平台。它取代了原来的「常用平台」下拉 —— 厂商就是
>   平台，两个控件问的是同一件事。选中后自动填名字与**已验证**的 Base URL；模型名以 placeholder
>   出现（提示而非断言）。
> - **草稿不进 store。** 上一版"点新建就产生一条真实记录"需要一个 `dropCardStubs()` 在加载时清理
>   空壳；草稿只活在组件里之后，那条规则连同它的边界情况一起消失了。
> - **保存后不可编辑，只能删。** 已保存的卡片在 store 里只有一种表示，所以屏幕显示的和服务实际会
>   用的不可能对不上；也就不再需要脏标记和"我到底存上没有"这个问题。
> - **API-KEY 现在总是记住。**「记住到本机」勾选框随四字段的要求一起去掉了，而默认不记住会让重开
>   应用必须重打一次 Key。那张卡片本来就存在本机 localStorage 里，那个开关唯一改变的就是用户要不
>   要每次重新输入凭据。
>
> **推理挡位从设置搬到了输入框。** `--effort` 属于**会话**而不是模型配置：用户是干活中途想换，不是
> 配置时想一次。输入框右下角现在有「推理 默认 / 低 / 中 / 高 / 极高 / 最高」，选中即切换，菜单里
> 写明代价（重启进程并用 `--resume` 恢复对话，上下文不丢）。切换模型时**不再重置**它 —— 原来
> `onChangeModel` 会把模型自带的挡位一起发过去，而挡位搬走之后那个值恒为空，等于每次换模型都静默
> 清掉用户刚选的挡位。
>
> **顺带修掉一个潜伏的 bug**：`restartWith` 里 `this.options.baseUrl = next.baseUrl ?? this.options.baseUrl`
> 挡不住空串 —— 客户端不传 baseUrl 时服务端传的是 `''` 而不是 `undefined`，而 `'' ?? x` 是 `''`。
> 于是"只改推理强度"这条新路径会把会话端点清空，下一轮静默打到 Anthropic 默认地址。现在只有非空
> baseUrl 才会被应用。实测：`POST /model {model, effort:'high'}` 之后 endpoint 仍是原端点，且 mock
> 端点确实收到了第二次启动探测（说明重启后的子进程走的是配置的端点）。

> **已变更**：这个开关**已被删除**，CLI 自带的模型列表现在完全不提供。原因见下方补充；
> 下面这段保留以记录当时的判断与它引发的问题。

**为什么 CLI 自带的模型列表默认隐藏**：它列的是 **Anthropic 的模型名**（`opus[1m]`、
`sonnet`、`haiku`…）。在中继端点上，这些名字由**服务端自动映射**到该端点自己的模型
（DeepSeek 把 `claude-opus*` 映射到 `deepseek-v4-pro`、`claude-sonnet*` 到 `deepseek-flash`）。
也就是说选它并不是"选了某个具体模型"，而是**把选择权交给了端点** —— 界面显示
`claude-haiku-4-5-20251001` 会让人以为在调 Claude，实际不是。因此它变成一个显式开关
（设置 → 模型 → 同时显示 CLI 自带的模型列表），只有确实直连 Anthropic 时才建议打开。

**后来还是把它删掉了。** "默认关闭的开关"仍然留着三个问题：开关本身暗示这是一个可选项，
而它其实不是；列表一旦可见，选中的 Anthropic 名字会变成一个**看起来像具体模型的选择**
（这正是它要避免的误读）；以及它不是纯粹的显示开关 —— 打开时选中的引用会持久化，关掉后
就变得无法解析（见下文"曾经有个真实陷阱"）。现在**只有配置过的服务商真正提供的模型可被选中**，
加载时会顺手清掉旧版本留下的裸别名引用。

### 新建会话：直接建，不填表

**点「新建会话」会直接开始一个会话。** 工作目录取最近使用的项目（没有历史就取主目录），模型取
默认服务商的第一个模型，权限模式取「设置 → 权限」里保存的那一档 —— 三件事都是**解析出来的**，
不是问出来的。旧版本每次都会摊开一张表单，而这三点的答案在绝大多数情况下和上一次完全一样，
于是"新建会话"变成了一道必须做完才能开始干活的填空题。

要换地方时仍然换得了，而且这些入口都**不阻塞**（旧表单是阻塞的：不填完就没有会话）：

| 入口 | 行为 |
| --- | --- |
| 顶部栏的工作目录（**是个按钮**，不是标签） | 打开目录选择器，选中的目录直接新建会话 |
| 侧栏 / 首屏的「最近使用」 | 点一下就在那个项目里开始 |

**没有绑定模型时不给表单，只给一句话**：`您还未绑定模型` → 「打开设置 · 绑定模型」。一个注定
失败的表单，比一句明确的提示更糟。

首次打开时也是同一套动作：只要绑定过模型，应用会**自动开好一个会话**，直接进对话界面。
`?session=` / `?picker=1` / `?catalog=1` 这几个开发入口会跳过自动新建，以保持可复现。

### 新建会话的两个交互约定

> **已删除（本轮）**：下面第二段描述的「取消按钮」属于那张已被移除的表单，随之作废。
> 第一段仍然有效 —— 四档权限模式现在是「设置 → 权限」里的默认值，新会话直接采用。
> 原文保留，以记录当时的考虑。

**权限模式是四个选项，不是输入框。** 原来是自由文本，可以填任意字符串（包括拼错的模式名，
CLI 会静默回落到默认值）。现在直接给出四档，并显示每档对应的 CLI 模式：

| 选项 | CLI 模式 |
| --- | --- |
| 仅可查看 | `plan` |
| 需逐步审批 | `default` |
| 工作区内修改 | `acceptEdits` |
| 完全权限 | `bypassPermissions` |

界面上保存的是**档位 id**，不是模式字符串：四档是产品决定，而每档映射到哪个 CLI 模式是
实现细节，不该要求用户拼对。"完全权限"用红色标出，且标记在**文字上**而不只是选中边框 ——
扫一眼四张卡片的人应该在看之前就知道哪个会跳过全部检查。

**取消按钮在最上面。** 新建工作区是一个承诺，所以出口放在视线最先落到的地方（面板右上角），
而不是紧挨着"开始会话"——放一起容易被误点。取消后的落点分三种情况，都是有意的：已打开会话
→ 回到它；有会话但没打开 → 打开最近的一个；一个会话都没有（首次启动）→ 显示空状态。
第三种会清掉"用户钉住"标记，否则外部创建的会话就再也无法被自动接管。


### 跨服务商切换会重启子进程（但保住上下文）

Base URL 与 API-KEY 是子进程的**环境变量**，任何控制请求都改不了 —— `set_model` 只能在
当前端点内换模型名。因此：

| 情形 | 行为 |
| --- | --- |
| 同一服务商内换模型 | `set_model` 控制请求，**不重启** |
| 跨服务商换模型 | 重启子进程指向新端点，并用 `--resume <session-id>` **恢复会话上下文** |

恢复是否真的生效是可观测的：`provider-switch.mjs` 让两个 mock 端点各自报告它收到的
transcript 轮数，第二个端点在切换后收到的是**多轮**而非单轮 —— 这就是上下文被带过去的证据。
重启时界面会插入一条 `notice` 事件（"已切换到 …, 正在恢复会话上下文"），因为一次静默重启
和卡死在用户看来是一样的。

### 工作区与删除

**工作区不是一个实体** —— 它只是按 `cwd` 把会话分组出来的视图。所以：

- 删一个会话 → 悬停该行右侧的 `×`
- 删一个工作区 → 悬停分组标题右侧的垃圾桶（有二次确认，会说明将移除几个会话）

工作区在它**最后一个会话被移除时自动消失**，不需要单独的"删除工作区"状态要维护。

桥侧区分两个动词，混用会是真 bug：`DELETE`（不带参数）只 **停止**，会话仍留在列表里（它
仍是用户能查看的东西）；`DELETE ?purge=1` 才 **移除**。删除走的是后者，并且是立即 `kill`
而不是两秒优雅期 —— 用户已经决定要它消失，留一个僵尸占着端口没有意义。

会话行会显示创建时间（同一工作区多个会话时带 `#1` `#2` 序号）。CLI 不给会话起标题，所以
不这么做的话同一工作区里每行都一样，"删这一个"根本没法瞄准。

### 悬空模型引用会被清理

`modlens`（`@liustack/modlens`）内置在安装包里：给纯文本模型"装上眼睛"，把图片变成结构化
JSON 证据（逐字转写、版面区域、语义）。它本来就是 Claude Code 的标准 Skill，所以**不需要
DSH 运行时可移植** —— 实测其 CLI 的完整 import 图只有 **1 个文件、零 DSH 依赖**。

**落点机制**（实测得出，不是照文档推的）。Claude Code 从 `<root>/.claude/skills/<name>/SKILL.md`
发现技能，`<root>` 是会话 cwd **或任意 `--add-dir` 根**：

| 探测 | 结果 |
| --- | --- |
| cwd = 含技能的目录 | ✅ 发现 |
| `--add-dir <项目>`（技能在 `<项目>/.claude/skills/`） | ✅ 发现 |
| `--add-dir <skills 目录>`（直接指 skills） | ❌ **不行** |

所以内置技能放在 sidecar 自己的**独立技能根**下，由桥对每个会话补一条 `--add-dir` ——
用户工作区不会被写入任何东西。

**为什么必须随包携带而不是让它自己拉**：上游启动器的解析顺序是 PATH → `npx` → `bunx`，
而 `npx` 会去 `registry.npmjs.org` 取包 —— 那个域名在目标网络里**不通**（项目起点就实测过）。
一个首次使用就无法取得自身 CLI 的技能等于不可用，所以 CLI 与它的两个依赖（`commander`、
`undici`）打进安装包，启动器改为**内置优先**；上游的 PATH/npx/bunx 分支保留在后面，供确实
能访问 registry 的机器使用。

内置后 `system/init` 报告 `modlens` 已在会话技能列表中（16 个之一），且 Tauri 打包时
`.claude` 点目录被完整保留（两者都已验证）。

启用视觉还需配一个 provider（`modlens doctor` 会列出缺什么）：

```powershell
powershell -ExecutionPolicy Bypass -File "<安装目录>\resources\sidecar\skills\.claude\skills\modlens\scripts\run.ps1" doctor
```

### 其余请求的插件为何没有内置

同一个问题先问清楚：**它的完整 import 图里有没有 DSH 运行时？** 有，就无法脱离 DSH 工作，
因为本客户端没有 Cordis/DSH。逐包实测（`_probe/plugin-deps.mjs`，递归遍历，不是浅层看头部）：

| 插件 | 真实裁决 | 依据 |
| --- | --- | --- |
| `@liustack/modlens` | ✅ **已内置** | 本地图 1 个文件，零 DSH 依赖 |
| `dsh-chat-import` | ✅ CLI 可移植（未接入） | 本地图 38 个文件，零 DSH 依赖 |
| `dsh-vision-router` | ⚠️ doctor CLI 可移植 | 但主体是 DSH LLM provider 包装，功能与 modlens 重叠 |
| `@jieai/dsh-plugin-vet` | ❌ **DSH-BOUND** | `gate.js → tools/scan-plugin.js → @deepseek-ai/dsh-tools` |
| `dsh-cost-meter` | ❌ **DSH-BOUND** | CLI 与 UI 两条链都进 DSH |

> **上表后三行的状态已推进**（表格保留原始裁决，结论更新在这里）：
>
> - `@jieai/dsh-plugin-vet`：外壳仍是 DSH-BOUND，但**引擎已原样内置** → 「设置 → 安全审计」；
> - `dsh-cost-meter`：仍是 DSH-BOUND，**费用核算思路已自建**（其价目表 14 个服务商不含
>   DeepSeek，无法直接沿用）→ 侧栏「本会话用量」；
> - `dsh-chat-import`：CLI 确实可移植，但可移植的那一半处理的是**本应用不存在的 DSH 会话存储**，
>   因此**按同一思路对 Claude Code 自己的格式重做** → 「设置 → 导入会话」。
>
> **"DSH-BOUND" 不等于整个包都没用。** plugin-vet 的外壳进 DSH，但它的**分析引擎**
> `lib/scanner-bin/` 是完全自包含的子进程：stdin 读一个 JSON 请求、stdout 写一个 JSON 结果，
> 唯一非内建依赖是 `typescript`（只用 AST 谓词，不用类型检查器）。所以直接**原样内置引擎**
> （连 20 条规则一起），而不是重写一遍 —— 重写既更差，也会在"与上游一致"这件事上说谎。
>
> 对 cost-meter 与 chat-import 的判断则是「**移植思路，不搬运代码**」：搬过来的价目表里没有
> DeepSeek，可移植的 CLI 处理的又是另一种存储格式。两者都按本应用的真实数据源重做，理由落在
> `packages/bridge/src/bundled.mjs` 的 `NOT_BUNDLED`，界面上「设置 → 内置插件」可以直接看到。

**一次值得记下的误判**：我最初只看了入口文件头部，判定 plugin-vet 的 `vet-gate` 是可移植的
—— **错了**。它的 DSH 依赖在第 3 层（`gate-cli.js → gate.js → tools/scan-plugin.js`）。
在打包产物上做浅层 import 检查等于没检查，所以换成了递归遍历才得到上面的表。

曾经有个真实陷阱：在"CLI 原生模型列表"可见时选过 `sonnet[1m]`，之后该列表被隐藏，这个
引用却仍对每个新会话生效 —— 既没有界面能改它，也无法清除，表现为**会话莫名其妙在跑一个
Claude 模型名**。现在两道防线：

1. 启动时与关闭原生列表时，**无法解析的 `defaultModelRef` 会被清空**（解析不了就是悬空）；
2. 即使会话本身带着这样的模型，输入框也会显示成 `⚠ sonnet[1m] · 未配置`，而不是若无其事
   地当成一个正常选择。

现在原列表已整体移除，所以第 1 条收紧为：**裸别名（不含 `providerId::`）一律视为悬空并清空**，
不再有"列表可见时就有效"这个例外。第 2 条保留 —— 会话仍可能带着历史遗留的模型名。

**再后来第 1 条整体消失了。** 承载它的「新会话默认模型」设置项本轮被删除（见上文），
已经没有可以悬空的引用：新会话的模型直接来自默认服务商，不存在第二个来源。旧版本存下的
`defaultModelRef` 在加载时被 `delete` 掉，和更早的 `showNativeModels` 用同一种处理方式 ——
**删掉一个设置项却不删掉它的持久化值，就等于让它继续生效而没有任何界面能解释**。
第 2 条依然保留：它防的是**会话自己带着**的历史模型名，与设置项无关。

### 工作目录选择

工作目录是**选**出来的，不是填出来的：`DirectoryPicker.vue` 是仓库内自绘的模态 ——
左侧快速访问、右侧逐级浏览、上方可粘贴路径与面包屑跳转，底部「选择此目录」确认**当前
所在目录**，因此不必先进入再选。

> **行为已变更（本轮）**：选中一个目录现在**直接在该目录下新建会话**。它以前只是把值填进那张
> 表单里的一个字段；表单移除之后，"选一个目录"本身就是完整的指令，没有别的地方可以提交。

之所以不用系统对话框（Tauri dialog 插件）：自绘方案在**浏览器开发模式和桌面应用里行为
完全一致**，样式也跟随同一套设计令牌；否则桌面版会有一个浏览器版无法拥有的 UI，两条路径
的验证成本都会上升。

桥侧默认隐藏点目录、`node_modules`、`.git`，以及用户配置目录里那批**兼容性 junction**
（`Application Data`、`Cookies`、`NetHood`、`PrintHood`、`Recent` 等）—— 它们在资源管理
器里本来就是隐藏的，且打开会弹 UAC；不过滤的话选择器看起来就像坏了。`hidden=1` 可全部显示。

### 轨迹：每条事件都可展开看全

「轨迹」是原始事件流，每行是 `时间 · kind · 一行摘要`。这一行摘要是**截断**的（摘要里带
`.slice(0, 140)` 之类的上限），而偏偏最需要看全的东西就藏在被截掉的部分里 —— 一条
`log[warn] · [claude-code:unrecognized_model] {"model":"…","quer…` 后面到底是什么，摘要
永远不告诉你。

所以每一行本身就是一个展开控件：点一下在下面展开这张事件**所有字段**的清单，标签是中文
（`内容` / `模型` / `工具` / `用量` …），结构化值用 `<pre>` 保留换行。

两个实现上的选择值得记下来：

- **展开状态是一个 Set，不是单个 id。** 看轨迹的用法就是同时打开几行互相对照，点第二行就把
  第一行关掉的交互会让这件事做不到。行的 key 带上索引，因为 CLI 会在同一毫秒里打出好几帧 ——
  那正是轨迹存在的意义，而只按时间戳做 key 会让它们互相顶掉。
- **字段清单由 `Object.entries(event)` 驱动，不是按 kind 手写 switch。** 只藏掉行首已经显示过的
  `kind` 和整条流里恒定不变的 `sessionId`，其余一律照实列出，遇到没见过的键就按原键名显示而不是
  丢掉。手写清单的失败方式很隐蔽：桥以后新增一个字段，轨迹里就永远看不到它，而且没有任何迹象。

### 费用核算（按轮计价，区分缓存与峰谷）

侧栏「本会话用量」下面会多一行**费用**。三件事决定了它不是"单价 × token 数"：

1. **缓存命中是独立的第三档。** 实测某一轮的真实用量是 `未命中 10,831 / 命中 68,736 /
   输出 536`；在 flash 价上缓存命中比未命中便宜 50 倍。把缓存折进"输入"会把这一轮的费用
   **高估 5.4 倍**（0.7161 元 vs 实际 0.1326 元）。所以 `cache_read_input_tokens` 单独计。
2. **价格随时间变。** DeepSeek 分高峰与空闲两档，空闲价正好是高峰的一半（北京时区工作日
   09:00–12:00、14:00–18:00 为高峰）。因此**每一轮按它自己运行时刻的价计费**，而不是按你
   查看账单时刻的价。跨过价格边界的会话会被拆成两档分别计费。
3. **计费模型和 CLI 报告的模型不是一回事。** 中转端点会把 `claude-opus*` 映射到
   `deepseek-v4-pro`、`claude-sonnet*/haiku*` 映射到 `deepseek-flash`，所以价目表按**映射后**
   的模型查（`packages/bridge/src/pricing.mjs`）。

**会话中途换模型不会改写历史账单。** 这是实现里最容易做错的一点：`set_model` 与跨服务商
重启都会改写"当前模型"，如果计费时读当前模型，之前跑过的每一轮都会被按新模型的价重算。
所以桥在**每轮结束时把当时的模型盖在 `result` 事件上**（`#pushEvent`），计费只看事件上的
那个值 —— 与"按运行时刻计价"是同一个道理，只是维度从时间换成了模型。

费用与用量**只在真的有可计价的轮次时才显示**：没有会话或模型无法计价时留空，并说明有几轮
未计价，而不是显示 `¥0.00` —— 零是一个我们无法支撑的说法。

**已知限制**：中国大陆法定节假日**没有建模**。官方日历每年变动，内置一份会过期的假期表
只会静默算错价，所以用"工作日时段"近似，界面也如实写成"高峰/空闲时段价"。

#### 接了别家模型（通义千问 / 智谱 / Kimi / 阶跃星辰 / 讯飞星火）还会计费吗？

**内置价目只有 DeepSeek 一家，所以默认不会** —— 这一点是实测的，不是推断：
`_probe/pricing-other-vendors.mjs` 拿 16 个常见的别家模型名跑一遍，**16 个全部返回 `null`**
（qwen-max / qwen-plus / glm-4.6 / kimi-k2 / step-3 / spark-4.0-ultra …），只有
`deepseek-chat`、`deepseek-v4-pro`、`deepseek-flash` 三个能算出来。界面的表现是**费用一栏
直接不显示**（若有部分轮次能算，则显示"N 轮未计价"），而不是显示 ¥0.00。

**修法不是再内置五家。** 各家价格按**模型档位、区域、计费方式**（按量 / 批量 / 缓存命中）
各不相同，而且会变；随安装包发一份价目表，几个月后就是"自信地算错"，比不显示更糟。
所以在「设置 → 费用核算」里给了**用户自填价目表**：

| 字段 | 含义 |
| --- | --- |
| 匹配 | 模型名的**子串**（不区分大小写，留空即匹配全部），一行覆盖一个系列 |
| 输入（未命中缓存） | 元 / 百万 token |
| 输入（命中缓存） | 同上；多数厂商比未命中便宜很多 |
| 输出 | 同上 |
| 高峰倍率 | 可选。默认 1 = **全天同价**；只有 DeepSeek 的内置表分峰谷 |

两个刻意的设计：

- **预填只写名称与前缀，单价一律留 0。** 替你猜一个价格，正是这里要避免的事。
- **自定义价目优先于内置价目**，所以在 DeepSeek 上也能用它覆盖内置数字，不必等新版本。
  这一点在界面上直接写明，因为"自己填的数字悄悄盖掉了内置数字"是这个功能最意外的地方。

**一个必须说清的细节：峰谷只对声明了倍率的价目生效。** `isPeak()` 描述的是 DeepSeek 的
北京时间高峰窗口；把它套到"全天同价"的厂商上，会在中国工作时段把每一笔**静默翻倍**。所以
`priceTurn` 只在 `peakMultiplier > 1` 时调用它，界面也据此决定要不要显示"高峰/空闲时段价"
那一行 —— 平价的厂商不会被贴上一个不成立的计费依据。

端到端验证在 `_probe/custom-rate-ui-check.mjs`：给 `qwen-max` 填一行价目后，侧栏出现
`费用 ¥0.0035 · 通义千问（测试价目）`；把这一行删掉，同一次会话**又回到不计价**。两条都断言，
因为"能算出来"和"只在该算的时候算"是两件事。

#### 侧栏到底是谁的钱：厂商名 + 账户余额

「费用」下面**永远**带一行厂商/模型名（`DeepSeek-V4.1-Flash`，或自定义价目的名称），
因为一个孤零零的 `¥0.03` 回答不了任何真实问题 —— 而这个客户端支持会话中途换服务商，
"这笔钱花在谁身上"是真问题。**多个模型时列出各自小计**，而不是给一个平均值：平均值恰好会
盖掉用户想看的东西。

余额来自服务商自己的接口，实测可用（DeepSeek）：

```
GET https://api.deepseek.com/user/balance
{"is_available":true,"balance_infos":[{"currency":"CNY","total_balance":"109.19", …}]}
```

三个实现要点：

- **余额接口在 API 根上，不在 Anthropic 兼容前缀下。** 端点配的是
  `https://api.deepseek.com/anthropic`，但余额必须查 `https://api.deepseek.com/user/balance`
  —— 直接拼 baseUrl 会 404。已由测试断言。
- **金额是字符串。** `total_balance: "109.19"` 直接参与运算会得到 NaN，所以适配器里显式 `Number()`。
- **只有 DeepSeek 有内置适配器。** 余额接口没有标准，各家形状不同、有的只在控制台里给。
  其他厂商可在「设置 → 模型 → 账户余额」填地址与取值路径（如 `data.0.balance`）；填不出时
  界面显示**"没有内置余额接口"**，而不是猜一个形状 —— 猜错的代价是**显示一个错误的余额**，
  比不显示更糟。

**一个差点写错的地方**：请求里显式传空字符串 `apiKey` 时，早期实现会回退到桥自己的默认凭据，
于是**可能把另一个账户的余额显示成这个服务商的余额**。现在显式空 = "没有 Key"，
只有字段缺失才回退 —— 与会话路由既有的 `??` 语义一致，并有测试钉住。

#### 模型/服务商名不该挂在"费用"下面

第一版把厂商/模型名放进了**费用那一块**，于是留下一个用户直接撞上的洞：新会话还没跑过任何一轮，
**没有任何东西被计价**，费用块整个不渲染 —— 结果侧栏只剩一个孤零零的
`账户余额 ¥107.53`，**不说是谁的钱**，尽管应用其实早就知道（余额就是从这个服务商读出来的）。

现在这两件事分开：

```
本会话用量            0
入 0 · 出 0
claude-sonnet-5 · DeepSeek                        ← 一开会话就有，与是否计价无关
费用 ¥0.0015 · DeepSeek-V4.1-Flash · 空闲时段价     ← 有可计价的轮次才出现
DeepSeek 余额 ¥107.46  [刷新]                      ← 余额标签里写明归属
```

三点考虑：

- **模型/服务商行与计价解耦**：没跑过轮次也有服务商，而余额属于它。挂在费用下面，等于在用户
  最需要它的时刻（刚打开会话）恰好不显示。
- **余额标签带服务商名**，不只是 tooltip：这个客户端支持同时配置多个服务商，一个不带归属的
  金额是有歧义的。
- **"请求的模型"与"计费的模型"分别显示**：会话跑的是 `claude-sonnet-5`，账单上是
  `DeepSeek-V4.1-Flash`（中继映射），两者都如实写出来。

验证在 `_probe/model-context-check.mjs`：分**两个状态**断言（0 轮 / 1 轮），因为通过其中一个
并不能说明另一个 —— A 状态要求模型与服务商已显示、且**不得凭空出现费用行**；
B 状态要求费用行出现、且计费模型被单独命名。

> **截图工具的一个坑**：`shot-cdp.mjs` 每次都用全新的浏览器 profile，所以上一次调用写进
> `localStorage` 的设置下一次就没了 —— 截图里于是显示"未配置服务商"，看起来像功能坏了。
> 现在支持 `CCCN_SEED`：在最终截图前注入 JavaScript 并重新加载，让"已配置状态"也能被截到。

#### 「添加模型」点了没反应

用户报告：把模型加进去了，模型列表里还是没有。**先用 `_probe/add-model-check.mjs` 复现，
再决定改什么** —— 这个脚本分两件事验证，因为它们的修法完全不同：

| 假设 | 实测 |
| --- | --- |
| A. 输入框绑定会丢掉输入 | ❌ 不成立：输入后 `v-model` 稳定保留，点「添加模型」**确实加进去了**，立即写入 localStorage，**刷新后仍在** |
| B. 字段为空时点击**静默返回** | ✅ 成立：`if (!draft.model.trim()) return` —— 什么都没发生，也什么都没说 |

所以加入逻辑本身是对的，真正的缺陷是**空字段点击时静默无反应**。而这恰好解释了用户的经历：
服务商**名称**那一栏填的是 `qwen3.8-flash`（一个模型名），模型名那一栏是空的，
点「添加模型」于是毫无反应。

修法：

- 空字段点击时给出**红色错误**并**点名最可能搞混的地方**：
  `请先填写模型名 —— 上面「qwen3.8-flash」是服务商名称，不是模型`；一开始输入就清除。
- 空状态文案补上因果：`尚未添加模型 —— 在下面填模型名并点「添加模型」，它才会出现在输入框的
  模型列表里。服务商名称（本块标题）只是给这组配置起的名，不是模型。`

**这不是外部服务的怪癖，而是百炼的硬约束**：其 Anthropic 兼容端点只提供
`/v1/messages`，**不提供 `/v1/models`**，所以客户端无法自动发现模型，只能手动添加。阿里云文档
也把"手动添加模型以跳过自动发现"列为该端点的标准做法。

#### 「切换模型后余额不变」：一个我自己引入的缓存 bug

用户报告：换模型之后，侧栏余额还是老样子。余额是按**会话所属服务商**推出来的，所以这指向
"客户端手里的会话模型是旧的"。

`refreshSessions` 里有一段**保留对象身份**的优化（避免每次轮询都让列表重渲染）：

```js
return before && before.status === session.status && before.historyLength === session.historyLength
  ? before   // ← 沿用旧对象
  : session
```

它只比了 `status` 和 `historyLength`，而**在同一个服务商内换模型，这两者都不会变**：
CLI 照样 `ready`，转录长度也没动。于是客户端会**永久保留旧的 `model`**。

`_probe/model-change-detection.mjs` 直接量到了它（走桥 API 换模型，避免测到输入框自己的局部
状态）：

```
client shows: "model-alpha · DeepSeek"
server model: "model-beta"
client shows: "model-alpha · DeepSeek"     ← 3 个轮询周期后仍是旧值
```

修法不是补一个 `model` 字段 —— **字段清单正是下次加字段时又会过期的东西**。改成对 UI 真正读取的
全部字段取一个**指纹**，指纹相同才沿用旧对象。同时补上了 `SessionView.endpoint`
（桥一直在发，类型里却漏了，读它得绕过类型系统）。

修完同一脚本：`client shows: "model-beta · DeepSeek"`。

#### 「服务商/模型都删了，为什么还能调用？」

**因为它本来就能 —— 而且之前的文案在说谎。** 会话在创建时把端点与凭据写进了子进程的环境
（`ANTHROPIC_BASE_URL` / `ANTHROPIC_AUTH_TOKEN`）。设置里的服务商列表是一个**本地目录**，
不是鉴权层：它决定"下拉里给什么"和"新会话用什么"，**删掉它无法收回一个已经在跑的进程里的 env**。
真正决定成败的是端点本身。

所以旧文案的 `未配置服务商` / `未配置模型 · 去设置` 是**把"不在清单里"说成了"不能用"**，
而用户看着它明明能用 —— 于是合理地得出"这应用坏了"。

改法是**说实话，而不是加限制**（加限制会误伤正常路径：手动填端点建的会话、以及用
`CCCN_AUTH_TOKEN` 启动的桥，它们的模型都不在任何服务商里，但完全可用）：

| 状态 | 旧文案 | 新文案 |
| --- | --- | --- |
| 模型不在清单里，但有凭据 | `未配置服务商` | **`未登记的端点`** |
| 模型不在清单里，且无凭据 | （同上，无法区分） | **`无凭据`** |
| 输入框模型 chip（清单为空） | `未配置模型 · 去设置` | **`some-model · 不在清单中 去设置`** |

为了能区分后两行，桥新增了一个**布尔** `hasCredential`（**从不返回凭据本身**），并有测试钉住
"显式空 token" 与 "继承桥默认 token" 两种情形分别得到 `False` / `True`。

#### 服务商下拉里只列端点核对过的厂商

「添加服务商」的名称栏改成了下拉，选中会**同时填好名称与端点**——它们描述的是同一件事，
分开手填正是"服务商被命名成模型名"的来源。

列表里只有 4 家 + 「自定义」，因为**只有这 4 家的 Anthropic 兼容地址在各自官方文档里核对过**：

| 选项 | 端点 | 来源 |
| --- | --- | --- |
| DeepSeek | `https://api.deepseek.com/anthropic` | 本项目默认端点，实测跑通 |
| 千问 Qwen | `https://dashscope.aliyuncs.com/apps/anthropic` | 阿里云百炼文档 |
| 智谱 GLM | `https://open.bigmodel.cn/api/anthropic` | 智谱开放文档 |
| Kimi 月之暗面 | `https://api.moonshot.cn/anthropic` | Kimi 开放平台文档 |

**讯飞星火与阶跃星辰一度以"名称 + 空端点 + 文档链接"的形式列在那里，后来直接删掉了** ——
一个填不出地址的选项不比没有更省事，反而让人以为选中就该能用。它们和任何其他厂商一样走
「自定义」：自己从官方文档抄地址。这一条是用户当场拍板的取舍，记在这里免得以后又被"补全"
回去。



> 顺带确认了用户的配置是对的：`https://dashscope.aliyuncs.com/apps/anthropic` 正是华北2（北京）
> 的兼容端点，且 base URL **不能以 `/v1/` 结尾**（否则客户端追加后会出现 `/v1/v1/models`）。
> 我们填的地址不含 `/v1`，因此请求落在 `/apps/anthropic/v1/messages`，正确。





### 安全审计（内置 plugin-vet 扫描引擎）

「设置 → 安全审计」可以在把第三方插件或技能放进工作区之前先静态扫描它。

Claude Code 从 `<root>/.claude/skills/<name>/SKILL.md` 加载技能，也能加载插件；这两者都是
任意的第三方代码，而 SKILL.md 更是**任意的指令** —— 恰好是 plugin-vet 的 R17（配置注入）
与 R18（指令/技能注入）两条规则针对的场景，所以它放进 Claude Code 客户端是合适的。

引擎是**原样内置**的（`vendor/vet/scanner-bin/`，20 条规则、`static-v26`），因为它是自包含
子进程：stdin 一个 JSON 请求、stdout 一个 JSON 结果。它唯一的非内建依赖是 `typescript`，
且**只用到 AST 谓词**（`isCallExpression`、`forEachChild`、`SyntaxKind`），不用类型检查器，
所以只随包携带 `lib/typescript.js` 一个文件（9.1 MB），而不是整个 23 MB 的包。

**它不会被 `import` 进桥进程，而是 `spawn` 出去。** 两个好处：引擎从不在本进程内求值；扫描
崩了也不会带走会话。

界面有两条自我约束：

- **绝不在不说明规则集版本的情况下给分数** —— 裁决只有相对某个规则集才有意义，所以
  `static-v26` 永远和分数一起显示。版本号钉在 `vet-engine-version.mjs` 里（避免桥在启动时
  依赖 vendor 目录），并由测试断言它与引擎自己导出的值一致，防止漂移。
- **"无法审计" 绝不长得像 "审计通过"。** 目录不存在、引擎崩了、超时，都走显式失败分支；
  扫描被文件数上限截断时也会标注出来，而不是当作一纸健康证明。

**`staticScore` 是健康分，不是风险分**：引擎按 `100 - Σ(严重度权重 × 置信度系数)` 计算
（`score.js`），所以 **100 是干净、分数越低越糟**。我最初把方向读反了，被自己的测试抓出来，
所以这条方向现在由测试显式断言。

### 导入已有会话（读 Claude Code 自己的历史）

「设置 → 导入会话」列出磁盘上**已经存在**的 Claude Code 会话，点「继续对话」即可接着聊。

它不做"导入"意义上的转换：Claude Code 早就把每个会话写在
`<config>/projects/<编码后的 cwd>/<sessionId>.jsonl`，而桥本来就支持 `--resume <sessionId>`。
所以"导入"= 列出磁盘上已有的东西 + 重新打开它，工具调用与推理过程因此**原样保留** ——
因为根本没有经过任何转换。工作目录取自记录里的 `cwd`（而不是建会话表单里的值），否则 CLI
找不到被要求恢复的那个会话。

格式事实是**实测**出来的，不是照着一个样本猜的（见 `_probe/cc-transcripts.mjs`，遍历本机
158 个会话）：

- 158/158 个文件都带 `sessionId`、`cwd`、`version`、首个用户提问和时间戳；
- 目录名就是 cwd 把每个非字母数字字符换成 `-`（`D:\Claudecode-CN` → `D--Claudecode-CN`），
  与记录里的 `cwd` **40/40 一致**；
- 同一个文件里还有大量非对话记录（`attachment`、`queue-operation`、`atis-latch`、
  `last-prompt`、`system`、`cost-state`）—— 把它们算成"轮次"会把一段 2 轮的对话报成 30 轮。

三个统计口径上的坑，各有对应的测试：

- **工具结果不是用户发言。** 工具结果是以 `user` 记录回传的，所以"第一条 user 记录"会被
  当成标题而显示成 `[tool result]`；同一条规则现在同时决定"能否当标题"和"算不算用户轮次"，
  否则面板会自相矛盾（标题说不是、轮次说是）。
- **子代理流量不计入轮次。** `isSidechain` 记录是真实流量，但算进去会把这轮对话描述得比
  用户实际经历的更长，所以单独计数。
- **`?` 不是解析丢了中文。** 本机有 6 个会话的标题确实就是 `?` 字符（早期用 PowerShell 5.1
  发中文请求时按 ASCII 编码造成的），UTF-8 JSON 里看得很清楚。所以中文检索另行验证过：
  唯一一个还带真中文的会话，标题 `什么是API？` 能被 `什么` 命中，导出 Markdown 也保留中文，
  负向对照（不可能存在的查询）返回 0。

顺带把 chat-import 可移植 CLI 里唯一对本应用有意义的那半（`export-md`）按 Claude Code 的
格式重做成了「导出 MD」。**上游包没有内置**：它可移植的部分面向 DSH 会话存储，本应用没有
这种存储；这一点与理由一起写在 `NOT_BUNDLED` 里，界面上可见。


---

## 开发

前置：Node 22+、pnpm、Rust 1.77+（MSVC）、Windows SDK。

```powershell
pnpm install

# 1) 不需要真 Key：用 mock 后端跑通全链路
node packages\bridge\test\mock-server.mjs --port 59911 --quiet
$env:CCCN_BASE_URL='http://127.0.0.1:59911'; $env:CCCN_AUTH_TOKEN='sk-mock-token'
node packages\bridge\src\cli.mjs --port 59910

# 2) 前端
cd packages\web; $env:CCCN_BRIDGE_PORT='59910'; pnpm dev   # http://localhost:5173

# 3) 桌面外壳（会自动暂存 sidecar 并拉起桥）
node packages\desktop\scripts\prepare-sidecar.mjs
cd packages\desktop; pnpm dev
```

### 验证

```powershell
node packages\bridge\test\e2e.mjs        # 桥 → claude.exe → mock 后端，25 项
node packages\bridge\test\ui-flow.mjs    # 经 Vite 代理的完整 UI 流程，9 项
node packages\bridge\test\directories.mjs  # 目录选择器接口与过滤规则，24 项
node packages\bridge\test\permission.mjs   # 审批放行/拒绝的完整往返，34 项
node packages\bridge\test\permission-mode.mjs  # 四档权限模式会话内切换，9 项
node packages\bridge\test\model-switch.mjs # 会话内换模型与重置语义，10 项
node packages\bridge\test\provider-switch.mjs  # 跨服务商切换与上下文恢复，12 项
node packages\bridge\test\removal.mjs      # 停止 / 移除 / 工作区删除，10 项
node packages\bridge\test\bundled-skill.mjs # 内置技能是否真被发现，5 项
node packages\bridge\test\subagent.mjs     # 子代理归属（单元）+ Task 调用与目录（实测），15 项
node packages\bridge\test\initialize.mjs   # initialize 能力握手，4 项
node packages\bridge\test\watchdog.mjs     # 父进程强杀后桥是否自我了断
```

一条命令跑完整套回归（**14 个套件 / 232 项**，全部通过才返回 0）：

```powershell
node packages\bridge\test\all.mjs
```

> **计数已更新**：现在是 **15 个套件 / 257 项**（新增 `attachments-balance`）。上面那个数字保留
> 为写入时的记录。

### 附件（输入框左侧的 +）

这个按钮曾经是 `disabled` 且标着"暂未实现" —— **比不存在更糟**：它邀请你点击，然后拒绝。

Claude Code 是**按路径**读文件的，所以"附件"不是上传协议，而是把字节落到磁盘再把**路径**
放进输入框。写盘由桥来做，因为 webview 写不了：`<input type="file">` 只给一个 File 对象，
浏览器里根本没有真实路径。传字节、拿路径回来，是唯一能让 `vite dev` 与 Tauri webview
**行为一致**的做法 —— 与目录选择器同一条规则。

**文件名永远不参与拼路径。** 客户端给的名字只保留扩展名，basename 重新生成，一步消掉目录穿越
（`../../evil.js`）、Windows 保留设备名与重名三类问题，而不是去过滤已知坏模式。测试里直接提交
`../../evil.js`、`C:\Windows\...\hosts`、无扩展名和 `.exe`，断言**每一个落点都在附件根目录内**、
根目录外没有生成任何东西、且不允许的扩展名被规范成 `.bin`。

附件放在 `~/.claude-code-cn/attachments/`，**不放进工作区**：它们不是用户的文件，落进项目会
出现在 `git status` 里，也会被 agent 自己的检索扫到。

### 验证脚本一览（都在 `_probe/`）

```powershell
node _probe\attach-check.mjs            # 经 CDP 真实投喂文件，断言字节与路径
node _probe\cost-card-check.mjs         # 侧栏厂商名 / 计费依据 / 余额
node _probe\custom-rate-ui-check.mjs    # 自定义价目的正反两面
node _probe\scoped-style-audit.mjs      # "只在 scoped 里定义却被子组件使用"的类
node _probe\input-trace.mjs             # 页面到底收到了哪些输入事件（trusted?）
node _probe\first-run-watch.mjs         # 从首帧起记录界面状态变化
```

`e2e.mjs` 不需要真 API Key：它起一个 mock Anthropic 服务，返回合法 SSE 流，
从而在无凭据情况下验证事件契约。

`permission.mjs` 是行为断言而非状态断言：让 mock 请求一次 `Write`，放行时检查**标记文件
真的落到磁盘上**，拒绝时检查它**没有**出现。只断言"收到事件"是不够的 —— 拒绝与"允许但
执行失败"在事件上看起来一样。

`cost.mjs` 与 `vet.mjs` 同样刻意**不复用被测代码**：前者用一份独立转写的价目表重算价格
（导入 `pricing.mjs` 会让断言变成同义反复，价目表本身错了也照样通过）；后者用一份故意写了
`(function(){}).constructor("return process")()` 逃逸样本的目录，断言必须出现 `R1:critical`
—— 一个永远返回"clean"的扫描器能通过所有结构检查，却毫无价值。

`transcripts.mjs` 用合成会话树，因为断言必须是关于**已知内容**的：真实目录会随使用变化，
"找到 3 个会话"就没有意义了。合成数据里专门放了工具结果、`isSidechain` 与
`attachment`/`queue-operation` 等噪声记录，把三个统计口径的坑各钉一条断言。

界面验证用两个脚本（都在 `_probe/`）：

```powershell
node _probe\serve-dist.mjs 5180 http://127.0.0.1:<桥端口>   # 静态托管构建产物 + 流式代理 /api
node _probe\shot-cdp.mjs <url> <out.png> [等待毫秒]          # 经 CDP 截图
```

**`shot-cdp.mjs` 用 CDP 而不是 `--screenshot --virtual-time-budget`**：后者等页面"空闲"，
而本应用在挂上会话期间**一直开着 SSE**，页面永远不会空闲 —— 实测会一直挂到被强杀、连 PNG
都不落盘。CDP 没有这个假设：导航、按墙钟等一段、截图，流开着也无所谓。设 `CCCN_EVAL`
还可以直接把页面里的状态读回来（`EVAL => {...}`），因为"这段代码到底跑没跑"是截图答不了的
问题 —— 我就靠它才发现代理在缓冲 SSE 而不是转发它。

`serve-dist.mjs` 的代理必须是**管道转发**：`/api/sessions/:id/events` 是永不结束的 SSE 流，
用 `arrayBuffer()` 缓冲会永远不 resolve，页面收到 0 个事件、正文空白 —— 看起来像应用坏了，
实际上是代理坏了。

---

## 环境变量

| 变量 | 作用 |
| --- | --- |
| `CCCN_BASE_URL` | Anthropic 兼容端点，默认 `https://api.deepseek.com/anthropic` |
| `CCCN_AUTH_TOKEN` | 中转 Key（推荐走环境变量，不落盘） |
| `CCCN_CLAUDE_BINARY` | 显式指定 claude.exe，跳过发现 |
| `CCCN_PORT` / `CCCN_HOST` | 桥监听地址，默认 `0`（系统分配）/`127.0.0.1` |
| `CCCN_BRIDGE_URL` | 开发用：外壳改为连接已在运行的桥 |
| `CCCN_VET_DIR` | 显式指定审计引擎目录（默认随包 `sidecar/vet/scanner-bin`） |
| `CLAUDE_CONFIG_DIR` | Claude Code 配置根；导入面板据此找 `projects/` 下的历史会话 |

凭据**不写入 webview 存储**：界面表单随建会话请求一次性传给桥。
例外只有一个 —— 服务商的 API-KEY 在用户显式勾选「记住到本机」后才会写入 localStorage；
未勾选时该字段不会被序列化。勾选与否则在设置里可见。

---

## 已知限制

- 仅 Windows（WebView2）；macOS/Linux 需自行调整打包配置。
- 无自动更新；升级 = 重新安装。
- 未做代码签名，SmartScreen 会提示未知发布者。
- DeepSeek 端点忽略 prompt 缓存，长会话成本偏高。
- **同上，已被实测推翻**：服务端自动 KV 缓存生效（实测单轮命中 68,736 token），成本不构成
  限制。保留此行以记录这次误判的来源 —— 从文档推断而未实测。- 端点兼容性未覆盖全部字段：`document` 内容块、`mcp_tool_use` 等中转不支持。
- 审批面板覆盖 `can_use_tool` 询问（见上文「工具审批」）；CLI 的 `request_user_dialog`
  等宿主对话框类型未接——需在 `initialize` 声明 `supportedDialogKinds`，不声明时 CLI
  会降级为无对话框行为，属安全默认。（**已实现**，见上文「宿主对话框」：仅在 initialize
  中声明了 `refusal_fallback_prompt`。）
- 子代理 / 工作流 / 技能等高级能力由 CLI 自身驱动，界面尚未单独呈现。
- 对话框目前只声明 `refusal_fallback_prompt` 一个 kind（见上文「宿主对话框」）：
  `dialog_kind` 是开放联合，二进制里能扫到十几个候选，但**没有观察到真实载荷**的 kind
  一律不声明——多声明一个处理不了的 kind 会把一个无人应答的对话框挂在那里。
- 费用核算**不建模中国大陆法定节假日**（理由见上文「费用核算」），用工作日时段近似；
  中转端点若调整了价格或映射关系，价目表需要跟着改。
- 审计引擎是**静态**分析：它不执行代码，因此"未发现决定性风险"只代表规则没命中，
  不代表代码安全；结论里也如实这么写。
  要扩充就先跑 `capture-permission.mjs` 那类抓包脚本拿到真实 payload，再补渲染。
- 子代理卡片只呈现 CLI 下发的文本与工具调用；子代理的**独立 token 用量**仅在它自己发出
  `result` 帧时才统计，否则留空而不是估算。
---

## 开发过程中踩到的坑（都花了不少时间，记下来）

**1. `tauri.conf.json` 的 `app.windows` 与代码创建窗口会撞标签。**
本项目的窗口必须在 Rust 里创建（要把桥地址注入到页面脚本之前）。如果配置里也声明了
`label: "main"` 的窗口，setup 阶段会 panic：`a webview with label 'main' already exists`。
配置里的 `app.windows` 必须留空。

**2. 截图验证必须声明 DPI 感知，否则会把好布局误判成坏的。**
本机是 3072×1920 @200% 缩放。不调用 `SetProcessDpiAwarenessContext` 时，PowerShell 进程
被 DPI 虚拟化：`GetWindowRect` 返回逻辑像素（1293×876），而 `PrintWindow` 按物理像素渲染
（2586×1751），于是位图内容只占左上角、右边和下边是空白 —— 看起来就像布局被裁掉了。
`scripts/capture-window.ps1` 已修好，读窗口尺寸前先声明 `PER_MONITOR_AWARE_V2`。
排查任何 WebView2 界面问题时，先确认这一点，能省掉一整轮误诊。

**3. 一个 9/9 全过的测试套件，退出码却是崩溃。**

`permission-mode.mjs` 打印 `9/9 checks passed`，进程却以 `0xC0000409` 退出，stderr 是：

```
Assertion failed: !(handle->flags & UV_HANDLE_CLOSING), file src\win\async.c, line 76
```

这是 Windows 上 libuv 的 fail-fast：`process.exit()` 与 undici 正在关闭的 keep-alive socket
撞在同一 tick。**它专挑最快的套件**——`permission-mode` 不发模型回合，所以总是输掉这个竞态，
于是"全过 + 崩溃"同时出现，作为回归门禁等于狼来了。

分档实测（node v24.9.0）：settle 0 ms → 4 次全崩；25 ms → 4 次全崩；100 ms / 250 ms / 500 ms
→ 各 4 次全过。也就是说**加个 100 ms 的 sleep 就能"修好"** —— 但那是靠猜出来的时间掩盖原因，
换台慢机器就会复发。真正的修法是**不调 `process.exit()`**：设好 `process.exitCode` 后让事件
循环自然排空，socket 会在运行时拆除之前自己关完。实测 6/6 干净、且没有额外延迟。
这个约定集中在 `packages/bridge/test/harness.mjs` 的 `finish()` 里，并用一个 `unref()` 过的
定时器兜底防挂死（它不能维持事件循环，因此健康运行会立刻退出）。

教训：**先分清"测试在骗我"和"产品坏了"。** 崩溃发生在测试进程里，桥本身完全正常 ——
如果当时去改产品代码，就会为了一个测试问题引入真实缺陷。

**4. 把"用户正在用这个应用"也当成一种环境因素。**

启动测试时我看到两个说不通的现象：**一个没人要求就出现的会话**，以及**设置面板自己打开了**。
我先怀疑代码：读了 `startSession` 的全部调用方（只有按钮）、确认模板里没有 `<form>`／`@submit`／
autofocus、确认没有任何全局 `keydown` 绑定 —— 都无法解释。于是写了两个只读探针来量：
`first-run-watch.mjs` 从首帧起每 500ms 记录一次 DOM（结论：设置面板在 t+18.5s 自己出现，
而**同样的网页在浏览器里 40 秒纹丝不动**，所以差异在 Tauri/WebView2 环境里），
`input-trace.mjs` 装捕获阶段监听器记录页面收到的输入事件。

答案一行就出来了：

```
+ 0.7s  click  button.settingsRow "设置"      trusted=true
+ 4.5s  click  button.st__railItem "费用核算"  trusted=true
+14.4s  click  div.st__modelRow "deepseek-flash 移除"  trusted=true
```

`trusted=true` 意味着这是**真实的系统级鼠标输入**，不是合成事件 —— 是这个应用正开在我面前的
桌面上，而**用户本人在点它**。所谓"没人要求就出现的会话"，就是用户点了「开始会话」；"设置面板
自己打开"，就是用户点了「设置」。之前有一次应用"自己退出"，也是用户关掉了窗口。

**教训**：被测应用是一个会被人使用的真实窗口。遇到无法从代码解释的状态变化时，先问一句
"是不是有人在用它"，再去改代码 —— 否则会为一个不存在的 bug 动手，而真正的证据（`trusted`）
一行就能拿到。

**5. Vue 的 `scoped` 样式到不了子组件内部 —— 三个设置子页一直在裸奔。**

用户反馈"其他页面的文字样式太紧凑了"。查下来是一个从第一次提交就存在的缺陷：
`AuditPanel` / `BundledPanel` / `ImportPanel` 都用了同一套 `st__*` 类名，但那些规则**只写在
`SettingsPanel.vue` 的 `<style scoped>` 里**。Vue 的 scoped CSS 只作用于本组件模板的元素
（以及子组件的根元素），**不会作用到子组件内部的元素**，所以这三个面板拿到的是浏览器默认样式。

实测出来的差距（`_probe/scoped-style-audit.mjs` 列出"只在 scoped 块里定义、却被子组件使用"的类）：

| 类 | 应该 | 实际（修复前） |
| --- | --- | --- |
| `.st__h` | 15.5px / 600 | **16.38px**（`h3` 默认） |
| `.st__sub` | 13px / 20px / 弱化色 | **14px**，且是正文白色 |
| `.st__label` | 13px / 500 / 次级色 | **14px**，无字重与色阶 |

修法是把这 5 个**共享排版原语**（`.st__h` `.st__sub` `.st__label` `.st__hint` `.st__field`）
移进全局 `styles.css` —— 类名被四个组件共用，全局本来就是它们该待的地方；`SettingsPanel`
自己的模态外壳（`.st` `.st__scrim` `.st__panel` `.st__rail`…）仍然 scoped，因为没有别人用它。
移动脚本留在 `_probe/move-shared-styles.mjs`，审计脚本可以在改动后随时重跑。

**教训**：scoped 是"按组件文件"隔离的，不是"按视觉体系"隔离的。**共享的类名必须有共享的定义处**；
当同一个类名出现在多个组件里时，就该问一句"它的样式到底落在哪一个 scope 里"。
这两个脚本现在是常驻的：`scoped-style-audit.mjs` 能直接报出"只在 scoped 里定义却被子组件使用"
的类，比对着截图猜快得多。

---

## 产物

| 路径 | 说明 |
| --- | --- |
| `packages/desktop/src-tauri/target/release/claude-code-cn.exe` | 主程序（约 3.5 MB） |
| `packages/desktop/src-tauri/target/release/bundle/nsis/Claude Code CN_0.1.0_x64-setup.exe` | 安装包（约 306 MB） |

安装包为什么这么大，以及它换来什么：

| 组成部分 | 体积 | 说明 |
| --- | --- | --- |
| `claude.exe` | 231 MB | 内置 CLI。不装它，干净机器上装完也跑不了任何一轮对话 |
| WebView2 离线运行时 | 202 MB（压缩后约 205 MB） | `webviewInstallMode: offlineInstaller`。目标机器没有 WebView2 时用它本地安装，**不需要联网** |
| `node.exe` + 桥 + 技能 + 审计引擎 | 99 MB | sidecar |

代价是体积，收益是**彻底离线**：目标机器不需要预先装 Claude Code，也不需要能访问微软的下载源。若想换回小体积，把 `bundle.windows.webviewInstallMode` 改成 `downloadBootstrapper` 并设 `CCCN_SKIP_CLAUDE=1` 重新打包即可（两者都可独立开关）。

体积对比：Harness-CN 的 Electron 安装包 140 MB、主程序 233 MB。
