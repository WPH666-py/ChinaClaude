/**
 * Run the whole bridge regression suite in one go and summarise it.
 *
 * The suites spawn the real claude.exe against a mock relay, so they are slow and must run
 * SEQUENTIALLY: two suites sharing a mock port would answer each other's requests and produce
 * confusing cross-talk instead of a clean pass or fail.
 *
 * Exit code is non-zero when any suite fails, so this is usable as a single gate.
 *
 * Run: node packages/bridge/test/all.mjs
 */
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))

/** Roots created for this run, cleaned up at the end. */
const tempDirs = []

/**
 * Ordered list of suites. `initialize`, `provider-switch` and `watchdog` are diagnostic probes that
 * live in _probe/ because they were written to ANSWER a question during development rather than to
 * gate a regression — they are still run, because each one encodes a fact that would be expensive
 * to rediscover.
 */
const SUITES = [
  { name: 'e2e', path: join(here, 'e2e.mjs') },
  { name: 'initialize', path: join(here, 'initialize.mjs') },
  { name: 'permission', path: join(here, 'permission.mjs') },
  { name: 'permission-mode', path: join(here, 'permission-mode.mjs') },
  { name: 'model-switch', path: join(here, 'model-switch.mjs') },
  { name: 'provider-switch', path: join(here, 'provider-switch.mjs') },
  { name: 'subagent', path: join(here, 'subagent.mjs') },
  { name: 'directories', path: join(here, 'directories.mjs') },
  { name: 'removal', path: join(here, 'removal.mjs') },
  { name: 'bundled-skill', path: join(here, 'bundled-skill.mjs') },
  { name: 'vet', path: join(here, 'vet.mjs') },
  { name: 'transcripts', path: join(here, 'transcripts.mjs') },
  { name: 'attachments-balance', path: join(here, 'attachments-balance.mjs') },
  { name: 'connect-test', path: join(here, 'connect-test.mjs') },
  { name: 'cost', path: join(here, 'cost.mjs') },
  { name: 'update (unit)', path: join(here, 'update.mjs') },
  { name: 'wechat (unit)', path: join(here, 'wechat.mjs') },
  { name: 'lan-access', path: join(here, 'lan-access.mjs') },
  { name: 'pricing (unit)', path: join(here, '..', '..', '..', '_probe', 'pricing-check.mjs') },
]

function run(file) {
  return new Promise((resolve) => {
    /**
     * A throwaway data root PER SUITE.
     *
     * WHY: session snapshots are now written to `<dataRoot>/sessions.json` and read back on bridge
     * startup. Sharing one root would let an earlier suite's conversations be restored into a later
     * one, breaking suites that count sessions absolutely (`removal`) — and a shared root against a
     * real install would read and overwrite the user's own conversations. A fresh root per suite
     * keeps every suite hermetic; `lan-access.mjs` overrides CCCN_DATA_DIR itself and is unaffected.
     */
    const dataDir = mkdtempSync(join(tmpdir(), 'cccn-test-'))
    tempDirs.push(dataDir)
    const child = spawn(process.execPath, [file], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, CCCN_DATA_DIR: dataDir },
    })
    let out = ''
    child.stdout.on('data', (c) => {
      out += c
    })
    child.stderr.on('data', (c) => {
      out += c
    })
    child.on('close', (code) => resolve({ code, out }))
  })
}

const summary = []
for (const suite of SUITES) {
  process.stdout.write(`\n${'='.repeat(60)}\n${suite.name}\n${'='.repeat(60)}\n`)
  const { code, out } = await run(suite.path)
  process.stdout.write(out)
  // Every suite prints its own "N/M checks passed" line; keep it for the summary table.
  const tally = out.match(/===\s*(\d+)\/(\d+)\s*(?:checks|passed)/)
  summary.push({
    name: suite.name,
    ok: code === 0,
    passed: tally ? Number(tally[1]) : null,
    total: tally ? Number(tally[2]) : null,
  })
}

console.log(`\n${'='.repeat(60)}\nREGRESSION SUMMARY\n${'='.repeat(60)}`)
let totalPassed = 0
let totalChecks = 0
for (const row of summary) {
  const tally = row.passed === null ? 'n/a' : `${row.passed}/${row.total}`
  console.log(`${row.ok ? 'PASS' : 'FAIL'}  ${row.name.padEnd(20)} ${tally}`)
  if (row.passed !== null) {
    totalPassed += row.passed
    totalChecks += row.total
  }
}

const failed = summary.filter((row) => !row.ok)
console.log(`\n${summary.length - failed.length}/${summary.length} suites passed · ${totalPassed}/${totalChecks} checks`)
for (const dir of tempDirs) {
  try {
    rmSync(dir, { recursive: true, force: true })
  } catch {
    /* the temp dir is disposable either way */
  }
}
if (failed.length > 0) {
  console.log('failed suites: ' + failed.map((row) => row.name).join(', '))
  process.exit(1)
}
process.exit(0)
