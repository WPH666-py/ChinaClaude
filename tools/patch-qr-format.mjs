import { readFileSync, writeFileSync } from 'node:fs'

const path = 'packages/bridge/src/qr.mjs'
let text = readFileSync(path, 'utf8').replace(/\r\n/g, '\n')

const start = text.indexOf('function placeFormat(matrix, maskIndex) {')
const end = text.indexOf('/** 生成二维码矩阵', start)
if (start < 0 || end < 0) throw new Error('placeFormat anchor missing')

const replacement = `function placeFormat(matrix, maskIndex) {
  const size = matrix.length
  const bits = formatBits(maskIndex)
  const bitAt = (index) => ((bits >>> index) & 1) === 1

  /**
   * 15 位格式信息分两段绕角：前 8 位走横排（右端，再接到左上），后 7 位走竖排（底端，再接到左上）。
   * 以前两段都按「前 8 位竖、后 7 位横」写，结果每个版本都偏了一组模块 —— 尺寸对、内容错，
   * 扫出来是空白。下面的下标照 qrcode-generator（BSD/MIT 参考实现）与规范条文对齐。
   */
  // 竖排：0..5 在左上（行 0..5，列 8）；6..7 在 (7,8)/(8,8)；8..14 在左下（行 size-7..size-1，列 8）
  for (let i = 0; i <= 5; i += 1) matrix[i][8] = bitAt(i)
  matrix[7][8] = bitAt(6)
  matrix[8][8] = bitAt(7)
  for (let i = 8; i <= 14; i += 1) matrix[size - 15 + i][8] = bitAt(i)

  // 横排：0..7 在右上（行 8，列 size-1..size-8）；8 在 (8,7)；9..14 从 (8,5) 向左到 (8,0)
  for (let i = 0; i <= 7; i += 1) matrix[8][size - 1 - i] = bitAt(i)
  matrix[8][7] = bitAt(8)
  for (let i = 9; i <= 14; i += 1) matrix[8][15 - i - 1] = bitAt(i)

  matrix[size - 8][8] = true
}

`

text = text.slice(0, start) + replacement + text.slice(end)
writeFileSync(path, text, 'utf8')
console.log('format placement fixed')
