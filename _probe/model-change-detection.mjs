/**
 * Does the app notice a MODEL change on a session it is already showing?
 *
 * Reported symptom: switching the model leaves the balance unchanged. The balance is derived from
 * the session's model (which provider it belongs to), so a stale model in the client's session list
 * would explain it exactly.
 *
 * `refreshSessions` preserves the previous session OBJECT when `status` and `historyLength` are
 * unchanged — an optimisation against list churn. But switching to another model of the SAME provider
 * changes neither: the CLI stays 'ready' and the transcript length does not move. So the client can
 * keep a stale `model` indefinitely.
 *
 * The switch is made over the BRIDGE API here, so this measures the client's polling rather than
 * whatever the composer happens to do with its own local state.
 *
 * Run: CCCN_BRIDGE_URL=... CCCN_UI_URL=... node _probe/model-change-detection.mjs
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const bridgeUrl = process.argv[2] ?? process.env.CCCN_BRIDGE_URL ?? 'http://127.0.0.1:43240'
const uiUrl = process.argv[3] ?? process.env.CCCN_UI_URL ?? 'http://127.0.0.1:5220'

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
// Two models under ONE provider: switching between them changes neither status nor historyLength,
// which is precisely the case the identity optimisation gets wrong.
const session = await api('/api/sessions', {
  method: 'POST',
  body: JSON.stringify({ cwd: process.cwd(), model: 'model-alpha' }),
})

const profile = mkdtempSync(join(tmpdir(), 'cccn-modelchange-'))
const port = 9850 + Math.floor(Math.random() * 60)
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
  { stdio: 'ignore' },
)

try {
  const deadline = Date.now() + 20000
  let up = false
  while (Date.now() < deadline && !up) {
    try {
      up = (await fetch(`http://127.0.0.1:${port}/json/version`)).ok
    } catch {
      /* not up */
    }
    if (!up) await sleep(150)
  }
  if (!up) throw new Error('devtools never came up')

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

  const settings = JSON.stringify({
    language: 'zh-CN',
    appearance: 'dark',
    sendOnEnter: true,
    permissionPreset: 'ask',
    defaultModelRef: '',
    priceTables: [],
    providers: [
      {
        id: 'p1',
        name: 'DeepSeek',
        baseUrl: 'https://api.deepseek.com/anthropic',
        apiKey: 'sk-test',
        persistKey: true,
        isDefault: true,
        models: [
          { id: 'a', model: 'model-alpha', label: '' },
          { id: 'b', model: 'model-beta', label: '' },
        ],
      },
    ],
  })

  /**
   * What the client believes the session's model is, read from the rendered UI.
   *
   * Scoped to `.composer__trailing`: `.composer__select` is shared with the permission chip, which
   * comes first in the DOM — matching it unscoped reads "需逐步审批" and silently measures nothing.
   */
  const shownModel = async () =>
    evaluate(`document.querySelector('.composer__trailing .composer__select')?.innerText?.trim() ?? null`)

  await send('Page.enable')
  await send('Page.navigate', { url: uiUrl })
  await sleep(2500)
  await evaluate(`localStorage.setItem('cccn.settings.v3', ${JSON.stringify(settings)})`)
  await send('Page.navigate', { url: `${uiUrl}${uiUrl.includes('?') ? '&' : '?'}session=newest` })
  await sleep(9000)

  const before = await shownModel()
  console.log(`  client shows: ${JSON.stringify(before)}`)
  check('the client starts on the session model', String(before).includes('model-alpha'), String(before))

  // Switch over the API: same provider, so status and historyLength both stay put.
  const switchResponse = await fetch(`${bridgeUrl}/api/sessions/${session.id}/model`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'model-beta' }),
  })
  check('the bridge accepted the switch', switchResponse.status === 200, `HTTP ${switchResponse.status}`)

  // Confirm the SERVER really changed, so a client-side miss is unambiguous.
  await sleep(1000)
  const serverModel = (await api(`/api/sessions/${session.id}`)).model
  check('the server reports the new model', serverModel === 'model-beta', String(serverModel))

  // Polling interval is 2500 ms; allow several ticks.
  await sleep(9000)
  const after = await shownModel()
  console.log(`  client shows: ${JSON.stringify(after)}`)
  check(
    'THE CLIENT PICKED UP THE MODEL CHANGE',
    String(after).includes('model-beta'),
    `client still shows ${JSON.stringify(after)} while the server says ${serverModel}`,
  )

  await api(`/api/sessions/${session.id}?purge=1`, { method: 'DELETE' })
  socket.close()
} catch (error) {
  console.error(`check failed: ${String(error.message ?? error)}`)
  failures++
} finally {
  browser.kill()
  await sleep(300)
  rmSync(profile, { recursive: true, force: true })
}

console.log(`\n${failures === 0 ? 'all checks passed' : failures + ' check(s) failed'}`)
process.exit(failures === 0 ? 0 : 1)
