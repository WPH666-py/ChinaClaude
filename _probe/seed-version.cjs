#!/usr/bin/env node
// Read the version of one package out of a zstd-compressed tar without extracting it.
//
//   node seed-version.cjs <archive.zst> <pkg> [pkg...]
//
// The archive is a nested pnpm seed: the outer tar holds the profile, and each package's
// own package.json appears inside. For every requested package this prints each JSON blob
// that follows a `node_modules/<pkg>/package.json` entry, so the version is read from the
// file itself rather than inferred from a path.

const fs = require('node:fs')
const zlib = require('node:zlib')

const [, , archive, ...pkgs] = process.argv
if (!archive || pkgs.length === 0) {
  process.stderr.write('usage: node seed-version.cjs <archive.zst> <pkg> [pkg...]\n')
  process.exit(2)
}

// A nested package.json is small; keep a generous window after its path header.
const WINDOW = 4096
const found = new Map(pkgs.map((p) => [p, new Set()]))

let tail = ''
let total = 0

function scan(text) {
  for (const pkg of pkgs) {
    const header = `node_modules/${pkg}/package.json`
    let from = 0
    for (;;) {
      const at = text.indexOf(header, from)
      if (at === -1) break
      const window = text.slice(at, at + WINDOW)
      const m = /"version"\s*:\s*"([^"]+)"/.exec(window)
      if (m) found.get(pkg).add(m[1])
      from = at + header.length
    }
  }
}

const src = fs.createReadStream(archive)
const zst = zlib.createZstdDecompress()
zst.on('data', (chunk) => {
  total += chunk.length
  const text = tail + chunk.toString('latin1')
  scan(text)
  tail = text.slice(-WINDOW)
})
zst.on('error', (e) => {
  process.stderr.write(`zstd error: ${e.message}\n`)
  process.exit(1)
})
zst.on('end', () => {
  process.stdout.write(`decompressed ${total} bytes\n\n`)
  for (const pkg of pkgs) {
    const versions = [...found.get(pkg)]
    process.stdout.write(`${pkg}: ${versions.length ? versions.join(', ') : 'NOT FOUND'}\n`)
  }
})
src.pipe(zst)
