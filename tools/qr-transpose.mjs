import { createRequire } from 'node:module'
import { qrMatrix } from '../packages/bridge/src/qr.mjs'

const require = createRequire(import.meta.url)
const ref = require(process.env.TEMP + '/qrcode-ref.js')

const qr = ref(0, 'M')
qr.addData('hello', 'Byte')
qr.make()
const n = qr.getModuleCount()
const mine = qrMatrix('hello')

let straight = 0
let transposed = 0
for (let r = 0; r < n; r += 1) {
  for (let c = 0; c < n; c += 1) {
    if (Boolean(mine[r][c]) !== qr.isDark(r, c)) straight += 1
    if (Boolean(mine[r][c]) !== qr.isDark(c, r)) transposed += 1
  }
}
console.log('straight diffs', straight, 'transposed diffs', transposed)
