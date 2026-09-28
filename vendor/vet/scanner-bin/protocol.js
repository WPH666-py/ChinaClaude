/**
 * Scanner wire protocol (shared by client and scanner-bin).
 * @module dsh-plugin-vet/scanner-protocol
 */
/** 规则/引擎实现变更必须递增此版本——cache key 与缓存有效性校验都依赖它（round-6：R1 new 形态、R9 ReDoS 判定变更后未递增导致旧缓存中毒；round-7：R2 括号形态/R4 原型污染/R6 组合证据/R9 判定/R3 形态降级；round-7.1：R3 只读成员分类/R4 generic 不再降 info；round-7.2：R2 new X.constructor 复用 isConstructorCapture base 校验/R9 带标签 break 出口语义；round-8：新增 R13 网络外泄端点/R14 非 JS 脚本下载即执行；round-8.1：R14 大小写不敏感（PowerShell/cmd 命令不分大小写）、curl -o 落盘降 medium、flags 传播修复；round-9（0.1.15）：新增 R15 动态网络目标（N5，信息级观测）；round-10（0.1.16 加固批次）：R2 间接/前缀 eval·Function（globalThis.eval/(0,eval)）与 require 拼接折叠、R3 global.*process* 前缀形态（此前漏检为 info）、R4 Reflect.defineProperty、R9 sync 子进程变体与转义括号深度计数、R10 prepare 钩子、R14 python/ruby/perl 下载即执行模式、R15 undici sink。
 * round-11（0.1.21，P0-2 #9）：新增 R16 幽灵/僵尸依赖健康审计（声明 vs 代码引用 vs 实际安装的确定性观测；
 * info 级不扣分不改 verdict；capabilities 增 ghostDeps/zombieDeps）。
 * round-12（R17/R18 扫描面扩展）：新增 R17 !!js 配置注入检测（cordis.yml/cordis.patch.yml 等根级配置文件
 * 中的 !!js 表达式文本，仅提取不执行，单动词 info、动词+外联/凭据组合 high）与 R18 指令/技能注入观测
 * （AGENTS.md/CLAUDE.md 与 skills、*.skill 目录下 SKILL.md 的组合式文本特征，首版全 info）。
 * 均受 request.surface 门控；surface 并入缓存 key。
 * round-13（R19）：新增 R19 typosquat 观测（包名/依赖 vs 官方核心名编辑距离 ≤1 或同形，info 永不进 verdict）。
 * round-14（异常流对抗回归）：R18 匹配前剥离不可见字符（ZWSP 等打断规避）、R19 比较前 NFKC 归一
 * （全角同形规避）——规则行为变化，引擎版本递增使旧缓存失效。
 * round-15（0.3.2）：新增 R20 exec/spawn 族实参下载即执行（JS 内嵌 curl|sh 等形态，组合证据
 * high/medium，N2 解码并入；generic/测试文件降 info）——新增规则 + capability 提取行为变化，
 * 引擎版本递增使旧缓存失效。
 * round-16（0.3.3）：R20 绑定口径升级（解构别名/promisify/对象内嵌/属性链）+ N2 增 Array.join
 * 与 Buffer.from 拼接递归 + curl/wget/|sh 大小写不敏感 + 动态片段占位；R11 补 require('fs')
 * 直调与解构绑定 + N2 语料加 fs 足迹门控；R9 fork-bomb 加 child_process/worker_threads 绑定
 * 门控；stringyValue/numberyValue 补词法遮蔽防护；AST 面新增无扩展名/大写扩展名入口
 * （extOf 统一小写 + package.json bin/scripts 引用 + node shebang）——规则行为大改，
 * 引擎版本递增使旧缓存失效。
 * round-17（0.3.3）：R16 幽灵依赖改子路径前缀解析（declared.some(d => i === d || i.startsWith(d + '/'))）
 * ——父包已声明的 react/jsx-runtime 类子路径导入不再误报；父包未声明的子路径（ghost-pkg/sub）
 * 照旧判幽灵。规则行为变化，引擎版本递增使旧缓存失效。
 * round-22（0.3.4）：① capability require() 无实参崩溃修复（整扫描 ok:false）+ node: 前缀
 * 能力归一（hasNetwork/hasExec 此前漏记 → N1 误报隐藏能力）；② R1/R2 逃逸正则扩形态
 * （return (process) 括号包裹、globalThis['process'] 前缀元素访问——此前零命中）且 R1/R2
 * 从双副本改为单源导入；③ R1 别名解析补遮蔽（形参遮蔽 const c = x.constructor 的 critical
 * 误判）；④ R3 补 globalThis['process'].exit 元素访问形态（此前零命中）与解构成员形态
 * （const { exit } = process; exit(1) 此前只报 info）；⑤ R7 补 sk-proj- 与 github_pat_
 * 现行密钥格式（'-' 打散旧字符类整族漏报）；⑥ R2 顶级 require 判定收紧到真·模块顶层
 * （函数体 const require 此前被误当顶级降噪漏报）。规则行为变化，引擎版本递增使旧缓存失效。
 * 0.3.8（C4）：原生二进制感知——能力清单新增 hasNativeBinary/nativeBinaries（文件面证据：
 * 原生扩展名命中或 ELF/PE/Mach-O/wasm 魔数命中；命中文件不解析、不入 sourceCount）。
 * 输出形状变化（且扫描面自 0.3.8 起含原生扩展文件，cacheKey 随之漂移），引擎版本递增失效旧缓存。
 * 0.3.9（审查修复）：缓存写入门控（预算耗尽不缓存）、单文件容错元 finding、ast 环检测/深度帽、
 * FIFO 守卫与 extOf 基名化、R9 线性化、循环外 package.json 限量读——规则行为与形状均有变化。
 * 0.3.10（R13 误报治理）：R13 判定收紧——端点形状（① 散文/标签不再命中）、Tor label 校验
 * （② action.onion 不再命中）、守卫/拒绝名单与测试/CI 语境降 info（③⑤）、脱敏占位降 info
 * （④）——规则行为变化，旧缓存作废。
 * 0.3.11（R3 dev/ops 中间态）：根级明确开发/运维动词脚本（check-pr-title.mjs /
 * dev-install.mjs / uninstall.mjs / docker-init.mjs 等）内的 process.exit/reallyExit 从
 * critical 降为 high + message 标记 dev-script；getBuiltinModule/mainModule/module、
 * 运行时文件名（transport/cli/desktop/start-*）与 scripts/ 目录保持 critical——规则行为
 * 变化，旧缓存作废。
 * 0.3.12（审查修正）：上述「根级」改按 package.json 所在目录界定（仅深度 1 平铺）——
 * 首发版按 basename 深度无关匹配把 scripts/、lib/ 等嵌套文件也降档，与「scripts/ 是产品
 * 代码、运行时文件名不参与」立场矛盾；修正后嵌套文件一律不降，无 package.json 保守不降——
 * 规则行为变化，旧缓存作废。 */
export const ENGINE_VERSION = 'static-v26';
/** The rules of static-v26（规则集相对 v25 变化：0.3.13 新增 request.officialFamily——官方目录成员包的
 * 非授权源码产物（构建输出路径/压缩内容/.d.ts）里 critical/high 折 info 并加类别前缀（第三方只加
 * 前缀）；R12 支持 dsh.bundle.patch 有序数组并对非法形态报 high。前序 v25（相对 v24）变化：R3 dev/ops 中间态改**相对包根**的根级判定——
 * 0.3.11 首发的深度无关 basename 匹配会把 scripts/、lib/ 等嵌套的运行时文件一并降档（与
 * 「scripts/ 是产品代码、运行时文件名不参与」的立场矛盾），审查修正为：仅包根平铺
 * （相对 package.json 所在目录深度 1）的明确 dev/ops 动词脚本才降 critical→high+dev-script
 * 标记，无 package.json 上下文保守不降；getBuiltinModule/mainModule/module 与运行时文件名
 * 仍保持 critical）。 R8 is a meta finding emitted by the engine (scan timeout skip / per-file error skip);
 * R17/R18/R19 are surface-gated text/config rules (emitted by the engine, not per-file AST rules);
 * R20 is a per-file AST rule (exec/spawn-family argument download-and-exec, registry-driven);
 * OSV / OSV-T are engine-emitted data-source findings (OSV advisory board / transitive upstream-radar)
 * — 列入 RULE_IDS 供白名单式消费方完整枚举（round-16：此前只枚举 AST 规则，OSV 两码会静默丢失；
 * 0.3.9 review：R8 元 finding 同样由 engine 产出却漏列，白名单消费方会静默丢跳过提示）。 */
export const RULE_IDS = ['R1', 'R2', 'R3', 'R4', 'R5', 'R6', 'R7', 'R8', 'R9', 'R10', 'R11', 'R12', 'R13', 'R14', 'R15', 'R16', 'R17', 'R18', 'R19', 'R20', 'OSV', 'OSV-T'];
export const SEVERITIES = ['critical', 'high', 'medium', 'info'];
export const CONFIDENCES = ['certain', 'likely', 'heuristic'];
