import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const ref = require(process.env.TEMP + '/qrcode-ref.js')
const qr = ref(0, 'M')
qr.addData('hello', 'Byte')
qr.make()
const n = qr.getModuleCount()

// 参考实现自报的掩模：qrcode-generator 内部用 _maskPattern
console.log('ref mask =', qr._maskPattern ?? 'unknown', 'size', n)
