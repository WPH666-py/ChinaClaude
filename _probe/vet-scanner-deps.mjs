/**
 * Does plugin-vet's static scanner work without the DSH runtime?
 *
 * The package's own CLI (`vet-gate`) is DSH-bound, but only because it registers through
 * `defineTool`. The scanner ENGINE is a separate compiled tree under `lib/scanner-bin/`, and if
 * that tree is DSH-free then the actual capability — static analysis of a plugin/package — can be
 * reused here. The distinction matters: the shell is DSH's, the analysis is not.
 *
 * Run: node _probe/vet-scanner-deps.mjs
 */
import { readFileSync, existsSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

const BASE = 'D:\\Claudecode-CN\\_probe\\plugins\\plugin-vet\\package\\lib'

function importsOf(file) {
  const text = readFileSync(file, 'utf8')
  const out = []
  for (const m of text.matchAll(/\bfrom\s*['"]([^'"]+)['"]/g)) out.push(m[1])
  for (const m of text.matchAll(/\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g)) out.push(m[1])
  for (const m of text.matchAll(/\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g)) out.push(m[1])
  return out
}

function resolveLocal(fromFile, spec) {
  const base = resolve(dirname(fromFile), spec)
  for (const c of [base, base + '.js', join(base, 'index.js')]) {
    try {
      if (existsSync(c) && statSync(c).isFile()) return c
    } catch {
      /* skip */
    }
  }
  return null
}

function walk(entry, max = 5000) {
  const seen = new Set()
  const externals = new Map()
  const queue = [[entry, entry.replace(BASE, '')]]

  while (queue.length && seen.size < max) {
    const [file, via] = queue.shift()
    if (seen.has(file)) continue
    seen.add(file)
    let specs
    try {
      specs = importsOf(file)
    } catch {
      continue
    }
    for (const spec of specs) {
      if (spec.startsWith('.')) {
        const next = resolveLocal(file, spec)
        if (next) queue.push([next, via])
      } else if (!spec.startsWith('node:')) {
        if (!externals.has(spec)) externals.set(spec, via)
      }
    }
  }
  return { files: seen.size, externals }
}

for (const entry of ['scanner/client.js', 'scanner/package-sources.js', 'scanner-bin/engine.js', 'report/render.js']) {
  const full = join(BASE, entry)
  console.log('='.repeat(70))
  console.log(entry)
  if (!existsSync(full)) {
    console.log('  MISSING')
    continue
  }
  const { files, externals } = walk(full)
  const dsh = [...externals.keys()].filter((s) => s.startsWith('@deepseek-ai/'))
  console.log(`  local files : ${files}`)
  console.log(`  externals   : ${[...externals.keys()].join(', ') || '(none)'}`)
  console.log(`  DSH         : ${dsh.join(', ') || '(NONE)'}`)
  for (const d of dsh) console.log(`      via ${externals.get(d)}`)
}
