/**
 * Behavioural check for the two new setup-form interactions.
 *
 * Rendering is not behaviour. These assertions click the real controls and then read back what the
 * BRIDGE recorded, so a control that looks right but sends nothing fails here.
 *
 *   1. 取消 leaves the form without creating anything.
 *   2. Picking a permission card actually starts a session in that CLI mode — the previous
 *      free-text field accepted any string, and a typo would have been silently fallen back from,
 *      so "the card is highlighted" is not evidence that the right mode was sent.
 *
 * Run: node _probe/setup-interactions-check.mjs <bridgeUrl> <uiUrl>
 */
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const bridgeUrl = process.argv[2] ?? 'http://127.0.0.1:43160'
const uiUrl = process.argv[3] ?? 'http://127.0.0.1:5190'

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

let failures = 0
const check = (name, ok, detail = '') => {
  if (!ok) failures++
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${name}${detail ? '  — ' + detail : ''}`)
}

for (const session of (await api('/api/sessions')).sessions ?? []) {
  await api(`/api/sessions/${session.id}?purge=1`, { method: 'DELETE' })
}
console.log(`sessions reset to ${((await api('/api/sessions')).sessions ?? []).length}`)

const profile = mkdtempSync(join(tmpdir(), 'cccn-setup-'))
const port = 9950 + Math.floor(Math.random() * 40)
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
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.text ?? 'eval failed')
    return result.result?.value
  }

  await send('Page.enable')

  // ---- 1. cancel -----------------------------------------------------------
  await send('Page.navigate', { url: uiUrl })
  await sleep(5000)

  const before = await evaluate(`JSON.stringify({
    setup: !!document.querySelector('.setup'),
    cancel: !!document.querySelector('.setup__cancel'),
    placeholder: document.body.innerText.includes('开始对话')
  })`)
  console.log(`  before cancel: ${before}`)
  check('the setup form is showing', JSON.parse(before).setup === true)
  check('a cancel button exists', JSON.parse(before).cancel === true)

  await evaluate(`document.querySelector('.setup__cancel').click()`)
  await sleep(1200)

  const after = await evaluate(`JSON.stringify({
    setup: !!document.querySelector('.setup'),
    placeholder: document.body.innerText.includes('开始对话')
  })`)
  console.log(`  after cancel: ${after}`)
  check('cancel closes the setup form', JSON.parse(after).setup === false)
  check('cancel lands on the empty state', JSON.parse(after).placeholder === true)
  check('cancel creates no session', ((await api('/api/sessions')).sessions ?? []).length === 0)

  // ---- 2. the permission card drives the launched mode ---------------------
  await send('Page.navigate', { url: uiUrl })
  await sleep(5000)

  // Pick 完全权限 (bypassPermissions) — the one whose mis-sending would be most consequential.
  const picked = await evaluate(`(() => {
    const card = [...document.querySelectorAll('.permCard')].find(c => c.innerText.includes('完全权限'))
    if (!card) return 'no card'
    card.click()
    return 'clicked'
  })()`)
  check('the 完全权限 card can be clicked', picked === 'clicked', String(picked))
  await sleep(300)

  const selected = await evaluate(`document.querySelector('.permCard--on')?.innerText.split('\\n')[0] ?? null`)
  check('the clicked card becomes the selected one', selected === '完全权限', String(selected))

  // The workspace must be set or the session cannot start; seed it through the recent list.
  await evaluate(`(() => {
    const input = document.querySelector('#ws')
    if (!input) return 'no input'
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
    setter.call(input, 'D:\\\\Claudecode-CN')
    input.dispatchEvent(new Event('input', { bubbles: true }))
    return 'set'
  })()`)
  await sleep(300)

  const started = await evaluate(`(() => {
    const btn = [...document.querySelectorAll('button')].find(b => b.innerText.trim() === '开始会话')
    if (!btn) return 'no button'
    btn.click()
    return 'clicked'
  })()`)
  check('开始会话 can be clicked', started === 'clicked', String(started))

  await sleep(9000)
  const sessions = (await api('/api/sessions')).sessions ?? []
  console.log(`  sessions after start: ${sessions.length}`)
  check('a session was created', sessions.length === 1, String(sessions.length))
  check(
    'the session launched in the mode the card represents',
    sessions[0]?.permissionMode === 'bypassPermissions',
    `permissionMode=${String(sessions[0]?.permissionMode)}`,
  )

  for (const session of sessions) {
    await api(`/api/sessions/${session.id}?purge=1`, { method: 'DELETE' })
  }
  socket.close()
} catch (error) {
  console.error(`check failed: ${String(error.message ?? error)}`)
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
