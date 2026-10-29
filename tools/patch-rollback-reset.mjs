import { readFileSync, writeFileSync } from 'node:fs'

const file = 'packages/bridge/src/rollback.mjs'
let text = readFileSync(file, 'utf8').replace(/\r\n/g, '\n')
const anchor = "  if (wanted !== '') {"
if (!text.includes(anchor)) throw new Error('anchor missing')
if (text.includes('cut = -1\n')) {
  // already patched
} else {
  text = text.replace(
    anchor,
    [
      anchor,
      '    // 指定了原文就不该再沿用「最后一条」的结果：否则点错的消息会退掉整轮。',
      '    cut = -1',
    ].join('\n'),
  )
  writeFileSync(file, text, 'utf8')
}
console.log('reset ok')
