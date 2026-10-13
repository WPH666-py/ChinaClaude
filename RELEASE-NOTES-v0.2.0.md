# ChinaClaude 0.2.0

**一句话**：顶部加上常驻菜单栏（照搬 Harness-CN 的十项），并把十个 DSH 插件的能力内置进客户端。

安装包：`ChinaClaude_0.2.0_x64-setup.exe`（NSIS，当前用户安装，无需管理员）。
数据目录：`%LOCALAPPDATA%\ChinaClaude\`。

---

## 一、顶部菜单栏

```
重启 · 运行日志 · 插件管理 · 检查更新 · API 密钥 · 作者信息 · 休闲食品商城 · 评价与反馈 · 开发者工具 · 退出
```

| 菜单项 | 说明 |
| --- | --- |
| 重启 | 重启整个应用（先走退出路径杀掉桥进程，避免新旧桥抢端口） |
| 运行日志 | 桥接进程日志窗口：最近 2000 行环形缓冲 + 落盘 `logs\bridge.log`，按游标增量刷新；被丢弃的行数会显示，不假装日志完整 |
| 插件管理 | 内置插件清单（可展开看"怎么内置的/证据路径/端点"），并作为各功能的入口 |
| 检查更新 | 手动检查：**无论有没有更新都回一句话**；自动检查仍然只在有得装时才弹窗 |
| API 密钥 | 直达「设置 → 模型」分区 |
| 作者信息 | 作者卡片，微信号点击复制（异步剪贴板失败时回退到选区复制） |
| 休闲食品商城 | 9 件商品的网格，**图片随包发布**（离线可看），点开是外部链接 |
| 评价与反馈 | 先落盘保存，再给出预填好的邮件；**不会假装已经发送** |
| 开发者工具 | 打开 webview DevTools（release 构建已开启 `devtools` feature） |
| 退出 | 退出应用 |

设计取舍：菜单栏是自绘的条，站在 `.frame` 之外（flex 兄弟节点），不改动侧栏那套网格收起规则。

## 二、内置的十个插件

| 上游插件 | 本版怎么内置 | 入口 |
| --- | --- | --- |
| `@jieai/dsh-plugin-vet` 0.3.12 | 扫描引擎**原样内置**（20 条规则） | 设置 → 安全审计 · `POST /api/vet/scan` |
| `@liustack/modlens` 3.26.1（随包 3.26.5） | 技能随包 + 新增取证据端点 | 插件管理 → 图片理解 · `POST /api/vision/read` |
| `@vectorize-io/hindsight-coding-agents` 0.8.0 | 自建**项目记忆**：按工作目录存条目，可导出 `CLAUDE.memory.md`（块级合并，标记外内容不动） | 插件管理 → 项目记忆 |
| `billion-context-dsh` 0.2.26 | 自建**上下文**：按事件统计 token 与缓存命中、给出压缩建议、一键 `/compact` | 插件管理 → 上下文 |
| `dsh-chat-import` 0.17.1 | 自建**导入会话**：直读 Claude Code 的 `projects/*.jsonl`，`--resume` 继续 | 设置 → 导入会话 |
| `dsh-cost-meter` 1.7.28 | 自建**计价**：DeepSeek 峰谷价目表，按轮计费、区分缓存命中 | 侧栏用量 · 插件管理 → 费用统计 |
| `dsh-rule-engine` 0.6.4 | 自建**规则引擎**：关键字/正则命中即标注，可追加提示或标记拦截 | 插件管理 → 规则引擎 |
| `dsh-defend` 0.3.21 | 自建**安全防护**：扫密钥/危险命令/数据外传，**只记录隐去后的片段** | 插件管理 → 安全防护 |
| `@goodandready/dsh-time-machine` 0.1.22 | 自建**时间机器**：文件副本快照 + 比对 + 单文件回滚，**不依赖 git** | 插件管理 → 时间机器 |
| `@xbzbing/dsh-git-panel` 1.4.0 | 自建**代码管理**：状态/差异/历史/提交（未装 git 时给安装提示，不装样子） | 插件管理 → 代码管理 |

**"内置"分两种，界面上写清楚**：`vendored`（随包携带上游文件）与 `native`（按同一思路重写）。
把两者混成一句"已内置"，会让"与上游一致"这句话无法核对 —— 所以每行都标了类别，并给出证据路径与端点。

## 三、新增桥接接口

`/api/plugins`、`/api/shell/logs`（+`/clear`、`/reveal`）、`/api/shell/author`、`/api/shop/catalog`、
`/api/feedback`、`/api/memory`、`/api/rules`、`/api/checkpoints`、`/api/defend`、`/api/git`、
`/api/vision/status|images|read`；`/api/health` 增加 `appVersion`。

## 四、数据目录

```
%LOCALAPPDATA%\ChinaClaude\
  logs\bridge.log          运行日志
  memory\<项目>-<hash>.json 项目记忆
  checkpoints\<项目>+<hash>\ 时间机器快照
  defend\{log.jsonl,stats.json} 安全防护记录与计数
  rules.json               规则
  feedback.jsonl           反馈
```

路径只在 `packages/bridge/src/paths.mjs` 决定一次；`CCCN_DATA_DIR` 可整体改写到别处（测试就是这么做的）。

## 五、安全与诚实性上的三条硬约定

1. **安全防护只看不改**：命中会记录、计数、给裁决，但**不改写事件内容** —— 让界面显示的内容与模型
   看到的输入不一致，比它想遮住的问题更糟。记录里只保留隐去后的片段。
2. **不假装成功**：没有服务器就不说"已发送"；没装 git 就说没装；modlens 缺视觉 provider 时转述
   `doctor` 的原话。四个失败态（缺文件、缺 provider、超时、非零退出）各自有各自的说明。
3. **路径安全**：所有来自页面的路径必须绝对路径且存在；回滚路径必须留在工作目录内（`..`、盘符路径、
   指向外部的 junction 全部拒绝并说明原因）。

## 六、验证

- 桥接全量冒烟：`_probe/smoke-shell.mjs` 起真桥、打全部新端点（含坏正则、密钥样本、非 git 目录）。
- 类型检查：`pnpm --filter @cccn/web typecheck` 通过。
- 各功能模块的单测在各自的实现里跑过（含越权路径、损坏存储、符号链接逃逸等边界）。

## 七、已知限制

- **本机没装 git** 时，代码管理窗口无法工作（会给出国内可用的安装方式与「重新检测」）。
- **图片理解需要一个视觉 provider**（Gemini / OpenAI 兼容 / Claude CLI 等）；没有时窗口显示
  `modlens doctor` 给出的缺失项与修复命令，功能不可用但不报假。
- 时间机器是**文件副本**快照：跳过 `.git`、`node_modules`、`dist` 等目录与 5 MB 以上单文件，
  每个工作区默认保留最近 20 个快照。它不是 git 的替代品。
- Gitee 的附件上限是 100 MB，安装包小于该值，两个源都能取到。
