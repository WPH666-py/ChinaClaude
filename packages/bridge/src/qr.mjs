/**
 * 二维码：手机访问扫码用的编码器。
 *
 * 这里不自己写编码算法，而是用随包内置的 MIT 实现（`vendor/qrcode.mjs`，qrcode-generator 1.4.4，
 * 作者 Kazuhiko Arase）。理由很实际：QR 的格式信息分两段绕角、掩模按罚分选、纠错码按块交错，
 * 自己写的第一版能生成「尺寸对、但扫不出来」的图；扫码是移动访问的唯一入口，不能靠运气。
 *
 * 输出 SVG：白底黑块、四周留 4 个模块的静区（少一点手机就扫不到）。
 */
import qrcode from './vendor/qrcode.mjs'

/**
 * 生成二维码矩阵：true = 黑。
 *
 * 纠错等级选 M（约 15% 冗余）：手机屏幕反光、手指遮挡都能读，同时不会因为等级太高而放大尺寸。
 */
export function qrMatrix(text) {
  const qr = qrcode(0, 'M')
  qr.addData(String(text), 'Byte')
  qr.make()
  const count = qr.getModuleCount()
  return Array.from({ length: count }, (_, row) => Array.from({ length: count }, (_, col) => qr.isDark(row, col)))
}

/** 输出 SVG：一个模块一个 1×1 方块，`shape-rendering: crispEdges` 避免浏览器抗锯齿糊边。 */
export function qrSvg(text, options = {}) {
  const matrix = qrMatrix(text)
  const margin = options.margin ?? 4
  const size = matrix.length + margin * 2
  const parts = []
  for (let row = 0; row < matrix.length; row += 1) {
    for (let col = 0; col < matrix.length; col += 1) {
      if (!matrix[row][col]) continue
      parts.push(`M${col + margin} ${row + margin}h1v1h-1z`)
    }
  }
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" width="${size * 8}" height="${size * 8}" shape-rendering="crispEdges">` +
    `<rect width="${size}" height="${size}" fill="#fff"/><path fill="#000" d="${parts.join('')}"/></svg>`
  )
}
