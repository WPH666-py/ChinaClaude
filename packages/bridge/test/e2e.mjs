/**
 * End-to-end bridge verification. Proves the whole path works without a real API key:
 *
 *   test -> bridge (HTTP/SSE) -> claude.exe (stream-json) -> mock Anthropic (SSE) -> back
 *
 * Run: node packages/bridge/test/e2e.mjs
 * Exit code 0 = every assertion held.
 */
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { createMockAnthropic } from './mock-server.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const BRIDGE = join(here, '..', 'src', 'cli.mjs')
const CLAUDE = process.env.CCCN_CLAUDE_BINARY ?? 'D:\\Claudecode-CN\\_probe\\package\\claude.exe'

const results = []
function check(name, ok, detail = '') {
  results.push({ name, ok, detail })
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${name}${detail ? '  — ' + detail : ''}`)
}

function waitForReady(child, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    let buffer = ''
    const timer = setTimeout(() => reject(new Error('bridge did not report ready in time')), timeoutMs)
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk) => {
      buffer += chunk
      const match = buffer.match(/CCCN_READY (\{.*\})/)
      if (match) {
        clearTimeout(timer)
        resolve(JSON.parse(match[1]))
      }
    })
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk) => process.stderr.write('[bridge] ' + chunk))
    child.on('exit', (code) => {
      clearTimeout(timer)
      reject(new Error(`bridge exited early with code ${code}`))
    })
  })
}

/** Read SSE frames from a fetch Response until `done(predicate)` or timeout. */
async function readSse(response, { until, timeoutMs = 45000 }) {
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  const events = []
  const deadline = Date.now() + timeoutMs

  while (Date.now() < deadline) {
    const { value, done } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    let index
    while ((index = buffer.indexOf('\n\n')) >= 0) {
      const frame = buffer.slice(0, index)
      buffer = buffer.slice(index + 1)
      const dataLine = frame.split('\n').find((l) => l.startsWith('data: '))
      if (!dataLine) continue
      try {
        const event = JSON.parse(dataLine.slice(6))
        events.push(event)
        if (until(event, events)) {
          await reader.cancel().catch(() => {})
          return events
        }
      } catch {
        /* ignore malformed frame */
      }
    }
  }
  await reader.cancel().catch(() => {})
  return events
}

/** Poll until the session is between turns (not busy and nothing awaiting approval). */
async function waitForIdle(base, sessionId, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const list = await (await fetch(`${base}/api/sessions`)).json()
    const view = list.sessions.find((s) => s.id === sessionId)
    if (view && view.status !== 'busy' && view.status !== 'awaiting_approval') return view
    await new Promise((r) => setTimeout(r, 300))
  }
  return null
}

/** Highest event seq recorded so far, used to anchor a fresh read of the stream. */
async function highestSeq(base, sessionId) {
  const controller = new AbortController()
  const response = await fetch(`${base}/api/sessions/${sessionId}/events`, {
    signal: controller.signal,
    headers: { accept: 'text/event-stream' },
  })
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let max = 0
  const deadline = Date.now() + 1200
  try {
    while (Date.now() < deadline) {
      const { value, done } = await Promise.race([
        reader.read(),
        new Promise((r) => setTimeout(() => r({ done: true }), 300)),
      ])
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      let index
      while ((index = buffer.indexOf('\n\n')) >= 0) {
        const frame = buffer.slice(0, index)
        buffer = buffer.slice(index + 1)
        const idLine = frame.split('\n').find((l) => l.startsWith('id: '))
        if (idLine) max = Math.max(max, Number(idLine.slice(4)) || 0)
      }
    }
  } catch {
    /* expected: we abort mid-stream */
  } finally {
    controller.abort()
  }
  return max
}

async function main() {
  if (!existsSync(CLAUDE)) {
    console.error(`claude.exe not found at ${CLAUDE}`)
    process.exit(2)
  }

  console.log('=== 1. start mock Anthropic backend ===')
  const mock = createMockAnthropic({ port: 0, quiet: true })
  // port 0 -> ask the OS, then read the real port back
  await new Promise((resolve) => mock.server.listen(0, '127.0.0.1', resolve))
  const mockPort = mock.server.address().port
  console.log(`  mock listening on 127.0.0.1:${mockPort}`)
  check('mock backend listening', mockPort > 0, `port ${mockPort}`)

  console.log('\n=== 2. start bridge (discovers claude.exe, port 0) ===')
  const bridge = spawn(process.execPath, [BRIDGE, '--port', '0', '--claude', CLAUDE, '--base-url', `http://127.0.0.1:${mockPort}`, '--token', 'sk-mock-token'], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env },
  })

  let ready
  try {
    ready = await waitForReady(bridge)
  } catch (error) {
    check('bridge reports ready', false, error.message)
    bridge.kill()
    await mock.close()
    return finish()
  }
  console.log(`  bridge ready: ${JSON.stringify(ready)}`)
  check('bridge reports ready with a port', Number.isInteger(ready.port) && ready.port > 0, `port ${ready.port}`)
  check('bridge discovered claude.exe', ready.binary === CLAUDE, ready.binary ?? 'null')

  const base = `http://127.0.0.1:${ready.port}`

  console.log('\n=== 3. health + discovery ===')
  const health = await (await fetch(`${base}/api/health`)).json()
  check('GET /api/health ok', health.ok === true, `sessions=${health.sessions}`)

  const discovery = await (await fetch(`${base}/api/discovery`)).json()
  check('GET /api/discovery finds binary', Boolean(discovery.binary?.path), discovery.binary?.path ?? 'null')
  check('GET /api/discovery reads claude config', Boolean(discovery.claude), `home=${discovery.claude.home}`)

  console.log('\n=== 4. create session ===')
  const created = await (
    await fetch(`${base}/api/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ cwd: process.cwd(), model: 'claude-sonnet-4-5', permissionMode: 'bypassPermissions' }),
    })
  ).json()
  check('POST /api/sessions created', typeof created.id === 'string', `id=${created.id}`)
  const sid = created.id

  console.log('\n=== 5. attach SSE and expect system/init ===')
  const sseController = new AbortController()
  const sseResponse = await fetch(`${base}/api/sessions/${sid}/events`, {
    signal: sseController.signal,
    headers: { accept: 'text/event-stream' },
  })
  check('SSE endpoint returns 200', sseResponse.status === 200, `status ${sseResponse.status}`)

  // Wait for init in the background while we send the turn.
  const initPromise = readSse(await fetch(`${base}/api/sessions/${sid}/events`), {
    until: (event) => event.kind === 'init',
    timeoutMs: 30000,
  })

  await new Promise((r) => setTimeout(r, 1500))

  console.log('\n=== 6. send a user turn, expect streamed reply ===')
  // Everything recorded so far is replayed on connect. Waiting on the raw stream would let a
  // replayed `result` satisfy the condition instantly, so waits are anchored to a cursor.
  const cursor = await highestSeq(base, sid)
  const accepted = await (
    await fetch(`${base}/api/sessions/${sid}/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'say hi please' }),
    })
  ).json()
  check('POST /api/sessions/:id/messages accepted', accepted.accepted === true)

  const events = await readSse(await fetch(`${base}/api/sessions/${sid}/events`, { headers: { 'last-event-id': String(cursor) } }), {
    until: (event) => event.kind === 'result',
    timeoutMs: 90000,
  })

  const kinds = events.map((e) => e.kind)
  console.log('  event kinds: ' + JSON.stringify(kinds))
  check('received system/init', kinds.includes('init'))
  check('received thinking block', kinds.includes('thinking'))
  check('received text block', kinds.includes('text'))
  check('received result', kinds.includes('result'))

  const init = events.find((e) => e.kind === 'init')
  if (init) {
    check('init carries claude session id', typeof init.claudeSessionId === 'string' && init.claudeSessionId.length > 0, init.claudeSessionId)
    check('init carries tool list', Array.isArray(init.tools) && init.tools.length > 0, `${init.tools?.length} tools`)
    check('init carries slash commands', Array.isArray(init.slashCommands) && init.slashCommands.length > 0, `${init.slashCommands?.length} commands`)
  }

  const result = events.find((e) => e.kind === 'result')
  if (result) {
    check('result carries usage', typeof result.usage?.inputTokens === 'number', JSON.stringify(result.usage))
  }

  const initEvents = await initPromise
  check('init observable on a second concurrent SSE stream', initEvents.some((e) => e.kind === 'init'))

  console.log('\n=== 7. targeted tool_use turn ===')
  // Wait for the previous turn to finish: the bridge rejects a send while a turn is running
  // (409), which is correct behaviour but would make this step racy.
  await waitForIdle(base, sid)
  const toolCursor = await highestSeq(base, sid)
  await fetch(`${base}/api/sessions/${sid}/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text: 'please run a tool now' }),
  })
  // A tool call parks on an approval ask, so the turn ends at the ask, not at a result.
  const toolEvents = await readSse(
    await fetch(`${base}/api/sessions/${sid}/events`, { headers: { 'last-event-id': String(toolCursor) } }),
    {
      until: (event) => event.kind === 'permission_request' || event.kind === 'tool_result',
      timeoutMs: 90000,
    },
  )
  const toolKinds = toolEvents.map((e) => e.kind)
  console.log('  event kinds: ' + JSON.stringify(toolKinds))
  check('received tool_use', toolKinds.includes('tool_use'))
  const toolUse = toolEvents.find((e) => e.kind === 'tool_use')
  if (toolUse) check('tool_use carries name+input', Boolean(toolUse.name) && toolUse.input !== undefined, `${toolUse.name}`)

  // The CLI now routes tool calls through the host. This session runs with
  // permissionMode=bypassPermissions, so the tool executes instead of parking on an approval
  // ask — the ask path has its own dedicated suite (test/permission.mjs).
  const toolResult = toolEvents.find((e) => e.kind === 'tool_result')
  check('tool call produced a result (bypassPermissions)', toolResult !== undefined, toolResult?.isError ? 'error' : 'ok')
  check('no approval ask under bypassPermissions', !toolKinds.includes('permission_request'))

  console.log('\n=== 8. session listing + shutdown ===')
  const list = await (await fetch(`${base}/api/sessions`)).json()
  check('GET /api/sessions lists the session', list.sessions?.some((s) => s.id === sid))
  check('session records claude session id', Boolean(list.sessions?.find((s) => s.id === sid)?.claudeSessionId))

  sseController.abort()
  await fetch(`${base}/api/sessions/${sid}`, { method: 'DELETE' })
  bridge.on('exit', () => {})
  bridge.kill()

  const totalRequests = mock.requests
  check('mock backend received requests', totalRequests >= 3, `${totalRequests} requests`)

  await mock.close()
  finish()
}

function finish() {
  const failed = results.filter((r) => !r.ok)
  console.log(`\n=== ${results.length - failed.length}/${results.length} checks passed ===`)
  if (failed.length > 0) {
    console.log('failures:')
    for (const f of failed) console.log(`  - ${f.name}${f.detail ? '  (' + f.detail + ')' : ''}`)
    process.exit(1)
  }
  process.exit(0)
}

main().catch((error) => {
  console.error('\ne2e harness error:', error)
  process.exit(1)
})
