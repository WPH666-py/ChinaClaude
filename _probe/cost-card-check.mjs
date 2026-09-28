/**
 * Verify the sidebar usage card shows the VENDOR, the basis only when it applies, and the balance.
 *
 * The user's complaint was concrete: "费用 ¥0.03" alone does not say whose money it was, and a
 * balance feature that never appears is indistinguishable from one that is broken. So this asserts
 * on the RENDERED text of the card, with a real provider seeded into settings.
 *
 * Run: node _probe/cost-card-check.mjs <bridgeUrl> <uiUrl> <apiKey>
 *
 * All three may also come from the environment (CCCN_BRIDGE_URL / CCCN_UI_URL / CCCN_KEY). That
 * route matters because the UI URL contains `&`, which PowerShell only passes through with `--%`,
 * and `--%` also disables variable expansion — so a command line cannot carry both a query string
 * and an expanded secret.
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
let failures = 0
const check = (name, ok, detail = '') => {
  if (!ok) failures++
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${name}${detail ? '  — ' + detail : ''}`)
}

const profile = mkdtempSync(join(tmpdir(), 'cccn-card-'))
const port = 9600 + Math.floor(Math.random() * 90)
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
  await sleep(12000)

  const card = await evaluate(`document.querySelector('.usageCard')?.innerText?.replace(/\\n/g, ' | ') ?? null`)
  console.log(`  usage card: ${card}`)

  check('the usage card renders', typeof card === 'string' && card.includes('本会话用量'))
  check('cost is shown', card.includes('费用'), card)
  check('the VENDOR/model is named next to the cost', /DeepSeek|Flash|V4/.test(card), card)
  check('the built-in DeepSeek rates are labelled with a time basis', /高峰时段价|空闲时段价/.test(card), card)
  check('a balance row appears', card.includes('账户余额'), card)
  check('the balance is a positive amount', /¥\s?\d/.test(card), card)
  check('the balance is NOT reported as an error', !card.includes('余额不可读'), card)

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
