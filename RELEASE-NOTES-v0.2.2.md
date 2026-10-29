# ChinaClaude 0.2.2

**一句话**：这一版只修一件事 —— 安装包在别人的电脑上双击图标**没有反应**。修的是两个只在「装完之后」才会出现的启动 bug。

安装包（二选一，都是单文件、离线可用）：

| 文件 | 大小 | 安装方式 | 适合谁 |
| --- | --- | --- | --- |
| `ChinaClaude_0.2.2_x64-setup.exe` | 约 311 MB | NSIS，装到当前用户，**不需要管理员** | 自己电脑，最省事 |
| `ChinaClaude_0.2.2_x64_zh-CN.msi` | 约 347 MB | MSI，默认装到 `Program Files`，需要管理员 | 公司电脑、需要走 IT 统一部署 |

两个包都**内置**了 `claude.exe`、Node 运行时和 WebView2 离线安装器，所以断网、全新机器也能装完直接跑。

---

## 症状

在开发机上一切正常；打包发给别人，双击图标后：

- 桌面没有任何窗口出现；
- 任务管理器里 `claude-code-n.exe` 闪一下就没了；
- 事件日志里只有一条 `Faulting application name: claude-code-cn.exe`、`Exception code: 0xc0000409`。

因为 release 构建是 `windows_subsystem = "windows"`，**没有控制台可写**，panic 的输出没有任何地方能看到 —— 于是「启动失败」和「根本没启动」在用户眼里完全是同一件事。

## 原因一：外壳找不到自己的运行时（sidecar 路径对不上）

| 谁 | 以为运行时在哪 | 实际在哪 |
| --- | --- | --- |
| 外壳 | `<exe>\sidecar` | — |
| 安装包（`bundle.resources`） | — | `<exe>\resources\sidecar` |
| Tauri `resource_dir()` | Windows 上就是 exe 所在目录，不会再拼一层 `resources` | — |

找不到就让 `setup` 返回 `Err`，`Builder::build()` 上的 `.expect()` 随即 panic，进程退出。开发机上还有第二个候选 `env!("CARGO_MANIFEST_DIR")` —— 那是**编译期写死**的 checkout 路径，只有打包那台机器上存在。这就是「我这里好好的」的全部原因。

## 原因二：`\\?\` 开头的路径，Node 不认

路径修好之后，装完**还是**起不来，只是这次弹出了错误框（原因一里加的诊断开始起作用）：

```
Failed to setup app: error encountered during setup hook: bridge exited before reporting ready

bridge 输出：
Error: EISDIR: illegal operation on a directory, lstat 'C:'
    at Object.realpathSync (node:fs:2734:25)
    at toRealPath (node:internal/modules/helpers:63:13)
```

`resource_dir()` 返回的是 verbatim 形式 `\\?\C:\...`。Win32 的 `CreateProcess` 接受它，**Node 的模块解析器不接受**：它把盘符拆成 `C:` 去 `lstat`，得到一个目录，于是 `EISDIR`。桥一行业务代码都没跑到。同样地，debug 构建走 checkout 候选（普通路径），复现不了。

## 改了什么

1. `sidecar_dir()` 先试 `resource_dir\resources\sidecar`、再试 `resource_dir\sidecar`；checkout 只在 debug 构建里当最后一个候选。
2. 新增 `plain_path()`：把 `\\?\C:\...` 还原成 `C:\...`（`\\?\UNC\server\share` → `\\server\share`），启动桥时 `node.exe`、入口脚本、工作目录、`CCCN_SIDECAR_DIR` 全部用它。
3. 启动失败不再静默：`setup` 的 `Err` 与任何 panic 都写 `%LOCALAPPDATA%\ChinaClaude\logs\shell.log`，并弹 `MessageBoxW`（`extern "system"` 声明，不引新依赖）；桥的 stderr 逐行落盘并附在弹窗里，`shell.log` 还多一行 `[spawn] node=… entry=… cwd=…`。
4. 打包不再只靠肉眼：`claude-code-cn.exe --self-check` 会**真的把桥拉起来**（用 verbatim 形式传路径，正好复现用户场景），拿到 `CCCN_READY` 才算通过；`pnpm build` 末尾的 `verify:bundle` 断言候选路径、安装布局、握手结果、`installer.nsi` 与 MSI 的 `main.wxs` 载荷（含 WebView2）。`.github/workflows/desktop-bundle.yml` 在干净 runner 上跑同一套断言。

## 验证

- 用 `msiexec /a` 把 MSI 解到临时目录，再用解出来的布局跑 `--self-check` → `{"ok":true,"candidate":"resource_dir/resources/sidecar","node":true,"bridgeReady":true}`；
- 直接启动解出来的 exe → 窗口出现，桥监听 `127.0.0.1:43130`，`shell.log` 里 `[spawn]` 的路径是普通形式（没有 `\\?\`）；
- 同一套检查对「只拷 exe、不带 sidecar」的目录判失败（证明它真的在检查，而不是恒真）。

## 已知限制

- NSIS 版装到 `%LOCALAPPDATA%\Programs\ChinaClaude`，MSI 版装到 `Program Files`，两者**不要同时装**；
- 首次启动需要几秒（要拉起本地桥和 `claude.exe`），期间窗口是空的，属正常；
- 卸载不会删除 `%LOCALAPPDATA%\ChinaClaude`（会话记录、记忆、运行日志都在那里），需要彻底清除请手动删。
