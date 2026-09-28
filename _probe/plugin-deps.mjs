/**
 * Transitive dependency verdict for each requested plugin's CLI entry point.
 *
 * The earlier one-level check was WRONG for plugin-vet: its gate CLI looked self-contained at
 * depth 1 but reaches `@deepseek-ai/dsh-tools` three levels down. A shallow check on a bundler
 * output is worth nothing, so this walks the whole local import graph.
 *
 * Run: node _probe/plugin-deps.mjs
 */
import { readFileSync, existsSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

const ROOT = 'D:\\Claudecode-CN\\_probe\\plugins'

function importsOf(file) {
  const text = readFileSync(file, 'utf8')
  const out = []
  for (const m of text.matchAll(/\bfrom\s*['"]([^'"]+)['"]/g)) out.push(m[1])
  for (const m of text.matchAll(/\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g)) out.push(m[1])
  for (const m of text.matchAll(/\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g)) out.push(m[1])
  return out
}

/** Resolve a relative specifier to a real file, trying the usual ESM/CJS candidates. */
function resolveLocal(fromFile, spec) {
  const base = resolve(dirname(fromFile), spec)
  const candidates = [
    base,
    base + '.js',
    base + '.mjs',
    base + '.cjs',
    join(base, 'index.js'),
    join(base, 'index.mjs'),
  ]
  for (const c of candidates) {
    try {
      if (existsSync(c) && statSync(c).isFile()) return c
    } catch {
      /* skip */
    }
  }
  return null
}

/**
 * Walk the graph from `entry`, collecting every external specifier reached.
 * Bounded so a pathological graph cannot spin.
 */
function walk(entry, maxFiles = 4000) {
  const seen = new Set()
  const externals = new Map() // spec -> shortest path that reached it
  const queue = [[entry, entry]]

  while (queue.length > 0 && seen.size < maxFiles) {
    const [file, path] = queue.shift()
    if (seen.has(file)) continue
    seen.add(file)

    let specs
    try {
      specs = importsOf(file)
    } catch {
      continue
    }
    for (const spec of specs) {
      if (spec.startsWith('.') || spec.startsWith('/')) {
        const next = resolveLocal(file, spec)
        if (next) queue.push([next, `${path} -> ${spec}`])
        continue
      }
      if (spec.startsWith('node:')) continue
      if (!externals.has(spec)) externals.set(spec, path)
    }
  }
  return { externals, files: seen.size }
}

const targets = [
  { dir: 'modlens', label: '@liustack/modlens', entry: 'dist/main.js' },
  { dir: 'chat-import', label: 'dsh-chat-import', entry: 'bin/dsh-chat-import.mjs' },
  { dir: 'cost-meter', label: 'dsh-cost-meter', entry: 'lib/repair-sessions-cli.js' },
  { dir: 'vision-router', label: 'dsh-vision-router', entry: 'lib/doctor-cli-p0.js' },
  { dir: 'plugin-vet', label: '@jieai/dsh-plugin-vet', entry: 'lib/gate-cli.js' },
]

console.log('Transitive dependency verdict (whole local import graph)\n')

for (const t of targets) {
  const entryPath = join(ROOT, t.dir, 'package', t.entry)
  console.log('='.repeat(74))
  console.log(`${t.label}  ->  ${t.entry}`)
  if (!existsSync(entryPath)) {
    console.log('  ENTRY MISSING')
    continue
  }
  const { externals, files } = walk(entryPath)
  const dsh = [...externals.keys()].filter((s) => s.startsWith('@deepseek-ai/'))
  const thirdParty = [...externals.keys()].filter((s) => !s.startsWith('@deepseek-ai/'))

  console.log(`  local files reached : ${files}`)
  console.log(`  third-party deps    : ${thirdParty.join(', ') || '(none)'}`)
  console.log(`  DSH deps            : ${dsh.join(', ') || '(NONE)'}`)
  for (const spec of dsh) {
    console.log(`      reached via: ${externals.get(spec)}`)
  }
  console.log(`  VERDICT             : ${dsh.length === 0 ? 'PORTABLE' : 'DSH-BOUND'}`)
}
