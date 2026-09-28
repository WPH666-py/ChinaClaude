/**
 * Inventory the six requested plugins without guessing.
 *
 * Each is a DSH Cordis plugin, so the only question that matters for this project is whether it
 * ALSO exposes an interface that does not need the DSH runtime — a CLI, an MCP server, or a
 * self-contained library. PowerShell mangles the UTF-8 manifests, so this reads them in Node.
 *
 * Run: node _probe/plugin-inventory.mjs
 */
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = 'D:\\Claudecode-CN\\_probe\\plugins'
const NAMES = ['modlens', 'chat-import', 'cost-meter', 'vision-router', 'plugin-vet']

for (const dir of NAMES) {
  const pkgPath = join(ROOT, dir, 'package', 'package.json')
  console.log(`\n${'='.repeat(70)}\n=== ${dir} ===`)
  if (!existsSync(pkgPath)) {
    console.log('  package.json missing')
    continue
  }
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))
  console.log(`  name    : ${pkg.name}@${pkg.version}`)
  console.log(`  main    : ${pkg.main ?? '(none)'}`)
  console.log(`  bin     : ${JSON.stringify(pkg.bin ?? {})}`)
  console.log(`  exports : ${JSON.stringify(pkg.exports ?? {})}`)
  console.log(`  deps    : ${Object.keys(pkg.dependencies ?? {}).join(', ') || '(none)'}`)
  console.log(`  peerDeps: ${Object.keys(pkg.peerDependencies ?? {}).join(', ') || '(none)'}`)

  // Which of those peer deps are DSH/cordis runtime packages? Those are the ones that make the
  // package unusable outside a DSH profile.
  const peers = Object.keys(pkg.peerDependencies ?? {})
  const dshPeers = peers.filter((p) => p.startsWith('@deepseek-ai/'))
  console.log(`  DSH peers: ${dshPeers.join(', ') || '(none!)'}`)

  const base = join(ROOT, dir, 'package')
  console.log('  top-level:')
  for (const entry of readdirSync(base)) {
    const full = join(base, entry)
    const isDir = statSync(full).isDirectory()
    console.log(`    ${isDir ? entry + '/' : entry}`)
  }

  // A bin script is the most likely escape hatch; report whether it looks self-contained.
  const bin = pkg.bin ? Object.values(pkg.bin)[0] : null
  if (bin) {
    const binPath = join(base, bin)
    if (existsSync(binPath)) {
      const size = statSync(binPath).size
      console.log(`  bin[0]  : ${bin} (${(size / 1024).toFixed(1)} KB)`)
      // Look for a shebang and for DSH imports.
      const head = readFileSync(binPath, 'utf8').slice(0, 4000)
      console.log(`    shebang : ${head.split('\n')[0].slice(0, 60)}`)
      const dshRefs = [...head.matchAll(/@deepseek-ai\/[a-z-]+/g)].map((m) => m[0])
      console.log(`    imports : ${[...new Set(dshRefs)].join(', ') || '(no DSH imports in head)'}`)
    } else {
      console.log(`  bin[0]  : ${bin} MISSING`)
    }
  }
}

// The sixth is not on npm; note it so the gap is explicit rather than assumed.
console.log(`\n${'='.repeat(70)}`)
console.log('dsh-jev-tools: not an npm package (GitHub only) — needs its own checkout.')
