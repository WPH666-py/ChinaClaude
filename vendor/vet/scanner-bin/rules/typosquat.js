/** 精选核心官方包名（unscoped 部分）。数据来源：dsh-src/packages 核心集（2026-08）+ npm-public
 * 0.1.1-rc.2 官方族（round-15 首批 +9；round-15 复查对照已安装发行物 187 个官方包再 +5：遥测 row id
 * 对应包 dsh-session-telemetry(-otel) 文档可见、短名 dsh-goal 同形易仿、dsh-headless/dsh-mcp-client
 * 高装机面）。名单更新 = 引擎版本不变（规则数据，不进缓存 key 语义等价——cache 以文件内容哈希兜底，
 * 名单变化自然失效）。 */
export const OFFICIAL_CORE_NAMES = [
    'dsh', 'dsh-base', 'dsh-client', 'dsh-web', 'dsh-web-app', 'dsh-web-frontend',
    'dsh-cordis-host-runner', 'dsh-agent', 'dsh-agent-loop', 'dsh-subagent', 'dsh-tools',
    'dsh-tool-bash', 'dsh-tool-fs', 'dsh-tool-subagent', 'dsh-tool-cordis',
    'dsh-sdk-client', 'dsh-session', 'dsh-credentials', 'dsh-user-approval',
    'dsh-sandbox', 'dsh-fs', 'dsh-skill', 'dsh-llm', 'dsh-workflow',
    'dsh-session-telemetry-otel', 'dsh-session-telemetry', 'dsh-goal', 'dsh-headless',
    'dsh-mcp-client',
    'dsh-api-gateway', 'dsh-app-boot', 'dsh-host-webserver', 'dsh-client-connection',
];
/** Levenshtein 距离（DP，两串全小写；名字都很短，代价可忽略）。
 * 上限截断到 2（本规则只关心 ≤1；截断语义：0/1 精确，≥2 一律记 2——判定 "≤1" 不受影响）。 */
function levenshtein(a, b) {
    const m = a.length;
    const n = b.length;
    if (Math.abs(m - n) > 1)
        return 2; // 提前剪枝：长度差 >1 则距离必 ≥1，>1 时直接放弃
    let prev = new Array(n + 1);
    let cur = new Array(n + 1);
    for (let j = 0; j <= n; j++)
        prev[j] = j;
    for (let i = 1; i <= m; i++) {
        cur[0] = i;
        for (let j = 1; j <= n; j++) {
            const cost = a[i - 1] === b[j - 1] ? 0 : 1;
            cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
            if (cur[j] > 1)
                cur[j] = 2;
        }
        const t = prev;
        prev = cur;
        cur = t;
    }
    return prev[n];
}
/** 视觉同形变体（l↔1、o↔0、i↔1、-↔_、s↔5）——转换后相等的也判仿冒。 */
const HOMOGLYPH_MAP = {
    l: '1', i: '1', o: '0', s: '5', '-': '_',
};
function homoglyphFold(s) {
    let out = '';
    for (const c of s.toLowerCase())
        out += HOMOGLYPH_MAP[c] ?? c;
    return out;
}
/** 判定一个候选名是否疑似官方名的仿冒（编辑距离 ≤1 或同形折叠后相等）；官方名本身返回 false。
 * 比较前 NFKC 归一（全角/兼容字符 → 半角；"ｄｓｈ" → "dsh"）。归一后相等但原始串不同 =
 * 视觉同形仿冒；原始串精确相同 = 官方名本身，不报（内容基线管同名的篡改）。 */
export function isTyposquatOf(candidate, official) {
    const a = candidate.toLowerCase();
    const b = official.toLowerCase();
    if (a === b)
        return false;
    const na = a.normalize('NFKC');
    const nb = b.normalize('NFKC');
    if (na === nb)
        return true;
    if (levenshtein(na, nb) <= 1)
        return true;
    if (homoglyphFold(na) === homoglyphFold(nb))
        return true;
    return false;
}
/** 提取 package.json 中的候选名：自身 name + dependencies/peerDependencies 键。 */
function candidateNames(pkg) {
    const out = [];
    const push = (v) => {
        if (typeof v === 'string' && v !== '')
            out.push(v);
    };
    push(pkg.name);
    for (const key of ['dependencies', 'peerDependencies', 'devDependencies', 'optionalDependencies']) {
        const deps = pkg[key];
        if (typeof deps !== 'object' || deps === null)
            continue;
        for (const name of Object.keys(deps))
            push(name);
    }
    return out;
}
/** 取包名的 unscoped 部分（@scope/name → name；name → name）。 */
function unscoped(name) {
    const slash = name.indexOf('/');
    return slash === -1 ? name : name.slice(slash + 1);
}
/**
 * 对 package.json 内容跑 R19。content = JSON 文本；file = 路径（恒 package.json）。
 * 产出 info/heuristic 观测，永不进 verdict。
 */
export function runTyposquat(content, file) {
    const found = [];
    let pkg;
    try {
        pkg = JSON.parse(content);
    }
    catch {
        return found;
    }
    const seen = new Set();
    for (const cand of candidateNames(pkg)) {
        if (cand === '')
            continue;
        const base = unscoped(cand);
        for (const official of OFFICIAL_CORE_NAMES) {
            if (!isTyposquatOf(base, official))
                continue;
            const key = cand + '→' + official;
            if (seen.has(key))
                continue;
            seen.add(key);
            found.push({
                rule: 'R19',
                severity: 'info',
                confidence: 'heuristic',
                file,
                message: '疑似 typosquat：包名/依赖 ' + cand + ' 与官方 ' + official + ' 拼写相近（编辑距离 ≤1 或同形）（P4/G-9 形态，仅观测）',
                evidence: cand + ' vs official:' + official,
            });
        }
    }
    return found.slice(0, 8); // 每包上限 8 条，防大依赖清单刷屏
}
