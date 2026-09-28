/**
 * Does a session that appears AFTER the page opened get adopted?
 *
 * App.vue registers a watcher on the session count with the comment "Adopt a session that appeared
 * while we were showing the setup form (created over the API, in another window, or by the CLI)".
 * That is a claim about behaviour, and the packaged app appeared to contradict it: a session created
 * over the API while the first-run setup form was open did NOT take over the view.
 *
 * This drives a real page over CDP and keeps it open across the session creation, which is the only
 * way to observe the watcher — a fresh page load takes a different code path entirely
 * (`setupOpen = sessions.length === 0` at mount), and would pass even if the watcher were broken.
 *
 * Run: node _probe/adopt-session-check.mjs <bridgeUrl> <uiUrl>
 */
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const bridgeUrl = process.argv[2] ?? 'http://127.0.0.1:43150'
const uiUrl = process.argv[3] ?? 'http://127.0.0.1:5185'

const EDGE = [
  `${process.env.ProgramFiles}\\Microsoft\\Edge\\Application\\msedge.exe`,
  `${process.env['ProgramFiles(x86)']}\\Microsoft\\Edge\\Application\\msedge.exe`,
].find((candidate) => candidate && existsSync(candidate))
if (!EDGE) {
  console.error('msedge.exe not found')
  process.exit(1)
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const api = async (path, init) => {
  const response = await fetch(`${bridgeUrl}${path}`, {
    ...init,
    headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
  })
  return response.json().catch(() => ({}))
}

// Start from zero sessions, or the mount path would mask the watcher.
for (const session of (await api('/api/sessions')).sessions ?? []) {
  await api(`/api/sessions/${session.id}?purge=1`, { method: 'DELETE' })
}
console.log(`sessions reset to ${((await api('/api/sessions')).sessions ?? []).length}`)

const profile = mkdtempSync(join(tmpdir(), 'cccn-adopt-'))
const port = 9700 + Math.floor(Math.random() * 200)
const browser = spawn(
  EDGE,
  [
    '--headless=new',
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    `--user-data-dir=${profile}`,
    `--remote-debugging-port=${port}`,
    '--window-size=1440,900',
    'about:blank',
  ],
  { stdio: ['ignore', 'ignore', 'ignore'] },
)

async function waitForDevTools(timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/version`)
      if (response.ok) return
    } catch {
      /* not up */
    }
    await sleep(150)
  }
  throw new Error('devtools never came up')
}

let failures = 0
const check = (name, ok, detail = '') => {
  if (!ok) failures++
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${name}${detail ? '  — ' + detail : ''}`)
}

try {
  await waitForDevTools()
  const target = await (await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT' })).json()
  const socket = new WebSocket(target.webSocketDebuggerUrl)
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true })
    socket.addEventListener('error', () => reject(new Error('socket failed')), { once: true })
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
    return result.result?.value
  }

  /** What the page is showing, in terms the assertions can name. */
  const state = async () =>
    JSON.parse(
      await evaluate(`JSON.stringify({
        setupForm: document.body.innerText.includes('首次启动'),
        placeholder: document.body.innerText.includes('开始对话'),
        sessionItems: document.querySelectorAll('.sessionItem').length,
        groupRows: document.querySelectorAll('.panelRow').length,
        sidebarText: (document.querySelector('.sidebar')?.innerText ?? '').replace(/\\n+/g, ' / ').slice(0, 240),
        usage: document.querySelector('.usageCard')?.innerText?.replace(/\\n/g, ' | ') ?? null
      })`),
    )

  await send('Page.enable')
  await send('Page.navigate', { url: uiUrl })
  await sleep(5000)

  const before = await state()
  console.log(`  initial: ${JSON.stringify(before)}`)
  check('first run shows the setup form', before.setupForm === true)
  check('the sidebar starts with no sessions', before.sessionItems === 0, String(before.sessionItems))

  // Create it the way an external client would: straight over the bridge API.
  const created = await api('/api/sessions', {
    method: 'POST',
    body: JSON.stringify({ cwd: process.cwd(), model: 'claude-sonnet-5' }),
  })
  console.log(`  created out-of-band: ${created.id}`)

  // Polling interval is 2500 ms; allow several ticks.
  await sleep(9000)
  const after = await state()
  console.log(`  after 9s: ${JSON.stringify(after)}`)

  check(
    'the sidebar picked up the new session',
    after.sidebarText.includes('Claudecode-CN') || after.groupRows > before.groupRows,
    `sidebar: ${after.sidebarText}`,
  )
  check(
    'the page ADOPTED the new session (setup form replaced)',
    after.setupForm === false,
    after.setupForm ? 'setup form still on screen — the watcher did not take over' : '',
  )

  // A second observation: attaching is what proves adoption rather than merely hiding the form.
  const attached = await evaluate(
    `(async () => { const r = await fetch('${bridgeUrl}/api/sessions'); const j = await r.json(); return j.sessions.length })()`,
  )
  check('exactly one session exists server-side', attached === 1, String(attached))

  await api(`/api/sessions/${created.id}?purge=1`, { method: 'DELETE' })
  socket.close()
} catch (error) {
  console.error(`repro failed: ${String(error.message ?? error)}`)
  failures++
} finally {
  browser.kill()
  await sleep(300)
  try {
    rmSync(profile, { recursive: true, force: true })
  } catch {
    /* best effort */
  }
}

console.log(`\n${failures === 0 ? 'all checks passed' : failures + ' check(s) failed'}`)
process.exit(failures === 0 ? 0 : 1)
