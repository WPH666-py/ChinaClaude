/**
 * Record the input events the packaged app's webview actually receives.
 *
 * Established by measurement so far:
 *   - the setup form DOES render at first paint,
 *   - the settings panel opens on its own ~18s later, and
 *   - the SAME web app in a browser stays put for 40s.
 *
 * So the trigger is specific to the Tauri/WebView2 environment, and the two in-app state changes
 * observed across runs (settings opening, a session being created) are both things only a CLICK can
 * cause. Reading source cannot distinguish "a click arrived" from "some code path ran", so this
 * installs capture-phase listeners and reports what the page was actually told.
 *
 * Read-only with respect to app logic: it observes events, it never dispatches any.
 *
 * Run: node _probe/input-trace.mjs <cdpPort> [seconds]
 */
const cdpPort = Number(process.argv[2] ?? 9336)
const seconds = Number(process.argv[3] ?? 45)
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function findTarget(timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${cdpPort}/json/list`)).json()
      const page = list.find((entry) => entry.type === 'page')
      if (page) return page
    } catch {
      /* not up */
    }
    await sleep(200)
  }
  throw new Error(`no webview target on ${cdpPort}`)
}

const page = await findTarget()
const socket = new WebSocket(page.webSocketDebuggerUrl)
await new Promise((resolve, reject) => {
  socket.addEventListener('open', resolve, { once: true })
  socket.addEventListener('error', () => reject(new Error('cdp socket failed')), { once: true })
})

let nextId = 1
const pending = new Map()
socket.addEventListener('message', (event) => {
  const message = JSON.parse(event.data)
  if (message.id !== undefined && pending.has(message.id)) {
    const { resolve, reject } = pending.get(message.id)
    pending.delete(message.id)
    if (message.error) reject(new Error(message.error.message))
    else resolve(message.result)
  }
})
const send = (method, params = {}) =>
  new Promise((resolve, reject) => {
    const id = nextId++
    pending.set(id, { resolve, reject })
    socket.send(JSON.stringify({ id, method, params }))
  })
const evaluate = async (expression) => {
  const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.text ?? 'eval failed')
  return result.result?.value
}

// Install the recorder. `window.__trace` is ours; nothing in the app reads it.
const install = await evaluate(`(() => {
  if (window.__traceInstalled) return 'already'
  window.__trace = []
  const describe = (node) => {
    if (!node) return 'null'
    const el = node.nodeType === 1 ? node : node.parentElement
    if (!el) return String(node)
    const cls = (el.className || '').toString().split(' ').filter(Boolean).slice(0, 3).join('.')
    const text = (el.innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 40)
    return el.tagName.toLowerCase() + (cls ? '.' + cls : '') + (text ? ' "' + text + '"' : '')
  }
  const record = (kind, detail) => window.__trace.push({ t: Date.now(), kind, detail })
  for (const type of ['click', 'mousedown', 'keydown', 'pointerdown', 'focusin']) {
    window.addEventListener(type, (event) => {
      record(type, type === 'keydown'
        ? (event.key + ' target=' + describe(event.target) + ' trusted=' + event.isTrusted)
        : (describe(event.target) + ' trusted=' + event.isTrusted))
    }, true)
  }
  window.addEventListener('visibilitychange', () => record('visibility', document.visibilityState), true)
  window.addEventListener('focus', () => record('window-focus', 'focus'), true)
  window.addEventListener('blur', () => record('window-blur', 'blur'), true)
  window.__traceInstalled = true
  window.__traceStart = Date.now()
  return 'installed'
})()`)
console.log(`recorder: ${install}`)
console.log(`watching ${seconds}s for input events…`)

await sleep(seconds * 1000)

const trace = await evaluate(`JSON.stringify({
  trace: window.__trace.map(e => ({ dt: ((e.t - window.__traceStart) / 1000).toFixed(1) + 's', kind: e.kind, detail: e.detail })),
  setup: document.querySelectorAll('.setup').length,
  rail: document.querySelectorAll('.st__railItem').length,
  sessions: document.querySelectorAll('.sessionItem').length
})`)

const parsed = JSON.parse(trace)
console.log('')
if (parsed.trace.length === 0) {
  console.log('NO input events reached the page.')
} else {
  console.log('input events the page received:')
  for (const entry of parsed.trace) console.log(`  +${entry.dt.padStart(6)}  ${entry.kind.padEnd(14)} ${entry.detail}`)
}
console.log('')
console.log(`final state: setup=${parsed.setup} settingsRail=${parsed.rail} sessionRows=${parsed.sessions}`)

socket.close()
