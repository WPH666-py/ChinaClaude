/**
 * Verify switching to a DIFFERENT provider's endpoint.
 *
 * A base URL and an API key are environment variables of the CLI child process, so no control
 * request can change them — `set_model` only renames a model within the endpoint the process was
 * started against. Crossing providers therefore restarts the process, and the whole point of
 * doing it this way is that the conversation is carried over with `--resume` instead of being
 * lost. That carry-over is the claim worth testing, and the mock makes it observable: each
 * request echoes back whether it can see the earlier turn.
 *
 * Run: node packages/bridge/test/provider-switch.mjs
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

/** A backend that reports which endpoint it is and whether it received prior turns. */
function createBackend(label) {
  const seen = { requests: 0, sawHistory: false, apiKeys: new Set() }
  const server = createServer((req, res) => {
    if (req.method === 'HEAD') {
      res.writeHead(200).end()
      return
    }
    const chunks = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => {
      seen.requests++
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      const userTurns = (body.messages ?? []).filter((m) => m.role === 'user').length
      const assistantTurns = (body.messages ?? []).filter((m) => m.role === 'assistant').length
      // More than the one prompt we are about to send means the transcript came along.
      if (userTurns + assistantTurns > 1) seen.sawHistory = true
      const auth = req.headers.authorization ?? ''
      if (auth) seen.apiKeys.add(auth)

      const text = `${label} turns=${userTurns + assistantTurns}`
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' })
      res.write(
        [
          'event: message_start',
          `data: ${JSON.stringify({ type: 'message_start', message: { id: 'm', type: 'message', role: 'assistant', model: body.model, content: [], stop_reason: null, usage: { input_tokens: 5, output_tokens: 0 } } })}`,
          '',
          'event: content_block_start',
          'data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}',
          '',
          'event: content_block_delta',
          `data: ${JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } })}`,
          '',
          'event: content_block_stop',
          'data: {"type":"content_block_stop","index":0}',
          '',
          'event: message_delta',
          'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":2}}',
          '',
          'event: message_stop',
          'data: {"type":"message_stop"}',
          '',
          '',
        ].join('\n'),
      )
      res.end()
    })
  })
  return { server, seen, listen: () => new Promise((r) => server.listen(0, '127.0.0.1', r)) }
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

async function send(base, sessionId, text, timeoutMs = 60000) {
  await fetch(`${base}/api/sessions/${sessionId}/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text }),
  })
  /**
   * Wait for the turn to actually settle.
   *
   * `status` alone is not enough: the `system/init` frame sets it to 'ready' while the first turn
   * is still running, so a status-only wait would race the bridge's real guard (`turnActive`) and
   * see spurious 409s. `historyLength` growing past the send is the honest signal, so the wait
   * also requires a `result` to have landed.
   */
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const list = await (await fetch(`${base}/api/sessions`)).json()
    const view = list.sessions.find((s) => s.id === sessionId)
    if (view && view.status === 'ready') {
      // Confirm the turn closed by asking for the timeline and looking for a result.
      const timeline = await events(base, sessionId)
      if (timeline.some((event) => event.kind === 'result')) return view
    }
    await new Promise((r) => setTimeout(r, 400))
  }
  return null
}

async function events(base, sessionId) {
  const response = await fetch(`${base}/api/sessions/${sessionId}/events`, {
    headers: { accept: 'text/event-stream' },
    signal: AbortSignal.timeout(2000),
  }).catch(() => null)
  if (!response?.body) return []
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  const out = []
  try {
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
    }
  } catch {
    /* timeout */
  }
  for (const frame of buffer.split('\n\n')) {
    const line = frame.split('\n').find((l) => l.startsWith('data: '))
    if (!line) continue
    try {
      out.push(JSON.parse(line.slice(6)))
    } catch {
      /* skip */
    }
  }
  return out
}

if (!existsSync(CLAUDE)) {
  console.error(`claude.exe not found at ${CLAUDE}`)
  process.exit(2)
}

const providerA = createBackend('A')
const providerB = createBackend('B')
await providerA.listen()
await providerB.listen()

const bridge = spawn(
  process.execPath,
  [
    BRIDGE,
    '--port', '0',
    '--claude', CLAUDE,
    '--base-url', `http://127.0.0.1:${providerA.server.address().port}`,
    '--token', 'sk-provider-A',
  ],
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

  // First turn on provider A, so there is a transcript worth carrying over.
  await send(base, session.id, 'first message on A')
  check('provider A answered the first turn', providerA.seen.requests >= 1, `${providerA.seen.requests} request(s)`)
  check('provider A saw the session key', providerA.seen.apiKeys.has('Bearer sk-provider-A'), [...providerA.seen.apiKeys].join(' | '))

  const beforeSwitch = await (await fetch(`${base}/api/sessions`)).json()
  const viewBefore = beforeSwitch.sessions.find((s) => s.id === session.id)
  const claudeSessionId = viewBefore?.claudeSessionId
  check('session has a resumable claude session id', typeof claudeSessionId === 'string' && claudeSessionId.length > 0, String(claudeSessionId))

  // Switch to provider B's endpoint with a different key.
  const switchResponse = await fetch(`${base}/api/sessions/${session.id}/model`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'some-model-on-b',
      baseUrl: `http://127.0.0.1:${providerB.server.address().port}`,
      apiKey: 'sk-provider-B',
    }),
  })
  const switchBody = await switchResponse.json()
  check('cross-provider switch accepted', switchResponse.status === 202, `HTTP ${switchResponse.status} ${JSON.stringify(switchBody)}`)
  check('bridge reports it restarted the process', switchBody.mode === 'restarted', String(switchBody.mode))

  // The child needs a moment to boot the new endpoint.
  await new Promise((r) => setTimeout(r, 4000))

  const afterSwitch = await (await fetch(`${base}/api/sessions`)).json()
  const viewAfter = afterSwitch.sessions.find((s) => s.id === session.id)
  check('session points at the new endpoint', viewAfter?.endpoint === `http://127.0.0.1:${providerB.server.address().port}`, String(viewAfter?.endpoint))

  // Second turn must reach provider B, carrying the earlier conversation.
  await send(base, session.id, 'second message on B')
  check('provider B answered after the switch', providerB.seen.requests >= 1, `${providerB.seen.requests} request(s)`)
  check('provider B received the new key', providerB.seen.apiKeys.has('Bearer sk-provider-B'), [...providerB.seen.apiKeys].join(' | '))
  check(
    'conversation was resumed across the restart',
    providerB.seen.sawHistory,
    providerB.seen.sawHistory ? 'prior turns present' : 'provider B saw a single-turn transcript',
  )

  // The UI should have been told, since a silent restart is indistinguishable from a hang.
  const timeline = await events(base, session.id)
  check(
    'a notice explains the switch',
    timeline.some((event) => event.kind === 'notice' && String(event.message ?? '').includes('切换')),
    timeline.filter((e) => e.kind === 'notice').map((e) => e.message).join(' | ') || 'none',
  )

  // A same-endpoint switch must NOT restart: context loss there would be a bug.
  const sameProvider = await fetch(`${base}/api/sessions/${session.id}/model`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'another-model-on-b', baseUrl: `http://127.0.0.1:${providerB.server.address().port}` }),
  })
  const sameBody = await sameProvider.json()
  check('same-endpoint switch stays in-session', sameBody.mode === 'in-session', String(sameBody.mode))

  // A busy session must be refused rather than cut off mid-turn.
  await fetch(`${base}/api/sessions/${session.id}/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text: 'slow turn' }),
  })
  const busySwitch = await fetch(`${base}/api/sessions/${session.id}/model`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'x', baseUrl: `http://127.0.0.1:${providerA.server.address().port}`, apiKey: 'sk-provider-A' }),
  })
  check('cross-provider switch refused while a turn runs', busySwitch.status === 409, `HTTP ${busySwitch.status}`)
} finally {
  bridge.kill()
  providerA.server.close()
  providerB.server.close()
}

const failed = results.filter((r) => !r.ok)
console.log(`\n=== ${results.length - failed.length}/${results.length} checks passed ===`)
if (failed.length > 0) {
  console.log('failures:')
  for (const f of failed) console.log('  - ' + f.name)
  process.exit(1)
}
process.exit(0)
