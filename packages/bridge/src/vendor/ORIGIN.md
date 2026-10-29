# vendor/qrcode.mjs

- 来源：`qrcode-generator` 1.4.4（https://github.com/kazuhikoarase/qrcode-generator）
- 作者：Kazuhiko Arase
- 许可证：MIT（保留源文件顶部版权头）
- 取用方式：从 unpkg 下载原文件（56,694 字节），末尾加一行 `export default qrcode;` 转成 ESM。
- 为什么内置：移动访问靠扫码进入，客户端必须离线生成二维码；本机没有 qrencode，也不允许运行时联网安装。
- 用途：只调用 `qrcode(0, 'M')` + `addData(text, 'Byte')` + `make()` + `isDark()`，由 `src/qr.mjs` 包一层输出 SVG。
- 校验：`tools/qr-compare.mjs` 与同版本库直出的矩阵逐模块比对（尺寸 + 全部模块一致）。
