import { readFileSync, writeFileSync } from 'node:fs'

let text = readFileSync('packages/bridge/src/rollback.mjs', 'utf8').replace(/\r\n/g, '\n')

// 1) 备份改成带时间戳：允许连续回滚多次，也允许事后追查
text = text.replace(
  "  const backup = `${path}.before-rollback`\n  writeFileSync(backup, lines.join('\\n') + '\\n', 'utf8')",
  [
    '  // 每次回滚都留一份带时间戳的备份：只有一份 `.before-rollback` 时，第二次回滚会把第一次的退路覆盖掉，',
    '  // 表现就是「只能回滚有限次数」。',
    "  const backup = `${path}.before-rollback-${Date.now()}`",
    "  writeFileSync(backup, lines.join('\\n') + '\\n', 'utf8')",
  ].join('\n'),
)

// 2) 不允许把会话截成空文件：CLI 会说「No conversation found」并退出 1，会话就废了
text = text.replace(
  "  if (cut < 0) return { ok: false, error: '这个会话里没有可回滚的用户消息' }",
  [
    "  if (cut < 0) return { ok: false, error: '这个会话里没有可回滚的用户消息' }",
    '  /**',
    '   * 截到第一条之前 = 空文件。空的 .jsonl 不是「没有上下文」，而是 CLI 眼里的「会话不存在」：',
    '   * --resume 会直接 exit 1。所以第一条消息不能撤回，到边界就如实拒绝。',
    '   */',
    "  if (cut <= 0) return { ok: false, error: '这已经是会话里的第一条消息，撤回它会清空整份记录，无法继续' }",
  ].join('\n'),
)

writeFileSync('packages/bridge/src/rollback.mjs', text, 'utf8')
console.log('rollback: numbered backups + boundary guard')
