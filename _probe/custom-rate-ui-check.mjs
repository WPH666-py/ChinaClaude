/**
 * End-to-end proof that a user-supplied price table actually prices a NON-DeepSeek model in the UI.
 *
 * The unit probe already proves the arithmetic. What this checks is the wiring the arithmetic cannot:
 * that settings reach the pricer at all. Measured before it existed: every qwen / glm / kimi name
 * came back unpriced, so the sidebar's 费用 row never appeared.
 *
 * Seeds localStorage with a rate row, then drives a real turn and reads the sidebar back out of the
 * page — the same surface a user sees, not an internal value.
 *
 * Run: node _probe/custom-rate-ui-check.mjs <bridgeUrl> <uiUrl>
 */
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const bridgeUrl = process.argv[2] ?? 'http://127.0.0.1:43160'
const uiUrl = process.argv[3] ?? 'http://127.0.0.1:5190'
const MODEL = process.argv[4] ?? 'qwen-max'

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

// A session on the vendor model, plus one turn, created over the API so the page stays the only
// thing under test.
const session = await api('/api/sessions', {
  method: 'POST',
  body: JSON.stringify({ cwd: process.cwd(), model: MODEL }),
})
await sleep(4000)
await api(`/api/sessions/${session.id}/messages`, {
  method: 'POST',
  body: JSON.stringify({ text: 'hello from the custom-rate check' }),
})
for (let i = 0; i < 40; i++) {
  const cost = await api(`/api/sessions/${session.id}/cost`)
  if ((cost.cost?.pricedTurns ?? 0) > 0) break
  await sleep(1500)
}

const profile = mkdtempSync(join(tmpdir(), 'cccn-rate-'))
const port = 9900 + Math.floor(Math.random() * 80)
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

  const settingsBlob = JSON.stringify({
    language: 'zh-CN',
    appearance: 'dark',
    sendOnEnter: true,
    permissionPreset: 'ask',
    defaultModelRef: '',
    providers: [],
    priceTables: [
      {
        id: 'test-qwen',
        match: 'qwen',
        label: '通义千问（测试价目）',
        cacheMiss: 2.4,
        cacheHit: 0.24,
        output: 9.6,
      },
    ],
  })

  // localStorage must be written on the right ORIGIN, so load the page first, seed, then reload.
  await send('Page.enable')
  await send('Page.navigate', { url: uiUrl })
  await sleep(3000)
  await evaluate(`localStorage.setItem('cccn.settings.v3', ${JSON.stringify(settingsBlob)})`)
  await send('Page.navigate', { url: `${uiUrl}${uiUrl.includes('?') ? '&' : '?'}session=newest` })
  await sleep(9000)

  const usage = await evaluate(`document.querySelector('.usageCard')?.innerText?.replace(/\\n/g, ' | ') ?? null`)
  console.log(`  sidebar: ${usage}`)

  check('the session shows a usage card', typeof usage === 'string' && usage.includes('本会话用量'))
  check('cost is priced for a non-DeepSeek model', usage.includes('费用'), usage)
  // Parse rather than pattern-match the digits: a cheap turn renders as ¥0.0035, which a
  // "looks non-zero" regex gets wrong because the third decimal is a zero.
  const amount = Number((/¥([\d.]+)/.exec(usage)?.[1] ?? '0'))
  check('the amount is a positive number', Number.isFinite(amount) && amount > 0, `parsed ¥${amount}`)
  check(
    'a flat-rate vendor is NOT labelled with a peak basis',
    !usage.includes('高峰时段价') && !usage.includes('空闲时段价'),
    usage,
  )
  check('no unpriced turns are reported', !usage.includes('未计价'), usage)
  check('the table label identifies the source', usage.includes('通义千问') || usage.includes('费用'), usage)

  // Now prove the negative: with the table removed, the same session must go unpriced again.
  await evaluate(
    `localStorage.setItem('cccn.settings.v3', JSON.stringify({ ...JSON.parse(localStorage.getItem('cccn.settings.v3')), priceTables: [] }))`,
  )
  await send('Page.navigate', { url: `${uiUrl}${uiUrl.includes('?') ? '&' : '?'}session=newest` })
  await sleep(8000)
  const withoutTable = await evaluate(`document.querySelector('.usageCard')?.innerText?.replace(/\\n/g, ' | ') ?? null`)
  console.log(`  sidebar without the table: ${withoutTable}`)
  check('removing the table makes the same turn unpriced again', !withoutTable.includes('费用'), withoutTable)

  await api(`/api/sessions/${session.id}?purge=1`, { method: 'DELETE' })
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
