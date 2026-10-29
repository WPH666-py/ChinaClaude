/**
 * Walks the ESM import graph of the standalone Our Free Model service so the packaging step knows
 * exactly which files must ship. Prints the file list, the total size, and any unresolved imports.
 *
 * Usage: node tools/ofm-module-graph.mjs <repoRoot>
 */
import fs from 'node:fs'
import path from 'node:path'

const root = path.resolve(process.argv[2] ?? '.')
const entry = path.join(root, 'packages/standalone/cli.mjs')
const seen = new Set()
const external = new Set()
const missing = new Set()

const importRe = /(?:^|[\s;])(?:import|export)[\s\S]*?from\s*['"]([^'"]+)['"]|import\s*\(\s*['"]([^'"]+)['"]\s*\)|(?:^|[\s;])import\s*['"]([^'"]+)['"]/g

function resolveSpecifier(spec, fromFile) {
  if (spec.startsWith('node:') || (!spec.startsWith('.') && !spec.startsWith('/'))) {
    external.add(spec)
    return null
  }
  const base = path.resolve(path.dirname(fromFile), spec)
  const candidates = [base, `${base}.mjs`, `${base}.js`, `${base}.json`, path.join(base, 'index.mjs'), path.join(base, 'index.js')]
  for (const candidate of candidates) {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate
  }
  missing.add(spec)
  return null
}

function walk(file) {
  if (seen.has(file)) return
  seen.add(file)
  if (file.endsWith('.json')) return
  const source = fs.readFileSync(file, 'utf8')
  let match
  while ((match = importRe.exec(source)) !== null) {
    const spec = match[1] ?? match[2] ?? match[3]
    if (!spec) continue
    const resolved = resolveSpecifier(spec, file)
    if (resolved) walk(resolved)
  }
}

walk(entry)

let total = 0
const byDir = new Map()
for (const file of [...seen].sort()) {
  const size = fs.statSync(file).size
  total += size
  const relative = path.relative(root, file).replace(/\\/g, '/')
  const dir = relative.split('/').slice(0, -1).join('/') || '.'
  byDir.set(dir, (byDir.get(dir) ?? 0) + size)
  console.log(`${String(size).padStart(9)}  ${relative}`)
}
console.log(`\nfiles=${seen.size} total=${(total / 1048576).toFixed(1)}MB`)
console.log('by directory:')
for (const [dir, size] of [...byDir].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${(size / 1048576).toFixed(2).padStart(7)}MB  ${dir}`)
}
console.log('external:', [...external].sort().join(', '))
console.log('missing:', [...missing].join(', ') || '(none)')
