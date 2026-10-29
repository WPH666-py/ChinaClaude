#!/usr/bin/env node
// Diagnostic: show the raw bytes around the first `dsh-mobile` occurrence in the seed,
// so the tar header layout (and therefore the right way to find a nested package.json)
// is visible instead of guessed.

const fs = require('node:fs')
const zlib = require('node:zlib')

const archive = process.argv[2]
const needle = process.argv[3] || 'dsh-mobile'
const SHOW = 600
const OVERLAP = 2048

let text = ''
let done = false

const src = fs.createReadStream(archive)
const zst = zlib.createZstdDecompress()
zst.on('data', (chunk) => {
  if (done) return
  text += chunk.toString('latin1')
  const at = text.indexOf(needle)
  if (at !== -1) {
    done = true
    const start = Math.max(0, at - 200)
    const slice = text.slice(start, start + SHOW)
    const visible = slice.replace(/[\u0000-\u001f]/g, (c) => {
      if (c === '\u0000') return '·'
      if (c === '\n') return '\\n'
      return `\\x${c.charCodeAt(0).toString(16).padStart(2, '0')}`
    })
    process.stdout.write(`first "${needle}" at decompressed offset ${at}\n\n`)
    process.stdout.write(visible + '\n')
    src.destroy()
    zst.destroy()
  } else if (text.length > OVERLAP) {
    text = text.slice(-OVERLAP)
  }
})
zst.on('close', () => process.exit(0))
zst.on('error', (e) => {
  process.stderr.write(`zstd error: ${e.message}\n`)
  process.exit(1)
})
src.pipe(zst)
