/**
 * Dump the full `initialize` reply so the UI knows exactly what the CLI reports back.
 *
 * The reply carries the session's `commands` (skills, with descriptions) and `agents` — which
 * makes it the data source for the skills/subagent UI, not just a capability handshake.
 *
 * Run: node packages/bridge/test/dump-initialize.mjs   -> writes initialize-dump.json
 */
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { buildChildArgs, buildChildEnv, DEFAULT_CAPABILITIES } from '../src/session.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const OUT = join(here, 'initialize-dump.json')
const CLAUDE = process.env.CCCN_CLAUDE_BINARY ?? 'D:\\Claudecode-CN\\_probe\\package\\claude.exe'

const backend = createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1')
  if (req.method === 'HEAD') {
    res.writeHead(200).end()
    return
  }
  res.writeHead(200, { 'Content-Type': 'text/event-stream' })
  res.end(
    [
      'event: message_start',
      'data: {"type":"message_start","message":{"id":"m1","type":"message","role":"assistant","model":"m","content":[],"stop_reason":null,"usage":{"input_tokens":10,"output_tokens":0}}}',
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
  void url
})
await new Promise((r) => backend.listen(0, '127.0.0.1', r))

const env = buildChildEnv({ baseUrl: `http://127.0.0.1:${backend.address().port}`, authToken: 'sk' }, process.env)
const child = spawn(CLAUDE, buildChildArgs({ cwd: process.cwd() }), { env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })

const requestId = randomUUID()
let payload = null
let buffer = ''
child.stdout.setEncoding('utf8')
child.stdout.on('data', (chunk) => {
  buffer += chunk
  let i
  while ((i = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, i).trim()
    buffer = buffer.slice(i + 1)
    if (!line) continue
    let raw
    try {
      raw = JSON.parse(line)
    } catch {
      continue
    }
    if (raw.type === 'control_response' && raw.response?.request_id === requestId) {
      payload = raw.response.response ?? {}
    }
  }
})

child.stdin.write(JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'hi' }] } }) + '\n')
child.stdin.write(
  JSON.stringify({ type: 'control_request', request_id: requestId, request: { subtype: 'initialize', ...DEFAULT_CAPABILITIES } }) + '\n',
)

await new Promise((r) => setTimeout(r, 15000))
child.kill()
backend.close()

if (!payload) {
  console.error('no initialize payload captured')
  process.exit(1)
}

writeFileSync(OUT, JSON.stringify(payload, null, 2), 'utf8')

const summarize = (label, list) => {
  if (!Array.isArray(list)) return console.log(`${label}: (absent)`)
  console.log(`${label}: ${list.length}`)
  for (const item of list.slice(0, 40)) {
    const name = item?.name ?? item?.type ?? '?'
    const desc = (item?.description ?? '').replace(/\s+/g, ' ').slice(0, 70)
    console.log(`    ${String(name).padEnd(28)} ${desc}`)
  }
}

console.log('=== initialize payload ===')
console.log('keys: ' + JSON.stringify(Object.keys(payload)))
console.log('')
summarize('commands', payload.commands)
summarize('agents', payload.agents)
console.log('')
console.log('models: ' + JSON.stringify(payload.models)?.slice(0, 400))
console.log('account: ' + JSON.stringify(payload.account)?.slice(0, 200))
console.log('session_state: ' + JSON.stringify(payload.session_state))
console.log('current_permission_mode: ' + JSON.stringify(payload.current_permission_mode))
console.log(`\nfull dump -> ${OUT}`)
process.exit(0)
