/**
 * End-to-end approval-flow test.
 *
 * Proves the full permission round trip against the real CLI:
 *
 *   bridge -> claude.exe (control channel) -> can_use_tool ask -> test decides -> CLI acts
 *
 * Two scenarios, because "allow" alone would not prove the denial path is wired:
 *   1. ALLOW -> the tool must actually execute (the marker file appears on disk)
 *   2. DENY  -> the tool must NOT execute, and the CLI must still finish the turn
 *
 * ORDERING MATTERS: the SSE endpoint replays the recorded timeline, so a session that has
 * already emitted `result` would satisfy a naive "wait for result" immediately. Every wait
 * therefore counts events from *before* the turn is sent (`since`) and only considers frames
 * that arrived after it.
 *
 * Run: node packages/bridge/test/permission.mjs
 */
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { createPermissionMock, markerExists, resetMarker, MARKER_PATH } from './permission-mock.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const BRIDGE = join(here, '..', 'src', 'cli.mjs')
const CLAUDE = process.env.CCCN_CLAUDE_BINARY ?? 'D:\\Claudecode-CN\\_probe\\package\\claude.exe'

const results = []
function check(name, ok, detail = '') {
  results.push({ name, ok })
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${name}${detail ? '  — ' + detail : ''}`)
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
      reject(new Error(`bridge exited early (${code})`))
    })
  })
}

/** Poll a session's status until `predicate` holds. */
async function waitForStatus(base, sessionId, predicate, timeoutMs = 60000) {
  const deadline = Date.now() + timeoutMs
  let last = null
  while (Date.now() < deadline) {
    const list = await (await fetch(`${base}/api/sessions`)).json()
    last = list.sessions.find((s) => s.id === sessionId)
    if (last && predicate(last)) return last
    await new Promise((r) => setTimeout(r, 400))
  }
  return last
}

/** Fetch the recorded timeline, which works even before any consumer attaches. */
async function fetchHistory(base, sessionId) {
  const response = await fetch(`${base}/api/sessions/${sessionId}/events`, {
    headers: { accept: 'text/event-stream' },
    signal: AbortSignal.timeout(1500),
  }).catch(() => null)
  if (!response?.body) return []
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  const events = []
  try {
    for (;;) {
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
          events.push(JSON.parse(dataLine.slice(6)))
        } catch {
          /* skip */
        }
      }
    }
  } catch {
    /* timeout is the normal exit here */
  }
  return events
}

/**
 * Stream events and stop once `until` fires on a frame that arrived after the stream opened.
 * Events already recorded before this call are skipped by the caller using `since`.
 */
async function streamUntil(url, { until, onEvent, timeoutMs = 120000 }) {
  const controller = new AbortController()
  const response = await fetch(url, { signal: controller.signal, headers: { accept: 'text/event-stream' } })
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  const events = []
  const deadline = Date.now() + timeoutMs

  try {
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
        let event
        try {
          event = JSON.parse(dataLine.slice(6))
        } catch {
          continue
        }
        events.push(event)
        if (onEvent) await onEvent(event)
        if (until(event, events)) return events
      }
    }
  } finally {
    controller.abort()
  }
  return events
}

async function runScenario({ label, decision }) {
  console.log(`\n=== scenario: ${label} ===`)
  resetMarker()
  check(`${label}: marker absent before the turn`, !markerExists())

  const mock = createPermissionMock({ port: 0, quiet: true })
  const mockPort = await mock.listen()

  const bridge = spawn(
    process.execPath,
    [BRIDGE, '--port', '0', '--claude', CLAUDE, '--base-url', `http://127.0.0.1:${mockPort}`, '--token', 'sk-mock'],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  )

  let bridgeErr = ''
  let bridgeOut = ''
  bridge.stderr.setEncoding('utf8')
  bridge.stderr.on('data', (d) => {
    bridgeErr += d
  })
  bridge.stdout.setEncoding('utf8')
  bridge.stdout.on('data', (d) => {
    bridgeOut += d
  })
  // Surface bridge-side diagnostics so a stall explains itself instead of timing out silently.
  if (process.env.CCCN_VERBOSE === '1') {
    bridge.stderr.on('data', (d) => process.stderr.write('[bridge] ' + d))
  }

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

    // Wait for the CLI to actually be up before sending, otherwise the first stream would
    // race the init frame and mistake a replayed event for this turn's.
    const booted = await waitForStatus(base, session.id, (s) => s.status === 'ready', 60000)
    check(`${label}: session reached ready`, booted?.status === 'ready', booted?.status ?? 'timeout')
    if (booted?.status !== 'ready') {
      const history = await fetchHistory(base, session.id)
      console.log(`  replayed ${history.length} event(s): ${JSON.stringify(history.map((e) => e.kind))}`)
      for (const event of history.slice(-4)) console.log('    ' + JSON.stringify(event).slice(0, 300))
      console.log('  bridge stdout: ' + bridgeOut.trim().slice(-400))
      console.log('  bridge stderr: ' + bridgeErr.trim().slice(-600))
      return
    }

    // How many events exist before the turn starts; everything at or below this count is
    // replayed history and must not satisfy a wait.
    const beforeCount = booted.historyLength
    let replayed = 0
    let askSeen = null
    let decided = false

    const isFresh = () => replayed >= beforeCount

    const onEvent = async (event) => {
      replayed++
      if (!isFresh()) return
      if (event.kind === 'permission_request' && !decided) {
        askSeen = event
        decided = true
        const response = await fetch(`${base}/api/sessions/${session.id}/permissions`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ requestId: event.requestId, behavior: decision, scope: 'once' }),
        })
        console.log(`  decided ${decision} -> HTTP ${response.status}`)
      }
    }

    // Open the stream first so nothing is missed, then send the turn.
    const streamPromise = streamUntil(`${base}/api/sessions/${session.id}/events`, {
      onEvent,
      until: (event, events) =>
        replayed > beforeCount && event.kind === 'result' && events.some((e) => e.kind === 'permission_settled'),
    })

    await new Promise((r) => setTimeout(r, 600))
    const accepted = await fetch(`${base}/api/sessions/${session.id}/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'please write the marker file' }),
    })
    check(`${label}: turn accepted`, accepted.status === 202, `HTTP ${accepted.status}`)

    const events = await streamPromise

    check(`${label}: permission_request raised`, askSeen !== null)
    if (askSeen) {
      check(`${label}: ask carries a requestId`, typeof askSeen.requestId === 'string' && askSeen.requestId.length > 0)
      check(`${label}: ask carries the tool name`, askSeen.name === 'Write', askSeen.name)
      check(`${label}: ask carries the tool input`, askSeen.input?.file_path === MARKER_PATH)
      check(`${label}: ask carries a tool_use_id`, typeof askSeen.toolUseId === 'string' && askSeen.toolUseId.length > 0, askSeen.toolUseId)
      check(
        `${label}: ask carries the CLI's own suggestions`,
        Array.isArray(askSeen.suggestions) && askSeen.suggestions.length > 0,
        `${askSeen.suggestions?.length ?? 0} suggestion(s)`,
      )
    }

    const settled = events.find((event) => event.kind === 'permission_settled')
    check(`${label}: permission_settled emitted`, settled !== undefined, settled?.decision)
    check(`${label}: settled decision matches`, settled?.decision === decision)

    const result = events.find((event) => event.kind === 'result')
    check(`${label}: turn completed`, result !== undefined, result?.stopReason)

    // The behavioural assertion: the marker file is written only if the tool was permitted.
    if (decision === 'allow') {
      check(`${label}: tool actually executed (marker written)`, markerExists(), MARKER_PATH)
    } else {
      check(`${label}: tool did NOT execute (no marker)`, !markerExists(), MARKER_PATH)
    }

    // The session must be usable again, with nothing left parked.
    const after = await waitForStatus(base, session.id, (s) => s.pendingPermissions?.length === 0, 20000)
    check(`${label}: no permission left pending`, (after?.pendingPermissions ?? []).length === 0)
    check(`${label}: session not stuck awaiting approval`, after?.status !== 'awaiting_approval', after?.status)

    // Answering the same ask twice must fail rather than corrupt the control channel.
    if (askSeen) {
      const replay = await fetch(`${base}/api/sessions/${session.id}/permissions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ requestId: askSeen.requestId, behavior: 'allow' }),
      })
      check(`${label}: re-answering an answered ask is rejected`, replay.status === 409, `HTTP ${replay.status}`)
    }

    const bogus = await fetch(`${base}/api/sessions/${session.id}/permissions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ requestId: '00000000-0000-4000-8000-000000000000', behavior: 'allow' }),
    })
    check(`${label}: unknown requestId rejected`, bogus.status === 409, `HTTP ${bogus.status}`)
  } finally {
    bridge.kill()
    await mock.close()
    resetMarker()
  }
}

async function main() {
  if (!existsSync(CLAUDE)) {
    console.error(`claude.exe not found at ${CLAUDE}`)
    process.exit(2)
  }

  await runScenario({ label: 'allow', decision: 'allow' })
  await runScenario({ label: 'deny', decision: 'deny' })

  const failed = results.filter((r) => !r.ok)
  console.log(`\n=== ${results.length - failed.length}/${results.length} checks passed ===`)
  if (failed.length > 0) {
    console.log('failures:')
    for (const f of failed) console.log('  - ' + f.name)
    process.exit(1)
  }
  process.exit(0)
}

main().catch((error) => {
  console.error('\npermission test harness error:', error)
  process.exit(1)
})
