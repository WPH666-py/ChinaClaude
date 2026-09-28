/**
 * Drive a complete conversation through the Vite proxy — the exact path the browser takes
 * (localhost:5173 -> /api -> bridge -> claude.exe -> mock backend).
 *
 * Two modes:
 *   node ui-flow.mjs                       against the dev server (also asserts the page loads)
 *   node ui-flow.mjs --bridge <port>       against a running bridge, e.g. the one owned by
 *                                          the packaged desktop app (acceptance check)
 */
const bridgeFlag = process.argv.indexOf('--bridge')
const BRIDGE_MODE = bridgeFlag >= 0
const BRIDGE_PORT = BRIDGE_MODE ? Number(process.argv[bridgeFlag + 1]) : null
const BASE = BRIDGE_MODE ? `http://127.0.0.1:${BRIDGE_PORT}` : (process.argv[2] ?? 'http://localhost:5173')
const MOCK_BASE = process.env.CCCN_MOCK_URL ?? 'http://127.0.0.1:59921'

const results = []
function check(name, ok, detail = '') {
  results.push({ name, ok })
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${name}${detail ? '  — ' + detail : ''}`)
}

async function readSse(url, { until, timeoutMs = 60000 }) {
  const controller = new AbortController()
  const response = await fetch(url, { signal: controller.signal, headers: { accept: 'text/event-stream' } })
  if (!response.ok || !response.body) throw new Error(`stream ${response.status}`)

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
        try {
          const event = JSON.parse(dataLine.slice(6))
          events.push(event)
          if (until(event)) return events
        } catch {
          /* ignore */
        }
      }
    }
  } finally {
    controller.abort()
  }
  return events
}

console.log(`=== driving UI flow through ${BASE}${BRIDGE_MODE ? ' (running bridge / packaged app)' : ' (vite dev proxy)'} ===`)

// 1. the page itself — only meaningful when a dev server is in front of the bridge.
if (!BRIDGE_MODE) {
  const page = await fetch(`${BASE}/`)
  const html = await page.text()
  check('GET / serves the app shell', page.status === 200 && html.includes('id="app"'), `${html.length} bytes`)
}

// 2. what the app calls on boot
const health = await (await fetch(`${BASE}/api/health`)).json()
check('boot health via proxy', health.ok === true)

const discovery = await (await fetch(`${BASE}/api/discovery`)).json()
check('boot discovery via proxy', Boolean(discovery.binary?.path), discovery.binary?.path ?? 'null')

// 3. create a session exactly as the setup form does
const created = await (
  await fetch(`${BASE}/api/sessions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      cwd: 'D:\\Claudecode-CN',
      baseUrl: MOCK_BASE,
      authToken: 'sk-mock-token',
    }),
  })
).json()
check('setup form creates session', typeof created.id === 'string', created.id)
const sid = created.id

// 4. the SSE stream the Transcript component consumes
const streamPromise = readSse(`${BASE}/api/sessions/${sid}/events`, {
  until: (event) => event.kind === 'result',
})
await new Promise((r) => setTimeout(r, 1800))

await fetch(`${BASE}/api/sessions/${sid}/messages`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ text: 'hello from the ui flow test' }),
})

const events = await streamPromise
const kinds = events.map((e) => e.kind)
console.log('  timeline kinds: ' + JSON.stringify(kinds))
check('timeline gets init', kinds.includes('init'))
check('timeline gets assistant text', kinds.includes('text'))
check('timeline gets result footer', kinds.includes('result'))

// 5. sidebar listing
const list = await (await fetch(`${BASE}/api/sessions`)).json()
check('sidebar lists session', list.sessions?.some((s) => s.id === sid))

// 6. teardown path used by the stop button
const stopped = await (await fetch(`${BASE}/api/sessions/${sid}`, { method: 'DELETE' })).json()
check('stop button closes session', stopped.stopped === true)

const failed = results.filter((r) => !r.ok)
console.log(`\n=== ${results.length - failed.length}/${results.length} checks passed ===`)
process.exit(failed.length === 0 ? 0 : 1)
