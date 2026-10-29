import { readFileSync, writeFileSync } from 'node:fs'

const file = 'packages/bridge/src/rollback.mjs'
let text = readFileSync(file, 'utf8').replace(/\r\n/g, '\n')

// 1) 指定文本但没匹配到 → 报错，不能退化成「退掉最后一条」（那会在用户点错时悄悄吃掉一轮）
const anchor = "  if (cut < 0) return { ok: false, error: '这个会话里没有可回滚的用户消息' }"
if (!text.includes(anchor)) throw new Error('fallback anchor missing')
text = text.replace(
  anchor,
  [
    "  if (wanted !== '' && cut < 0) {",
    "    return { ok: false, error: '没找到这条消息：它可能已经被回滚过，或记录还没落盘' }",
    '  }',
    "  if (cut < 0) return { ok: false, error: '这个会话里没有可回滚的用户消息' }",
  ].join('\n'),
)

// 2) 截断前留一份备份：回滚本身也是一种删除，用户点错了要能捞回来
const writeAnchor = '  writeFileSync(path, lines.slice(0, cut).join(\'\\n\') + (cut > 0 ? \'\\n\' : \'\'), \'utf8\')'
if (!text.includes(writeAnchor)) throw new Error('write anchor missing')
text = text.replace(
  writeAnchor,
  [
    "  // 备份：回滚是删除操作，点错了必须能捞回来。只留最近一份，避免目录里堆满历史。",
    "  const backup = `${path}.before-rollback`",
    '  writeFileSync(backup, lines.join(\'\\n\') + \'\\n\', \'utf8\')',
    '',
    '  writeFileSync(path, lines.slice(0, cut).join(\'\\n\') + (cut > 0 ? \'\\n\' : \'\'), \'utf8\')',
  ].join('\n'),
)

// 3) 返回值带上备份路径
text = text.replace(
  "  return { ok: true, path, kept: cut, removed: removedLines, removedText }",
  "  return { ok: true, path, backup, kept: cut, removed: removedLines, removedText }",
)

writeFileSync(file, text, 'utf8')
console.log('rollback hardened')
