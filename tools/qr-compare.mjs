import { createRequire } from 'node:module'
import { qrMatrix } from '../packages/bridge/src/qr.mjs'

const require = createRequire(import.meta.url)
const ref = require(process.env.TEMP + '/qrcode-ref.js')

function reference(text) {
  // 该库默认字节模式，'Byte' 模式 + 纠错等级 'M'。
  const qr = ref(0, 'M')
  qr.addData(text, 'Byte')
  qr.make()
  const count = qr.getModuleCount()
  return Array.from({ length: count }, (_, r) => Array.from({ length: count }, (_, c) => qr.isDark(r, c)))
}

const samples = [
  'http://192.168.1.16:17890/_lan?key=2e2de66e8f6b52b4260c',
  'hello',
  'http://127.0.0.1:43130/pair?code=123456&phone=1',
  'https://example.com/a?b=c#d',
]

let failures = 0
for (const text of samples) {
  const mine = qrMatrix(text)
  const theirs = reference(text)
  if (mine.length !== theirs.length) {
    console.log(`SIZE MISMATCH ${mine.length} vs ${theirs.length} for ${text.slice(0, 24)}`)
    failures += 1
    continue
  }
  let diff = 0
  for (let r = 0; r < mine.length; r += 1) {
    for (let c = 0; c < mine.length; c += 1) if (Boolean(mine[r][c]) !== Boolean(theirs[r][c])) diff += 1
  }
  console.log(`${diff === 0 ? 'MATCH' : 'DIFF(' + diff + ')'} ${mine.length}x${mine.length} ${text.slice(0, 40)}`)
  if (diff !== 0) failures += 1
}
console.log(failures === 0 ? 'ALL MATCH' : `FAILURES ${failures}`)
process.exit(failures === 0 ? 0 : 1)
