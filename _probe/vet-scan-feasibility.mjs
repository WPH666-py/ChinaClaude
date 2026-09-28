/**
 * Feasibility probe: can plugin-vet's scanner engine run OUTSIDE the DSH host?
 *
 * The engine is `lib/scanner-bin/` — a child process that reads one JSON ScanRequest on stdin and
 * writes one JSON ScanResponse on stdout. If that contract holds with only `typescript` resolvable,
 * then a thin wrapper is all this project needs, and re-implementing 20 rules would be pointless.
 *
 * Deliberately does NOT import anything from the DSH host: the point is to measure the real
 * dependency boundary rather than trust the earlier reading of it.
 *
 * Run: node _probe/vet-scan-feasibility.mjs <scanner-bin-dir> <target-dir> [nodePath]
 */
import { spawn } from 'node:child_process'
import { readdirSync, statSync, readFileSync } from 'node:fs'
import { join, extname } from 'node:path'

const [, , binDir, target, nodePath] = process.argv
if (!binDir || !target) {
  console.error('usage: node _probe/vet-scan-feasibility.mjs <scanner-bin-dir> <target-dir> [nodePath]')
  process.exit(2)
}

/** Source-like files under a target, with the same extensions the engine parses. */
const WANTED = new Set(['.js', '.mjs', '.cjs', '.jsx', '.ts', '.tsx', '.mts', '.cts'])
const SKIP_DIRS = new Set(['.git', 'node_modules'])

function collect(dir, out = [], depth = 0) {
  if (depth > 12) return out
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue
      collect(full, out, depth + 1)
    } else if (entry.isFile() && WANTED.has(extname(entry.name).toLowerCase())) {
      out.push(full)
    }
  }
  return out
}

const files = collect(target)
console.log(`target: ${target}`)
console.log(`files to scan: ${files.length}`)
for (const file of files.slice(0, 10)) console.log('  ' + file)
if (files.length > 10) console.log(`  ... and ${files.length - 10} more`)

const request = {
  kind: 'files',
  files,
  targetKind: 'plugin',
  scanBasis: 'npm',
  osv: false,
  timeoutMs: 30000,
}

const env = { ...process.env }
if (nodePath) env.NODE_PATH = nodePath

const started = Date.now()
const child = spawn(process.execPath, [join(binDir, 'index.js')], {
  stdio: ['pipe', 'pipe', 'pipe'],
  env,
})
let stdout = ''
let stderr = ''
child.stdout.on('data', (c) => {
  stdout += c
})
child.stderr.on('data', (c) => {
  stderr += c
})
child.stdin.end(JSON.stringify(request))

const code = await new Promise((resolve) => child.on('close', resolve))
const elapsed = Date.now() - started

console.log(`\nexit=${code}  ${elapsed}ms`)
if (stderr.trim()) console.log('stderr:\n' + stderr.trim().slice(0, 4000))

let response = null
try {
  response = JSON.parse(stdout)
} catch (error) {
  console.log(`stdout is not JSON (${stdout.length} bytes): ${String(error.message)}`)
  console.log('stdout head: ' + stdout.slice(0, 500))
  process.exit(1)
}

if (!response.ok) {
  console.log('engine reported failure: ' + response.error)
  process.exit(1)
}

const report = response.report
console.log(`engine:      ${report.engine}`)
console.log(`sourceCount: ${report.sourceCount}`)
console.log(`staticScore: ${report.staticScore}`)
console.log(`verdict:     ${report.verdict}`)
console.log(`findings:    ${report.findings.length}`)
for (const finding of report.findings.slice(0, 15)) {
  const where = finding.file ? ` (${finding.file}${finding.line ? ':' + finding.line : ''})` : ''
  console.log(`  [${finding.severity}/${finding.confidence}] ${finding.rule} ${finding.message}${where}`)
}
if (report.capabilities) {
  const caps = report.capabilities
  console.log(
    `capabilities: network=${caps.hasNetwork} exec=${caps.hasExec} hosts=${caps.hosts.length} imports=${caps.imports.length}`,
  )
}

// Cheap proof the engine really parsed source rather than returning a canned shape.
if (report.sourceCount === 0) {
  console.log('\nWARNING: engine parsed 0 sources — the boundary is not proven by this run')
  process.exit(1)
}
console.log('\nOK: engine ran standalone and parsed sources')
