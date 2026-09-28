/**
 * Verify session and workspace removal.
 *
 * The sidebar's delete affordances depend on two distinct verbs, and conflating them would be a
 * real bug: `stop` leaves the session in the list (it is still something the user can look at),
 * while `purge` removes it. A workspace is only a grouping of sessions, so removing a workspace
 * means purging each of its sessions — which is why this checks the list afterwards rather than
 * trusting the HTTP status.
 *
 * Run: node packages/bridge/test/removal.mjs
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

async function list(base) {
  return (await (await fetch(`${base}/api/sessions`)).json()).sessions
}

async function create(base, cwd) {
  return (
    await fetch(`${base}/api/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ cwd }),
    })
  ).json()
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

  const a = await create(base, 'D:\\workspace-A')
  const b = await create(base, 'D:\\workspace-A')
  const c = await create(base, 'D:\\workspace-B')
  check('three sessions created across two workspaces', (await list(base)).length === 3)

  // stop vs purge: the whole point is that they differ.
  const stopped = await fetch(`${base}/api/sessions/${a.id}`, { method: 'DELETE' })
  const stoppedBody = await stopped.json()
  check('stop reports stopped', stoppedBody.stopped === true, JSON.stringify(stoppedBody))
  check('stop LEAVES the session listed', (await list(base)).some((s) => s.id === a.id))

  const purged = await fetch(`${base}/api/sessions/${a.id}?purge=1`, { method: 'DELETE' })
  const purgedBody = await purged.json()
  check('purge reports removed', purgedBody.removed === true, JSON.stringify(purgedBody))
  const afterPurge = await list(base)
  check('purge REMOVES the session from the list', !afterPurge.some((s) => s.id === a.id), `${afterPurge.length} left`)

  // Purging an already-purged id must not resurrect or crash.
  const repeat = await fetch(`${base}/api/sessions/${a.id}?purge=1`, { method: 'DELETE' })
  check('purging an unknown id is a clean 404', repeat.status === 404, `HTTP ${repeat.status}`)

  // Workspace removal == purging each session in that directory.
  const inA = (await list(base)).filter((s) => s.cwd === 'D:\\workspace-A')
  check('workspace A still has one session', inA.length === 1, `${inA.length}`)
  for (const session of inA) {
    await fetch(`${base}/api/sessions/${session.id}?purge=1`, { method: 'DELETE' })
  }
  const remaining = await list(base)
  check(
    'workspace A is gone once its last session is removed',
    remaining.every((s) => s.cwd !== 'D:\\workspace-A'),
    remaining.map((s) => s.cwd).join(', '),
  )
  check('the other workspace is untouched', remaining.some((s) => s.id === c.id))

  // A purged session must not leave an orphan child holding the port.
  await new Promise((r) => setTimeout(r, 1500))
  const stillStopped = await fetch(`${base}/api/sessions/${a.id}`).catch(() => null)
  check('purged session is really gone from the bridge', stillStopped === null || stillStopped.status === 404, `HTTP ${stillStopped?.status ?? 'no response'}`)
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
