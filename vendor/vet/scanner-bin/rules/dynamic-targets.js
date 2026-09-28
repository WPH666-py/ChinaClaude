import ts from 'typescript';
import { walk, stringyValue, lineOf } from '../ast.js';
import { tryDecodeLiteral } from '../decode.js';
function sinkOf(n) {
    // new WebSocket(url)：NewExpression 形态（fetch/http/net 都是普通调用）
    if (ts.isNewExpression(n) && n.expression !== undefined && ts.isIdentifier(n.expression) && n.expression.text === 'WebSocket') {
        return { kind: 'ws', argIndex: 0 };
    }
    const callee = n.expression;
    if (ts.isIdentifier(callee)) {
        if (callee.text === 'fetch')
            return { kind: 'fetch', argIndex: 0 };
        if (callee.text === 'WebSocket')
            return { kind: 'ws', argIndex: 0 };
        return null;
    }
    if (!ts.isPropertyAccessExpression(callee))
        return null;
    const name = callee.name.text;
    const base = callee.expression;
    const baseName = ts.isIdentifier(base) ? base.text : '';
    if ((name === 'request' || name === 'get') && (baseName === 'http' || baseName === 'https')) {
        return { kind: 'http', argIndex: 0 };
    }
    // round-9（0.1.16 加固）：undici.request/stream/pipeline/upgrade——undici 已在 N1 网络模块面，
    // R15 sink 补齐；首参按契约是 URL/字符串 → 未解析标识符照报（与 fetch 同口径）
    if ((name === 'request' || name === 'stream' || name === 'pipeline' || name === 'upgrade') && baseName === 'undici') {
        return { kind: 'fetch', argIndex: 0 };
    }
    if ((name === 'connect' || name === 'createConnection') && baseName === 'net') {
        return { kind: 'net', argIndex: 1 };
    }
    // require('http')/require('net') 直接属性访问形态：require('http').request(x)
    if (ts.isCallExpression(base)) {
        const rcallee = base.expression;
        if (!(ts.isIdentifier(rcallee) && rcallee.text === 'require'))
            return null;
        const spec = base.arguments.length > 0 && ts.isStringLiteral(base.arguments[0]) ? base.arguments[0].text : '';
        if ((name === 'request' || name === 'get') && (spec === 'http' || spec === 'https'))
            return { kind: 'http', argIndex: 0 };
        if ((name === 'connect' || name === 'createConnection') && spec === 'net')
            return { kind: 'net', argIndex: 1 };
    }
    return null;
}
/** 目标参数的静态可解性：resolved=可声明；dynamic=不可解；ambiguous=标识符未解析（http 表单歧义）；skip=无参数/对象表单。 */
function resolveTarget(node, sf) {
    if (node === undefined)
        return 'skip';
    if (ts.isObjectLiteralExpression(node))
        return 'skip'; // http.request({...}) options 表单，目标在字段里
    if (stringyValue(node, sf) !== undefined)
        return 'resolved';
    if (tryDecodeLiteral(node, sf) !== undefined)
        return 'resolved';
    if (ts.isIdentifier(node))
        return 'ambiguous';
    return 'dynamic';
}
function shouldFlag(kind, res) {
    if (res === 'dynamic')
        return true;
    // fetch/WebSocket 首参与 net host 参数按契约是 URL/字符串：未解析标识符也报（源码无法声明目标）。
    if (res === 'ambiguous')
        return kind === 'fetch' || kind === 'ws' || kind === 'net';
    return false;
}
/** R15 dynamic network target (N5): info/heuristic, observation only. */
export function run(sf, ctx) {
    const found = [];
    walk(sf, n => {
        if (!ts.isCallExpression(n) && !ts.isNewExpression(n))
            return;
        const sink = sinkOf(n);
        if (sink === null)
            return;
        // NewExpression.arguments 可选（`new WebSocket()` 无参数）；CallExpression.arguments 恒为数组
        const args = n.arguments ?? [];
        const target = args[sink.argIndex];
        const res = resolveTarget(target, sf);
        if (!shouldFlag(sink.kind, res))
            return;
        const sinkLabel = sink.kind === 'fetch' ? 'fetch' : sink.kind === 'ws' ? 'WebSocket' : sink.kind === 'http' ? 'http(s) 请求' : 'net 连接';
        const targetText = target === undefined ? '' : target.getText(sf).slice(0, 120).replace(/\s+/g, ' ');
        found.push({
            rule: 'R15',
            severity: 'info',
            confidence: 'heuristic',
            message: '网络目标动态构造，静态不可审计（N5）——' + sinkLabel + ' 的目标参数由运行时数据/表达式构成，源码无法声明目标主机；请结合运行时观测（N1 隐能力）确认其实际目标',
            evidence: targetText,
            line: lineOf(sf, n),
        });
    });
    return found;
}
