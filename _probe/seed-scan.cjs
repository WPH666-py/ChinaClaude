#!/usr/bin/env node
// Scan a zstd-compressed tar (the published offline seed) for nested tar/pax entries
// without extracting it. zstd is decoded by node:zlib's createZstdDecompress.
//
//   node seed-scan.cjs <archive.zst> <needle> [needle...]
//
// For each needle it reports how many times the needle appears *as a path segment*
// inside a nested tar entry name (the pnpm store keeps every package under a
// node_modules/<name> path), plus the first few matching paths so the shape is visible.

const fs = require('node:fs')
const zlib = require('node:zlib')

const [, , archive, ...needles] = process.argv
if (!archive || needles.length === 0) {
  process.stderr.write('usage: node seed-scan.cjs <archive.zst> <needle> [needle...]\n')
  process.exit(2)
}

const report = new Map(needles.map((n) => [n, { count: 0, samples: [] }]))
const SAMPLE_LIMIT = 5
const OVERLAP = 256

let totalBytes = 0
let tail = Buffer.alloc(0)

function scan(buf) {
  const text = buf.toString('latin1')
  for (const needle of needles) {
    const seg = `node_modules/${needle}/`
    let from = 0
    for (;;) {
      const at = text.indexOf(seg, from)
      if (at === -1) break
      const r = report.get(needle)
      r.count += 1
      if (r.samples.length < SAMPLE_LIMIT) {
        // Walk back to the start of the nested entry name so the sample reads like a path.
        let s = at
        while (s > 0 && text.charCodeAt(s - 1) > 32) s -= 1
        let e = at + seg.length
        while (e < text.length && text.charCodeAt(e) > 32) e += 1
        r.samples.push(text.slice(s, Math.min(e, s + 160)))
      }
      from = at + seg.length
    }
  }
}

const src = fs.createReadStream(archive)
const zst = zlib.createZstdDecompress()
zst.on('data', (chunk) => {
  totalBytes += chunk.length
  const buf = tail.length ? Buffer.concat([tail, chunk]) : chunk
  scan(buf)
  tail = buf.subarray(Math.max(0, buf.length - OVERLAP))
})

zst.on('error', (err) => {
  process.stderr.write(`zstd error: ${err.message}\n`)
  process.exit(1)
})
src.on('error', (err) => {
  process.stderr.write(`read error: ${err.message}\n`)
  process.exit(1)
})
zst.on('end', () => {
  process.stdout.write(`decompressed ${totalBytes} bytes from ${archive}\n\n`)
  for (const [needle, r] of report) {
    process.stdout.write(`${needle}: ${r.count} path occurrences\n`)
    for (const s of r.samples) process.stdout.write(`    ${s}\n`)
    process.stdout.write('\n')
  }
})
src.pipe(zst)
