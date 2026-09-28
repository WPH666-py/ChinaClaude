/**
 * Minimal reproduction probe for the Windows teardown assertion seen in permission-mode.mjs:
 *   Assertion failed: !(handle->flags & UV_HANDLE_CLOSING), file src\win\async.c, line 76
 *   exit 0xC0000409 (-1073740791)
 *
 * The suite reports 9/9 checks passed and STILL exits non-zero, which would make it useless as a
 * regression gate. This probe adds one ingredient at a time so the culprit is identified by
 * measurement instead of guessed at.
 *
 * Run: node packages/bridge/test/teardown-probe.mjs
 */
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const BRIDGE = join(here, '..', 'src', 'cli.mjs')
const CLAUDE = process.env.CCCN_CLAUDE_BINARY ?? 'D:\\Claudecode-CN\\_probe\\package\\claude.exe'
const step = process.argv[2] ?? 'all'

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

const backend = createServer((req, res) => {
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
await new Promise((r) => backend.listen(0, '127.0.0.1', r))

const bridge = spawn(
  process.execPath,
  [BRIDGE, '--port', '0', '--claude', CLAUDE, '--base-url', `http://127.0.0.1:${backend.address().port}`, '--token', 'sk-mock'],
  { stdio: ['ignore', 'pipe', 'pipe'] },
)

const ready = await waitForReady(bridge)
const base = `http://127.0.0.1:${ready.port}`
console.log(`bridge ready on ${ready.port} (step=${step})`)

if (step === 'nokill') {
  // Leave the bridge running and just exit: does the mere existence of the child crash us?
  console.log('exiting WITHOUT killing the bridge')
  backend.close()
  process.exit(0)
}

if (step === 'killonly') {
  await stopChild(bridge)
  backend.close()
  console.log('killed bridge, exiting without any http call')
  process.exit(0)
}

if (step === 'nosession') {
  await fetch(`${base}/api/health`).then((r) => r.json())
  await stopChild(bridge)
  backend.close()
  console.log('made a plain GET, exiting')
  process.exit(0)
}

// 'all': create a session and change the permission mode, the way permission-mode.mjs does.
const session = await (
  await fetch(`${base}/api/sessions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ cwd: process.cwd() }),
  })
).json()
console.log('session created')

if (step !== 'sessiononly' && step !== 'allwait' && step !== 'sessionwait') {
  await fetch(`${base}/api/sessions/${session.id}/permission-mode`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ mode: 'acceptEdits' }),
  }).then((r) => r.json())
  console.log('mode switched')
}

if (step === 'allwait' || step === 'sessionwait') {
  // Let a spawned CLI and any keep-alive sockets settle before tearing down.
  await new Promise((r) => setTimeout(r, 2000))
  console.log('settled for 2s')
}

// `settle=<ms>` lets the minimum reliable delay be measured instead of guessed.
const settleMatch = /^settle=(\d+)$/.exec(step)
if (settleMatch) {
  await new Promise((r) => setTimeout(r, Number(settleMatch[1])))
}

await stopChild(bridge)
backend.close()

if (step === 'drain') {
  // Deterministic alternative to a settle sleep: set the exit code and let the event loop drain.
  // The undici keep-alive socket closes on its own, so nothing is left mid-close at teardown.
  console.log('draining (no process.exit)')
  process.exitCode = 0
} else {
  console.log('exiting')
  process.exit(0)
}
