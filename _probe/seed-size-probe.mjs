#!/usr/bin/env node
/**
 * How small can this seed get? The published offline package has to stay under Gitee's
 * 100 MiB attachment cap, and the rc.24 seed (now carrying dsh-mobile, dsh-wechat and
 * dsh-web-mobile) came out at 124.1 MiB at prepare-shell's default zstd -19.
 *
 * This rebuilds the archive from the staged seed at several zstd levels and reports each
 * size, so the choice is made on measurements instead of a guess. It writes only into
 * <tmpdir>, never touching dist-artifacts.
 *
 *   node seed-size-probe.mjs <seed-dir> <tar-module-dir> <level> [level...]
 */

import { createReadStream, createWriteStream, mkdirSync, rmSync, statSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { pipeline } from 'node:stream/promises'
import { createZstdCompress, constants as zlibConstants } from 'node:zlib'

const [, , seedDir, tarMainFile, ...levelArgs] = process.argv
if (!seedDir || !tarMainFile || levelArgs.length === 0) {
  process.stderr.write('usage: node seed-size-probe.mjs <seed-dir> <tar-main-file> <level> [level...]\n')
  process.exit(2)
}

// tar 7 ships a minified commonjs build as its `main`; import it by the exact file the
// package declares so this probe cannot silently pick a different build. Node wraps that
// CJS module under `default`, so unwrap it before taking `create`.
const tarNamespace = await import(
  new URL('file://' + resolve(tarMainFile).replace(/\\/g, '/')).href
)
const tarModule = tarNamespace.create ? tarNamespace : tarNamespace.default
const createTar = tarModule.create
if (typeof createTar !== 'function') {
  process.stderr.write(`tar module did not expose create(); keys: ${Object.keys(tarNamespace).join(', ')}\n`)
  process.exit(1)
}

const root = resolve(seedDir)
const work = join(tmpdir(), 'harness-cn-seed-probe')
mkdirSync(work, { recursive: true })
const tarPath = join(work, 'seed.tar')

process.stdout.write(`seed: ${root}\n`)
process.stdout.write(`work: ${work}\n\n`)

process.stdout.write('building tar (noMtime, portable)...\n')
const started = Date.now()
rmSync(tarPath, { force: true })
createTar(
  { cwd: root, file: tarPath, noMtime: true, portable: true, sync: true },
  readdirSync(root),
)
const tarBytes = statSync(tarPath).size
process.stdout.write(`tar: ${(tarBytes / 1024 / 1024).toFixed(1)} MiB in ${((Date.now() - started) / 1000).toFixed(0)}s\n\n`)

const CAP = 100 * 1024 * 1024
for (const levelArg of levelArgs) {
  const level = Number(levelArg)
  const out = join(work, `seed-z${String(level)}.tar.zst`)
  rmSync(out, { force: true })
  const begin = Date.now()
  await pipeline(
    createReadStream(tarPath),
    createZstdCompress({ params: { [zlibConstants.ZSTD_c_compressionLevel]: level } }),
    createWriteStream(out),
  )
  const bytes = statSync(out).size
  const mb = bytes / 1024 / 1024
  process.stdout.write(
    `zstd -${String(level)}: ${mb.toFixed(1)} MiB (${bytes} B)  ` +
      `under Gitee cap: ${bytes <= CAP ? 'YES' : 'no'}  ` +
      `(${((Date.now() - begin) / 1000).toFixed(0)}s)\n`,
  )
  rmSync(out, { force: true })
}

rmSync(tarPath, { force: true })
process.stdout.write('\ndone\n')
