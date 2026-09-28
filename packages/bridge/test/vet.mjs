/**
 * Verify the vendored plugin-vet audit engine through the bridge.
 *
 * The engine is third-party code, so the point of this suite is NOT to re-test its 20 rules. It is
 * to check the boundary this project owns:
 *
 *   1. THE ENGINE RESOLVES AND RUNS from the vendored tree — its only non-builtin import is
 *      `typescript`, which must be present in the vendor layout. Getting this wrong produces empty
 *      stdout and "Unexpected end of JSON input" instead of a diagnosable error.
 *   2. THE PINNED RULE-SET VERSION MATCHES the engine's own. The version is pinned in
 *      vet-engine-version.mjs so the bridge never imports vendor code at startup; drift would make
 *      the UI attribute verdicts to the wrong rule set, so it is asserted here.
 *   3. A REAL FINDING SURFACES. Scanning a directory containing a deliberate escape pattern must
 *      produce a non-clean verdict naming that file. A scan that always returns "clean" would pass
 *      every structural check while being worthless.
 *   4. "COULD NOT AUDIT" IS DISTINGUISHABLE FROM "AUDITED CLEAN" — a missing directory must report
 *      failure rather than an empty clean report, because that distinction is the whole value of a
 *      pre-install audit.
 *
 * Run: node packages/bridge/test/vet.mjs
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { finish } from './harness.mjs'
import { ENGINE_VERSION } from '../src/vet-engine-version.mjs'
import { resolveScannerDir, scannerStatus, collectFiles, scanBudget } from '../src/vet.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const BRIDGE = join(here, '..', 'src', 'cli.mjs')
const CLAUDE = process.env.CCCN_CLAUDE_BINARY ?? 'D:\\Claudecode-CN\\_probe\\package\\claude.exe'

const results = []
function check(name, ok, detail = '') {
  results.push({ name, ok })
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${name}${detail ? '  — ' + detail : ''}`)
}

// ---- 1. the vendored engine resolves ----------------------------------------
const scannerDir = resolveScannerDir()
check('vendored scanner engine resolves', typeof scannerDir === 'string' && scannerDir.length > 0, String(scannerDir))

const status = scannerStatus()
check('scanner reports available', status.available === true, String(status.reason))

const engineProtocol = scannerDir ? join(scannerDir, 'protocol.js') : null
check('engine protocol file is present', Boolean(engineProtocol && existsSync(engineProtocol)))

// ---- 2. the pinned version matches the engine's own -------------------------
if (engineProtocol && existsSync(engineProtocol)) {
  const source = await import(`file://${engineProtocol.replace(/\\/g, '/')}`)
  check(
    'pinned rule-set version matches the vendored engine',
    source.ENGINE_VERSION === ENGINE_VERSION,
    `pinned=${ENGINE_VERSION} engine=${source.ENGINE_VERSION}`,
  )
  check('engine enumerates its rules', Array.isArray(source.RULE_IDS) && source.RULE_IDS.length > 0, `${source.RULE_IDS?.length ?? 0} rules`)
}

// ---- 3. a real finding surfaces ---------------------------------------------
const scratch = mkdtempSync(join(tmpdir(), 'cccn-vet-'))
const cleanDir = join(scratch, 'clean-plugin')
const dirtyDir = join(scratch, 'dirty-plugin')

mkdirSync(cleanDir, { recursive: true })
writeFileSync(
  join(cleanDir, 'index.js'),
  ['export function add(a, b) {', '  return a + b', '}', ''].join('\n'),
)
writeFileSync(
  join(cleanDir, 'package.json'),
  JSON.stringify({ name: 'clean-plugin', version: '1.0.0', type: 'module', main: 'index.js' }, null, 2),
)

mkdirSync(dirtyDir, { recursive: true })
// The constructor-chain escape: reaching the host's process object through a function's
// constructor. This is the pattern the engine's R1/R2 rules were written for, so a scan that
// misses it is not actually scanning.
writeFileSync(
  join(dirtyDir, 'index.js'),
  [
    'const host = (function(){}).constructor("return process")()',
    'host.mainModule.require("node:child_process").execSync("whoami")',
    'export const value = host.env',
    '',
  ].join('\n'),
)
writeFileSync(
  join(dirtyDir, 'package.json'),
  JSON.stringify({ name: 'dirty-plugin', version: '1.0.0', type: 'module', main: 'index.js' }, null, 2),
)

const collected = collectFiles(dirtyDir)
check('file collection finds the sources', collected.files.length >= 1, `${collected.files.length} files`)
check('file collection skips nothing unexpected', collected.truncated === false)
check('symlinks are not followed', collected.skippedSymlinks === 0)

check(
  'scan budget scales with file count',
  scanBudget(30) > scanBudget(1) && scanBudget(1) === 15000,
  `1->${scanBudget(1)} 30->${scanBudget(30)}`,
)

if (!existsSync(CLAUDE)) {
  console.error(`claude.exe not found at ${CLAUDE}`)
  process.exit(2)
}

function waitForReady(child, timeoutMs = 40000) {
  return new Promise((resolve, reject) => {
    let buffer = ''
    const timer = setTimeout(() => reject(new Error('bridge not ready')), timeoutMs)
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk) => {
      buffer += chunk
      const match = buffer.match(/CCCN_READY (\{.*\})/)
      if (match) {
        clearTimeout(timer)
        resolve(JSON.parse(match[1]))
      }
    })
    child.on('exit', (code) => {
      clearTimeout(timer)
      reject(new Error(`bridge exited (${code})`))
    })
  })
}

function stopChild(child, timeoutMs = 5000) {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve()
      return
    }
    const timer = setTimeout(resolve, timeoutMs)
    child.once('close', () => {
      clearTimeout(timer)
      resolve()
    })
    child.kill()
  })
}

const bridge = spawn(process.execPath, [BRIDGE, '--port', '0', '--claude', CLAUDE, '--token', 'sk-mock'], {
  stdio: ['ignore', 'pipe', 'pipe'],
})

try {
  const ready = await waitForReady(bridge)
  const base = `http://127.0.0.1:${ready.port}`

  const api = async (path, init) => {
    const response = await fetch(`${base}${path}`, {
      ...init,
      headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
    })
    return { status: response.status, body: await response.json().catch(() => ({})) }
  }

  const statusRoute = await api('/api/vet/status')
  check('status route answers', statusRoute.status === 200, `HTTP ${statusRoute.status}`)
  check('status route reports the engine available', statusRoute.body.available === true, String(statusRoute.body.reason))
  check('status route names the rule set', statusRoute.body.engine === ENGINE_VERSION, String(statusRoute.body.engine))

  const noPath = await api('/api/vet/scan', { method: 'POST', body: JSON.stringify({}) })
  check('scan without a path is rejected', noPath.status === 400, `HTTP ${noPath.status}`)

  const missing = await api('/api/vet/scan', {
    method: 'POST',
    body: JSON.stringify({ path: join(scratch, 'does-not-exist') }),
  })
  check('a missing directory is not reported as clean', missing.body.ok === false, JSON.stringify(missing.body.report ?? null))
  check('the failure explains itself', typeof missing.body.error === 'string' && missing.body.error.length > 0, String(missing.body.error))

  const clean = await api('/api/vet/scan', { method: 'POST', body: JSON.stringify({ path: cleanDir }) })
  check('a clean directory scans', clean.body.ok === true, String(clean.body.error ?? ''))
  check('a clean directory has a verdict', typeof clean.body.report?.verdict === 'string', String(clean.body.report?.verdict))
  check('a clean directory parsed its sources', (clean.body.report?.sourceCount ?? 0) >= 1, String(clean.body.report?.sourceCount))
  check('findings are grouped for the UI', Array.isArray(clean.body.report?.groups))
  check('the rule set is reported with the verdict', clean.body.report?.engine === ENGINE_VERSION, String(clean.body.report?.engine))

  const dirty = await api('/api/vet/scan', { method: 'POST', body: JSON.stringify({ path: dirtyDir }) })
  check('the escape sample scans', dirty.body.ok === true, String(dirty.body.error ?? ''))
  const findings = dirty.body.report?.findings ?? []
  check('the escape sample is not reported clean', dirty.body.report?.verdict !== 'clean', String(dirty.body.report?.verdict))
  check('the escape sample produces findings', findings.length > 0, `${findings.length} findings`)
  check(
    'a critical or high finding names the file',
    findings.some((f) => (f.severity === 'critical' || f.severity === 'high') && String(f.file ?? '').includes('index.js')),
    findings.filter((f) => f.severity === 'critical' || f.severity === 'high').map((f) => `${f.rule}:${f.severity}`).join(', ') || 'none',
  )
  // staticScore is a HEALTH score, not a risk score: the engine computes
  // `100 - Σ(severity weight × confidence coef)` (score.js), so 100 means "no decisive findings"
  // and LOWER means worse. Asserting the direction explicitly, because reading it backwards is an
  // easy and consequential mistake for anything that renders it.
  check(
    'the escape sample scores worse (health score: lower is worse)',
    (dirty.body.report?.staticScore ?? 100) < (clean.body.report?.staticScore ?? 0),
    `clean=${clean.body.report?.staticScore} dirty=${dirty.body.report?.staticScore}`,
  )
  check(
    'a clean scan scores a perfect 100',
    clean.body.report?.staticScore === 100,
    String(clean.body.report?.staticScore),
  )
  check(
    'capabilities are extracted for a files scan',
    dirty.body.report?.capabilities !== undefined && typeof dirty.body.report.capabilities.hasExec === 'boolean',
    JSON.stringify(dirty.body.report?.capabilities?.hasExec),
  )
} finally {
  await stopChild(bridge)
  rmSync(scratch, { recursive: true, force: true })
}

finish(results)
