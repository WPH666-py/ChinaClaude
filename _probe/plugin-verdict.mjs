/**
 * Work out which of the requested plugins can actually run without the DSH runtime.
 *
 * A plugin's peerDependencies state what it needs at runtime; its entry points state what it can
 * be. The verdict has to come from the files, because the packages all present themselves as
 * "DSH plugins" while a few of them ALSO ship a self-contained CLI — and that CLI is the only
 * thing this project could actually use.
 *
 * Run: node _probe/plugin-verdict.mjs
 */
import { readFileSync, existsSync, statSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = 'D:\\Claudecode-CN\\_probe\\plugins'

/** Collect every module specifier a file imports. */
function importsOf(file) {
  const text = readFileSync(file, 'utf8')
  const specs = new Set()
  for (const m of text.matchAll(/\bfrom\s*['"]([^'"]+)['"]/g)) specs.add(m[1])
  for (const m of text.matchAll(/\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g)) specs.add(m[1])
  for (const m of text.matchAll(/\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g)) specs.add(m[1])
  return { text, specs: [...specs] }
}

function isDsh(spec) {
  return spec.startsWith('@deepseek-ai/') || spec === 'react' || spec === 'react-dom'
}

const targets = [
  { dir: 'modlens', label: '@liustack/modlens', entry: 'dist/main.js' },
  { dir: 'chat-import', label: 'dsh-chat-import', entry: 'bin/dsh-chat-import.mjs' },
  { dir: 'cost-meter', label: 'dsh-cost-meter', entry: 'lib/repair-sessions-cli.js' },
  { dir: 'vision-router', label: 'dsh-vision-router', entry: 'lib/doctor-cli-p0.js' },
  { dir: 'plugin-vet', label: '@jieai/dsh-plugin-vet', entry: 'lib/gate-cli.js' },
]

console.log('For each plugin: does its CLI entry point pull in the DSH runtime?\n')

for (const t of targets) {
  const base = join(ROOT, t.dir, 'package')
  const entryPath = join(base, t.entry)
  console.log('='.repeat(72))
  console.log(`${t.label}  ->  ${t.entry}`)
  if (!existsSync(entryPath)) {
    console.log('  ENTRY MISSING')
    continue
  }
  const { text, specs } = importsOf(entryPath)
  const dsh = specs.filter(isDsh)
  const local = specs.filter((s) => s.startsWith('.'))
  const external = specs.filter((s) => !s.startsWith('.') && !isDsh(s))

  console.log(`  size    : ${(statSync(entryPath).size / 1024).toFixed(1)} KB`)
  console.log(`  imports : ${specs.length} total, ${local.length} local`)
  console.log(`  external: ${external.join(', ') || '(none)'}`)
  console.log(`  DSH     : ${dsh.join(', ') || '(NONE — self-contained)'}`)

  // Follow local imports one level to see whether DSH appears behind them.
  let deeperDsh = new Set()
  for (const spec of local) {
    const resolved = join(base, t.entry, '..', spec)
    for (const candidate of [resolved, resolved + '.js', resolved + '.mjs', join(resolved, 'index.js')]) {
      if (existsSync(candidate) && statSync(candidate).isFile()) {
        for (const s of importsOf(candidate).specs) if (isDsh(s)) deeperDsh.add(s)
        break
      }
    }
  }
  if (deeperDsh.size > 0) {
    console.log(`  DSH (1 level deep): ${[...deeperDsh].join(', ')}`)
  }

  const verdict = dsh.length === 0 && deeperDsh.size === 0 ? 'USABLE' : 'DSH-BOUND'
  console.log(`  VERDICT : ${verdict}`)

  // Directory listing for context.
  const dir = join(base, t.entry, '..')
  console.log(`  siblings: ${readdirSync(dir).slice(0, 12).join(', ')}`)
  void text
}
