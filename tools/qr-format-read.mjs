import { createRequire } from 'node:module'
import { qrMatrix } from '../packages/bridge/src/qr.mjs'

const require = createRequire(import.meta.url)
const ref = require(process.env.TEMP + '/qrcode-ref.js')

/** 从矩阵里读回 15 位格式信息（copy1）。 */
function readFormat(matrix) {
  const bits = []
  const push = (v) => bits.push(v ? 1 : 0)
  for (let i = 0; i <= 5; i += 1) push(matrix[i][8])
  push(matrix[7][8])
  push(matrix[8][8])
  push(matrix[8][7])
  for (let i = 9; i <= 14; i += 1) push(matrix[15 - i - 1][8])
  void bits
  // 上面顺序其实不是位序；直接按规范位序取值
  bits.length = 0
  const at = (index) => {
    // 位序 index 对应的模块位置
    if (index <= 5) return matrix[index][8]
    if (index === 6) return matrix[7][8]
    if (index === 7) return matrix[8][8]
    if (index === 8) return matrix[8][7]
    return matrix[14 - index][8]
  }
  let value = 0
  for (let i = 0; i < 15; i += 1) if (at(i)) value |= 1 << i
  return value ^ 0x5412
}

const qr = ref(0, 'M')
qr.addData('hello', 'Byte')
qr.make()
const n = qr.getModuleCount()
const theirMatrix = Array.from({ length: n }, (_, r) => Array.from({ length: n }, (_, c) => qr.isDark(r, c)))
const mine = qrMatrix('hello')

for (const [name, matrix] of [
  ['ref', theirMatrix],
  ['mine', mine],
]) {
  const raw = readFormat(matrix)
  const ec = (raw >> 13) & 0b11
  const mask = (raw >> 10) & 0b111
  console.log(name, 'format raw', raw.toString(2).padStart(15, '0'), 'ec', ec, 'mask', mask)
}
