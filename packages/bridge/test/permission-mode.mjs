/**
 * Verify in-session permission-mode switching.
 *
 * The settings UI claims a mode change applies to the RUNNING session. That only holds if the
 * CLI accepts the `set_permission_mode` control request, and `bypassPermissions` in particular
 * is refused unless the process was launched with a skip-permissions flag — so "can the user
 * actually reach 完全权限?" is a real question with a real failure mode, not a UI detail.
 *
 * The check reads the mode back from the CLI's OWN report (`catalog.permissionMode`, taken from
 * the initialize reply's `current_permission_mode`) rather than trusting our own bookkeeping.
 *
 * Run: node packages/bridge/test/permission-mode.mjs
 */
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { finish } from './harness.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const BRIDGE = join(here, '..', 'src', 'cli.mjs')
const CLAUDE = process.env.CCCN_CLAUDE_BINARY ?? 'D:\\Claudecode-CN\\_probe\\package\\claude.exe'

const results = []
function check(name, ok, detail = '') {
  results.push({ name, ok })
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${name}${detail ? '  — ' + detail : ''}`)
}

/** Backend that answers the probe and every turn with plain text. */
function createBackend() {
  return createServer((req, res) => {
    if (req.method === 'HEAD') {
      res.writeHead(200).end()
      return
    }
    res.writeHead(200, { 'Content-Type': 'text/event-stream' })
    res.end(
      [
        'event: message_start',
        'data: {"type":"message_start","message":{"id":"m1","type":"message","role":"assistant","model":"m","content":[],"stop_reason":null,"usage":{"input_tokens":5,"output_tokens":0}}}',
        '',
        'event: message_delta',
        'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":1}}',
        '',
        'event: message_stop',
        'data: {"type":"message_stop"}',
        '',
        '',
      ].join('\n'),
    )
  })
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

/**
 * Kill the bridge and WAIT until it is actually reaped before the process drains.
 *
 * See harness.mjs: killing and exiting in the same tick races libuv's handle teardown on Windows
 * (exit 0xC0000409). This suite is the fastest one, so it is the one that reliably loses that race.
 */
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

/** Read the mode the CLI itself reports, retrying while the reply lands. */
async function reportedMode(base, sessionId, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs
  let last = null
  while (Date.now() < deadline) {
    const catalog = await (await fetch(`${base}/api/sessions/${sessionId}/catalog`)).json()
    last = catalog.permissionMode
    if (last) return last
    await new Promise((r) => setTimeout(r, 400))
  }
  return last
}

async function setMode(base, sessionId, mode) {
  const response = await fetch(`${base}/api/sessions/${sessionId}/permission-mode`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ mode }),
  })
  return { status: response.status, body: await response.json().catch(() => ({})) }
}

if (!existsSync(CLAUDE)) {
  console.error(`claude.exe not found at ${CLAUDE}`)
  process.exit(2)
}

const backend = createBackend()
await new Promise((r) => backend.listen(0, '127.0.0.1', r))

const bridge = spawn(
  process.execPath,
  [BRIDGE, '--port', '0', '--claude', CLAUDE, '--base-url', `http://127.0.0.1:${backend.address().port}`, '--token', 'sk-mock'],
  { stdio: ['ignore', 'pipe', 'pipe'] },
)

try {
  const ready = await waitForReady(bridge)
  const base = `http://127.0.0.1:${ready.port}`

  const session = await (
    await fetch(`${base}/api/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      // Start in the "ask" preset, which maps to the CLI's `default`.
      body: JSON.stringify({ cwd: process.cwd(), permissionMode: 'default' }),
    })
  ).json()

  const initial = await reportedMode(base, session.id)
  check('session starts in the requested mode', initial === 'default', String(initial))

  // The "workspace write" preset.
  const accept = await setMode(base, session.id, 'acceptEdits')
  check('acceptEdits accepted by the bridge', accept.status === 200, `HTTP ${accept.status}`)
  const afterAccept = await reportedMode(base, session.id)
  check('CLI reports acceptEdits after the switch', afterAccept === 'acceptEdits', String(afterAccept))

  // The "read only" preset. `plan` is documented as "no actual tool execution".
  const plan = await setMode(base, session.id, 'plan')
  check('plan accepted by the bridge', plan.status === 200, `HTTP ${plan.status}`)
  const afterPlan = await reportedMode(base, session.id)
  check('CLI reports plan after the switch', afterPlan === 'plan', String(afterPlan))

  /**
   * The dangerous one. Without a skip-permissions launch flag the CLI refuses this, which would
   * make the 完全权限 preset silently unusable — hence the explicit assertion.
   */
  const bypass = await setMode(base, session.id, 'bypassPermissions')
  check('bypassPermissions accepted by the bridge', bypass.status === 200, `HTTP ${bypass.status}`)
  const afterBypass = await reportedMode(base, session.id)
  check(
    'CLI reports bypassPermissions (launch flag works)',
    afterBypass === 'bypassPermissions',
    String(afterBypass),
  )

  // Back down again: escalation must be reversible.
  await setMode(base, session.id, 'default')
  const back = await reportedMode(base, session.id)
  check('mode can be lowered again', back === 'default', String(back))

  // A bad mode must be rejected rather than silently ignored.
  const bad = await setMode(base, session.id, 'yolo')
  check('unknown mode rejected', bad.status === 400, `HTTP ${bad.status}`)
} finally {
  await stopChild(bridge)
  backend.close()
}

finish(results)
