/**
 * Verify in-session model switching.
 *
 * The UI lets the user pick a model for the RUNNING session, so the `set_model` control request
 * has to be accepted and reflected — otherwise the picker is decoration. Two observable facts
 * are checked, neither of which is our own bookkeeping:
 *
 *   1. the CLI answers the control request at all;
 *   2. the catalog reports the new model, and reporting is accurate rather than a stale
 *      handshake snapshot (the same failure mode that had to be fixed for permission mode).
 *
 * Also covers the reset semantics: an empty value means "back to the session default".
 *
 * Run: node packages/bridge/test/model-switch.mjs
 */
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const BRIDGE = join(here, '..', 'src', 'cli.mjs')
const CLAUDE = process.env.CCCN_CLAUDE_BINARY ?? 'D:\\Claudecode-CN\\_probe\\package\\claude.exe'

const results = []
function check(name, ok, detail = '') {
  results.push({ name, ok })
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${name}${detail ? '  — ' + detail : ''}`)
}

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

async function catalog(base, sessionId) {
  return (await fetch(`${base}/api/sessions/${sessionId}/catalog`)).json()
}

/** Poll the catalog until the reported model matches, or time out. */
async function waitForModel(base, sessionId, expected, timeoutMs = 12000) {
  const deadline = Date.now() + timeoutMs
  let last = null
  while (Date.now() < deadline) {
    const value = (await catalog(base, sessionId)).model
    last = value
    if (value === expected) return value
    await new Promise((r) => setTimeout(r, 400))
  }
  return last
}

async function setModel(base, sessionId, model) {
  const response = await fetch(`${base}/api/sessions/${sessionId}/model`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model }),
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
      body: JSON.stringify({ cwd: process.cwd() }),
    })
  ).json()

  // Wait for the initialize handshake so the catalog exists at all.
  let warmed = null
  for (let i = 0; i < 30; i++) {
    warmed = await catalog(base, session.id)
    if (warmed.ready) break
    await new Promise((r) => setTimeout(r, 500))
  }
  check('catalog ready before switching', warmed?.ready === true)

  // The catalog must name a model even when none was requested on the command line. That value
  // comes from the `system/init` frame, which the CLI only emits once a turn has been sent — so
  // a turn has to happen before the model can be reported at all.
  await fetch(`${base}/api/sessions/${session.id}/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text: 'hi' }),
  })

  let resolved = null
  for (let i = 0; i < 30; i++) {
    const snapshot = await catalog(base, session.id)
    resolved = snapshot.resolvedModel
    if (resolved) break
    await new Promise((r) => setTimeout(r, 500))
  }

  const afterTurn = await catalog(base, session.id)
  check(
    'catalog names the model in use after a turn',
    typeof afterTurn.model === 'string' && afterTurn.model.length > 0,
    String(afterTurn.model),
  )
  check('catalog reports the CLI-resolved model', typeof resolved === 'string' && resolved.length > 0, String(resolved))

  const available = (afterTurn?.models ?? []).map((m) => m.value)
  check('catalog lists switchable models', available.length > 0, available.join(', '))

  // Switch to a model the CLI itself advertised, so the id is guaranteed valid.
  const target = available.find((value) => value !== 'default') ?? available[0]
  const switched = await setModel(base, session.id, target)
  check('set_model accepted by the bridge', switched.status === 200, `HTTP ${switched.status}`)
  const reported = await waitForModel(base, session.id, target)
  check('catalog reports the new model (not a stale snapshot)', reported === target, String(reported))

  // Switch to something the catalog does NOT list: the endpoint may map it, so the request must
  // still be forwarded rather than rejected client-side.
  const custom = 'deepseek-v4-pro'
  const customResult = await setModel(base, session.id, custom)
  check('unlisted model id is forwarded, not rejected', customResult.status === 200, `HTTP ${customResult.status}`)
  const customReported = await waitForModel(base, session.id, custom)
  check('catalog reflects the custom model id', customReported === custom, String(customReported))

  // Empty value == reset to the session default, per the control request's own semantics.
  const reset = await setModel(base, session.id, '')
  check('reset accepted by the bridge', reset.status === 200, `HTTP ${reset.status}`)
  const afterReset = (await catalog(base, session.id)).model
  check(
    'reset returns to the session default rather than a made-up id',
    afterReset === resolved || afterReset === null,
    String(afterReset),
  )
} finally {
  bridge.kill()
  backend.close()
}

const failed = results.filter((r) => !r.ok)
console.log(`\n=== ${results.length - failed.length}/${results.length} checks passed ===`)
if (failed.length > 0) {
  console.log('failures:')
  for (const f of failed) console.log('  - ' + f.name)
  process.exit(1)
}
process.exit(0)
