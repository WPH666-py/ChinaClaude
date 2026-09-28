/**
 * Verify the sidebar names the model/provider BEFORE any turn has run.
 *
 * The reported bug was concrete: a fresh session showed
 *   `本会话用量 0 / 入 0 · 出 0 / 账户余额 ¥107.53`
 * with no indication of which provider that balance belonged to. The cause was structural — the
 * vendor line was rendered inside the COST block, which only appears once a turn has been priced, so
 * it was unreachable exactly when a user first opens a session.
 *
 * So this asserts the two states separately, because passing one says nothing about the other:
 *   A. no turns  -> model + provider still shown, no cost row, balance labelled with its owner;
 *   B. one turn  -> cost row appears, and the BILLED model is named (the relay remaps it).
 *
 * Run: CCCN_BRIDGE_URL=... CCCN_UI_URL=... node _probe/model-context-check.mjs
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const bridgeUrl = process.argv[2] ?? process.env.CCCN_BRIDGE_URL ?? 'http://127.0.0.1:43200'
const uiUrl = process.argv[3] ?? process.env.CCCN_UI_URL ?? 'http://127.0.0.1:5200'
const apiKey = process.argv[4] ?? process.env.CCCN_KEY ?? ''

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

// The model name is deliberately one the RELAY remaps, so state B can prove the billed model is
// named separately from the requested one.
const session = await api('/api/sessions', {
  method: 'POST',
  body: JSON.stringify({ cwd: process.cwd(), model: 'claude-sonnet-5' }),
})

const profile = mkdtempSync(join(tmpdir(), 'cccn-model-'))
const port = 9750 + Math.floor(Math.random() * 60)
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
  const card = () => evaluate(`document.querySelector('.usageCard')?.innerText?.replace(/\\n/g, ' | ') ?? null`)

  const settings = JSON.stringify({
    language: 'zh-CN',
    appearance: 'dark',
    sendOnEnter: true,
    permissionPreset: 'ask',
    defaultModelRef: '',
    priceTables: [],
    providers: [
      {
        id: 'p-deepseek',
        name: 'DeepSeek',
        baseUrl: 'https://api.deepseek.com/anthropic',
        apiKey,
        persistKey: true,
        isDefault: true,
        models: [{ id: 'm1', model: 'claude-sonnet-5', label: 'Sonnet（走中继）' }],
      },
    ],
  })

  await send('Page.enable')
  await send('Page.navigate', { url: uiUrl })
  await sleep(2500)
  await evaluate(`localStorage.setItem('cccn.settings.v3', ${JSON.stringify(settings)})`)
  await send('Page.navigate', { url: `${uiUrl}${uiUrl.includes('?') ? '&' : '?'}session=newest` })
  await sleep(10000)

  // ---- A. no turns yet -----------------------------------------------------
  console.log('state A — session open, zero turns')
  const empty = await card()
  console.log(`  card: ${empty}`)
  check('the usage row renders', String(empty).includes('本会话用量'))
  check('THE MODEL IS NAMED before any turn', String(empty).includes('claude-sonnet-5'), empty)
  check('THE PROVIDER IS NAMED before any turn', String(empty).includes('DeepSeek'), empty)
  check('no cost row is invented with zero turns', !String(empty).includes('费用'), empty)
  check('the balance names its owner', /DeepSeek 余额/.test(String(empty)), empty)

  // ---- B. after one turn ---------------------------------------------------
  console.log('state B — after one priced turn')
  await api(`/api/sessions/${session.id}/messages`, {
    method: 'POST',
    body: JSON.stringify({ text: 'one turn for the label check' }),
  })
  for (let i = 0; i < 40; i++) {
    const cost = await api(`/api/sessions/${session.id}/cost`)
    if ((cost.cost?.pricedTurns ?? 0) > 0) break
    await sleep(1500)
  }
  await sleep(3000)
  const priced = await card()
  console.log(`  card: ${priced}`)
  check('a cost row appears once a turn is priced', String(priced).includes('费用'), priced)
  check(
    'the BILLED model is named next to the cost',
    /DeepSeek-V4|Flash|V4\.1/.test(String(priced)),
    priced,
  )
  check('the requested model is still shown', String(priced).includes('claude-sonnet-5'), priced)

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
