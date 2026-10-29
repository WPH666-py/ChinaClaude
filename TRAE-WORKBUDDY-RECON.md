# Trae / WorkBuddy 接入侦察报告（本机实测）

> 这份报告记录的是**这台机器上实际查到的事实**，以及由此得出的能力边界。它不是推测，命令都是可复现的。

## 结论

| 应用 | 能否被 ChinaClaude 当作模型后端 | 实际可用的接入方式 |
| --- | --- | --- |
| WorkBuddy（海外版 5.8.4） | **可以**（CLI 方向） | 桥把 Anthropic 请求翻译成 WorkBuddy 自带 CodeBuddy CLI 的 `-p` 调用，答案回转成 Anthropic JSON / SSE。首次需在该 CLI 内 `/login` |
| Trae CN 3.4.4 / TRAE SOLO 0.2.2 | **可以**（官方 CLI 2.0） | IDE 本身没有模型 API、登录态加密不可读；但官方 `traecli` 提供无头模式（`exec --json`、`-o` 最后一条消息、`--sandbox read-only`），登录与沙箱是它自己的能力。桥把请求翻译成一次 `traecli exec`，与 WorkBuddy 同构 |

## Trae CLI（本条为后续更新，覆盖下文旧结论）

- 安装（用户级，官方脚本）：`irm https://trae.cn/trae-cli/install_v2.ps1 | iex` → 本机 `traecli 0.209.1`，位于 `%LOCALAPPDATA%\Programs\TraeCLI\bin`；
- 登录：`traecli login`（浏览器授权）或 `traecli login --with-trae-pat`；`traecli login status` 可查；
- 无头调用（本机实测可用的参数组合）：`traecli exec --json --sandbox read-only --ephemeral -o <file> -- <prompt>`；
- **两个实测坑**：
  1. 文档里的 `-a/--ask-for-approval` 在 0.209.1 的 `exec` 上不存在（`unexpected argument`），必须去掉；
  2. 未登录时它不提示登录，而是先跑 `git ls-remote git@code.byted.org:...` 做「代码库认证」；本机没有 git 时报 git 找不到。桥把这条映射为 `requires-git-or-login`，并给出「装 Git for Windows 或先 login」两种修法。
- 桥端点：`GET /api/connectors/trae/cli`（可用性 + 登录状态）、`POST /api/connectors/trae/cli/login`、`POST /api/connectors/trae/cli/test`、`POST /proxy/trae/v1/messages`。

## WorkBuddy

- 安装位置：`D:\Workbuddy海外版\WorkBuddyAI\WorkBuddyAI.exe`（进程名 `WorkBuddyAI.exe`，运行时 6 个进程）
- 数据目录：`%USERPROFILE%\.workbuddy-ai`、`%USERPROFILE%\.workbuddy`
- 自带 CLI：`D:\Workbuddy海外版\WorkBuddyAI\resources\app.asar.unpacked\cli\dist\codebuddy-lite-wb.mjs`
  - `--help` 正常；`bin` 里声明了 `codebuddy` / `cbc` / `codebuddy-code`
  - 支持 `-p` 非交互、`--output-format json`、`--permission-mode dontAsk`、`--tools ""`
- **实测的关键行为**：未登录时**退出码为 0**，只在 stderr 写 `Authentication required. Please use /login`。只看退出码会得到「成功但空回答」，必须按 stderr 判定。
- 桌面端 token 加密（AES-GCM，需 App 自身原生绑定解密），无法直接复用；CLI 的登录态与桌面端相互独立。

验证命令：

```powershell
node "D:\Workbuddy海外版\WorkBuddyAI\resources\app.asar.unpacked\cli\dist\codebuddy-lite-wb.mjs" -p "只回复OK" --output-format json --permission-mode dontAsk --tools ""
```

## Trae（为什么不可行）

| 检查点 | 结果 |
| --- | --- |
| `%APPDATA%\Trae CN\User\globalStorage\storage.json` | 只有遥测、窗口状态、iCube 授权串；后者为 **opaque（加密/私有编码）**，不是 JWT，也不是 JSON |
| `state.vscdb`（SQLite，328 个键） | 唯一的 secret 是 `secret://{"extensionId":"vscode.github-authentication"}`，不是 Trae 登录态 |
| 安装目录 `D:\Trae\Trae CN` | 只有 `bin\trae.cmd`（启动 IDE）与 `ctx-cli.exe` |
| `ctx-cli.exe --help` | 是**文件操作** CLI：`ls / cat / write / grep / glob / mkdir / rm`，不是对话入口 |
| `%APPDATA%\Trae CN\ahanet\server.json` | TNC 网络配置（DNS 超时、QUIC、dispatch），**不是**本机 API |
| 应用资源里的 `127.0.0.1:*` | 只有调试端口 33418、MS 认证 40342、inspector 9229，没有 AI 服务 |
| `settings.json` | 存在 `trae.mcp.enableWorkspaceMcp`，说明 MCP 是官方配置项（本机为 `true`） |

结论：要反向调用 Trae 的模型，只剩两条路，且都需要用户授权：

1. **抓包**：让 Trae 走本机代理并信任 mitm 证书，观察真实请求/响应；
2. **官方 API**：若账号侧开通了可用的接口。

在没有真实报文之前，写出来的「Trae 代理」只能靠猜 —— 这违背本项目「不把不可用标成可用」的底线。

## Trae 的可用接入：MCP（反向）

`GET /api/connectors/trae/integration` 返回可直接粘贴的片段：

```json
{
  "mcpServers": {
    "cccn-office": {
      "command": "<node.exe 绝对路径>",
      "args": ["<仓库>\\packages\\bridge\\src\\mcp.mjs"],
      "env": { "CCCN_MCP_ROOT": "<要共享的工作区绝对路径>" }
    }
  }
}
```

在 Trae 的 MCP 设置里添加后，Trae 的智能体即可调用 `word_*` / `excel_*` / `ppt_*` 九个工具。

## 打包现状

`tauri build` 的 NSIS 阶段会 `HEAD https://go.microsoft.com/fwlink/?linkid=2124701` 并下载 WebView2 离线运行时（约 212 MB）。本机当前对该域名 **TLS 握手阶段即超时**，因此新安装包无法生成。最后一次成功且经 `verify:bundle` 五项检查的产物是 2026-10-23 03:05 的 NSIS 与 03:07 的 MSI（0.3.0）。
