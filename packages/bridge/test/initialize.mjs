/**
 * Verify the `initialize` capability handshake against the real CLI.
 *
 * The handshake is a prerequisite for host dialogs and for subagent text: the CLI gates both
 * on declared capabilities and fails closed when nothing is declared, so "did the CLI accept
 * our initialize, and what did it report back" is a hard prerequisite rather than a detail.
 *
 * Run: node packages/bridge/test/initialize.mjs
 */
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { existsSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { buildChildArgs, buildChildEnv, DEFAULT_CAPABILITIES } from '../src/session.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const CLAUDE = process.env.CCCN_CLAUDE_BINARY ?? 'D:\\Claudecode-CN\\_probe\\package\\claude.exe'

const results = []
function check(name, ok, detail = '') {
  results.push({ name, ok })
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${name}${detail ? '  — ' + detail : ''}`)
}

/** Minimal backend: answers the probe and every turn with plain text. */
function createBackend() {
  return createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    if (req.method === 'HEAD' && url.pathname === '/api/hello') {
      res.writeHead(200).end()
      return
    }
    if (req.method === 'POST' && url.pathname === '/v1/messages') {
      const chunks = []
      req.on('data', (c) => chunks.push(c))
      req.on('end', () => {
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' })
        res.write(
          [
            'event: message_start',
            'data: {"type":"message_start","message":{"id":"m1","type":"message","role":"assistant","model":"m","content":[],"stop_reason":null,"usage":{"input_tokens":10,"output_tokens":0}}}',
            '',
            'event: content_block_start',
            'data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}',
            '',
            'event: content_block_delta',
            'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"ok"}}',
            '',
            'event: content_block_stop',
            'data: {"type":"content_block_stop","index":0}',
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
        res.end()
      })
      return
    }
    res.writeHead(404).end('{}')
  })
}

if (!existsSync(CLAUDE)) {
  console.error(`claude.exe not found at ${CLAUDE}`)
  process.exit(2)
}

const backend = createBackend()
await new Promise((r) => backend.listen(0, '127.0.0.1', r))
const backendPort = backend.address().port

const env = buildChildEnv({ baseUrl: `http://127.0.0.1:${backendPort}`, authToken: 'sk-mock' }, process.env)
const child = spawn(CLAUDE, buildChildArgs({ cwd: process.cwd() }), {
  env,
  stdio: ['pipe', 'pipe', 'pipe'],
  windowsHide: true,
})

const requestId = randomUUID()
const controlResponses = []
const systemEvents = []
let initFrameSeen = false

/** Wait until the child has flushed, then look at what came back. */
function sendInitialize() {
  const request = { subtype: 'initialize', ...DEFAULT_CAPABILITIES }
  console.log('  sending initialize: ' + JSON.stringify(request))
  child.stdin.write(JSON.stringify({ type: 'control_request', request_id: requestId, request }) + '\n')
}

let buffer = ''
child.stdout.setEncoding('utf8')
child.stdout.on('data', (chunk) => {
  buffer += chunk
  let index
  while ((index = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, index).trim()
    buffer = buffer.slice(index + 1)
    if (!line) continue
    let raw
    try {
      raw = JSON.parse(line)
    } catch {
      continue
    }
    if (raw.type === 'control_response') {
      controlResponses.push(raw)
      console.log('  <- control_response: ' + JSON.stringify(raw).slice(0, 500))
    } else if (raw.type === 'system') {
      systemEvents.push(raw)
      if (raw.subtype === 'init') initFrameSeen = true
    }
  }
})
child.stderr.setEncoding('utf8')
child.stderr.on('data', (d) => {
  const text = String(d).trim()
  if (text) console.log('  [stderr] ' + text.slice(0, 200))
})

// The CLI must be told something before it produces output at all, so the initialize and a
// real turn go out together.
child.stdin.write(
  JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'hi' }] } }) + '\n',
)
sendInitialize()

await new Promise((r) => setTimeout(r, 20000))
child.kill()
backend.close()

console.log('\n=== results ===')
check('CLI produced a system/init frame', initFrameSeen)

const reply = controlResponses.find((r) => r.response?.request_id === requestId)
check('initialize got a control_response', reply !== undefined)

if (reply) {
  check('initialize succeeded', reply.response?.subtype === 'success', reply.response?.subtype)
  const payload = reply.response?.response ?? {}
  check('reply carries pending_permission_requests', 'pending_permission_requests' in payload || reply.response?.pending_permission_requests !== undefined)
  console.log('  initialize payload keys: ' + JSON.stringify(Object.keys(payload)))
  console.log('  full payload: ' + JSON.stringify(payload).slice(0, 900))
  // The reply documents what the CLI registered; the capability fields are echoed back when
  // it accepted them.
  const kinds = payload.supportedDialogKinds ?? reply.response?.supportedDialogKinds
  if (kinds !== undefined) check('CLI echoed supportedDialogKinds', Array.isArray(kinds), JSON.stringify(kinds))
  else console.log('  (supportedDialogKinds not echoed — CLI may not report it back)')
}

const failed = results.filter((r) => !r.ok)
console.log(`\n=== ${results.length - failed.length}/${results.length} checks passed ===`)
process.exit(failed.length === 0 ? 0 : 1)
