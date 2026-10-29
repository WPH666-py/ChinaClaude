import { createRequire } from 'node:module'
import { qrMatrix } from '../packages/bridge/src/qr.mjs'

const require = createRequire(import.meta.url)
const ref = require(process.env.TEMP + '/qrcode-ref.js')

const text = 'hello'
const qr = ref(0, 'M')
qr.addData(text, 'Byte')
qr.make()
const n = qr.getModuleCount()
const mine = qrMatrix(text)
const diffs = []
for (let r = 0; r < n; r += 1) {
  for (let c = 0; c < n; c += 1) {
    const a = Boolean(mine[r][c])
    const b = qr.isDark(r, c)
    if (a !== b) diffs.push([r, c, a ? 'mine-dark' : 'mine-light'])
  }
}
console.log('count', diffs.length)
console.log(JSON.stringify(diffs))
console.log('ref mask', qr._dataCache ? 'ok' : 'ok')
