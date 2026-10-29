import { createRequire } from 'node:module'
import { qrMatrix } from '../packages/bridge/src/qr.mjs'

const require = createRequire(import.meta.url)
const ref = require(process.env.TEMP + '/qrcode-ref.js')

const maskFn = (r, c) => (r + c) % 3 === 0 // mask 2

function isFunctionCell(row, col, size) {
  // 三个定位图形 + 分隔符：8x8 方块
  if (row <= 7 && col <= 7) return true
  if (row <= 7 && col >= size - 8) return true
  if (row >= size - 8 && col <= 7) return true
  // 定时图形
  if (row === 6 || col === 6) return true
  // 格式信息（行 8 / 列 8 的一圈）
  if (row === 8 || col === 8) return true
  return false
}

function codewords(matrix) {
  const size = matrix.length
  const bits = []
  let upward = true
  for (let right = size - 1; right > 0; right -= 2) {
    if (right === 6) right = 5
    for (let step = 0; step < size; step += 1) {
      const row = upward ? size - 1 - step : step
      for (let k = 0; k < 2; k += 1) {
        const col = right - k
        if (isFunctionCell(row, col, size)) continue
        const value = Boolean(matrix[row][col]) !== maskFn(row, col)
        bits.push(value ? 1 : 0)
      }
    }
    upward = !upward
  }
  const bytes = []
  for (let i = 0; i + 8 <= bits.length; i += 8) {
    let byte = 0
    for (let j = 0; j < 8; j += 1) byte = (byte << 1) | bits[i + j]
    bytes.push(byte)
  }
  return { bytes, bits }
}

const qr = ref(0, 'M')
qr.addData('hello', 'Byte')
qr.make()
const n = qr.getModuleCount()
const theirs = codewords(Array.from({ length: n }, (_, r) => Array.from({ length: n }, (_, c) => qr.isDark(r, c))))
const mine = codewords(qrMatrix('hello'))
const hex = (list) => list.map((b) => b.toString(16).padStart(2, '0')).join(' ')
console.log('bits', theirs.bits.length, mine.bits.length)
console.log('ref :', hex(theirs.bytes))
console.log('mine:', hex(mine.bytes))
let first = -1
for (let i = 0; i < theirs.bits.length; i += 1) {
  if (theirs.bits[i] !== mine.bits[i]) {
    first = i
    break
  }
}
console.log('first differing bit index', first)
