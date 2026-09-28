/**
 * Reproduce the reported "added a model but it is still not there".
 *
 * Reported state: a provider named `qwen3.8-flash` showing "尚未添加模型", while the model picker
 * offered only `deepseek-flash`. Two very different causes are possible and reading the source does
 * not separate them, so this drives the real form:
 *
 *   A. the field binding loses what was typed (a genuine bug), or
 *   B. the click landed with an EMPTY field and `commitModel` returned silently — which is also a
 *      defect, just a different one, because a click that does nothing and says nothing is
 *      indistinguishable from a broken app.
 *
 * Both are checked, plus whether the model survives a reload (the user said "添加模型到本机",
 * i.e. they expected it remembered on this machine).
 *
 * Run: CCCN_BRIDGE_URL=... CCCN_UI_URL=... node _probe/add-model-check.mjs
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const bridgeUrl = process.argv[2] ?? process.env.CCCN_BRIDGE_URL ?? 'http://127.0.0.1:43210'
const uiUrl = process.argv[3] ?? process.env.CCCN_UI_URL ?? 'http://127.0.0.1:5205'

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

const profile = mkdtempSync(join(tmpdir(), 'cccn-addmodel-'))
const port = 9800 + Math.floor(Math.random() * 60)
const browser = spawn(
  EDGE,
  [
    '--headless=new',
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    `--user-data-dir=${profile}`,
    `--remote-debugging-port=${port}`,
    '--window-size=1440,1000',
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

  // Seed a provider that has NO models, exactly like the reported `qwen3.8-flash`.
  const settings = JSON.stringify({
    language: 'zh-CN',
    appearance: 'dark',
    sendOnEnter: true,
    permissionPreset: 'ask',
    defaultModelRef: '',
    priceTables: [],
    providers: [
      {
        id: 'qwen',
        name: 'qwen3.8-flash',
        baseUrl: 'https://dashscope.aliyuncs.com/apps/anthropic',
        apiKey: 'sk-test-key',
        persistKey: true,
        isDefault: false,
        models: [],
      },
    ],
  })

  await send('Page.enable')
  await send('Page.navigate', { url: uiUrl })
  await sleep(2500)
  await evaluate(`localStorage.setItem('cccn.settings.v3', ${JSON.stringify(settings)})`)
  await send('Page.navigate', { url: `${uiUrl}${uiUrl.includes('?') ? '&' : '?'}settings=models` })
  await sleep(6000)

  const before = await evaluate(`JSON.stringify({
    providers: document.querySelectorAll('.st__modelRow').length,
    saysNoModels: document.body.innerText.includes('尚未添加模型'),
    inputs: [...document.querySelectorAll('input')].map(i => i.placeholder).filter(Boolean)
  })`)
  console.log(`  before: ${before}`)
  check('the model-less provider is shown as such', JSON.parse(before).saysNoModels === true)

  // ---- A. type a real name, then click 添加模型 ------------------------------
  const typed = await evaluate(`(() => {
    const input = [...document.querySelectorAll('input')].find(i => (i.placeholder || '').includes('模型名'))
    if (!input) return 'no model input'
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
    setter.call(input, 'qwen3.8-flash')
    input.dispatchEvent(new Event('input', { bubbles: true }))
    return input.value
  })()`)
  check('the model field accepts typed text', typed === 'qwen3.8-flash', String(typed))

  // Re-read after a tick: a binding that loses its value shows up here.
  await sleep(500)
  const stillTyped = await evaluate(`(() => {
    const input = [...document.querySelectorAll('input')].find(i => (i.placeholder || '').includes('模型名'))
    return input ? input.value : 'gone'
  })()`)
  check('THE TYPED TEXT SURVIVES A RENDER', stillTyped === 'qwen3.8-flash', String(stillTyped))

  await evaluate(`(() => {
    const button = [...document.querySelectorAll('button')].find(b => b.innerText.trim() === '添加模型')
    if (!button) return 'no button'
    button.click()
    return 'clicked'
  })()`)
  await sleep(1200)

  const afterAdd = await evaluate(`JSON.stringify({
    rows: document.querySelectorAll('.st__modelRow').length,
    stillSaysNoModels: document.body.innerText.includes('尚未添加模型'),
    stored: JSON.parse(localStorage.getItem('cccn.settings.v3') || '{}').providers?.[0]?.models ?? null
  })`)
  console.log(`  after add: ${afterAdd}`)
  const added = JSON.parse(afterAdd)
  check('clicking 添加模型 ADDS the model to the list', added.rows === 1, `${added.rows} row(s)`)
  check('the "no models" message is gone', added.stillSaysNoModels === false)
  check(
    'the model is written to storage immediately',
    Array.isArray(added.stored) && added.stored.some((m) => m.model === 'qwen3.8-flash'),
    JSON.stringify(added.stored),
  )

  // ---- persistence across a reload -----------------------------------------
  await send('Page.reload', {})
  await sleep(4000)
  const afterReload = await evaluate(`JSON.stringify({
    rows: document.querySelectorAll('.st__modelRow').length,
    text: document.body.innerText.includes('qwen3.8-flash')
  })`)
  console.log(`  after reload: ${afterReload}`)
  check('the model is still there after a reload ("到本机")', JSON.parse(afterReload).rows === 1, afterReload)

  // ---- B. click with an EMPTY field ----------------------------------------
  await evaluate(`(() => {
    const input = [...document.querySelectorAll('input')].find(i => (i.placeholder || '').includes('模型名'))
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
    setter.call(input, '')
    input.dispatchEvent(new Event('input', { bubbles: true }))
    return 'cleared'
  })()`)
  await sleep(300)
  const beforeEmptyClick = await evaluate(`document.querySelectorAll('.st__modelRow').length`)
  await evaluate(`(() => {
    const button = [...document.querySelectorAll('button')].find(b => b.innerText.trim() === '添加模型')
    button.click()
    return 'clicked'
  })()`)
  await sleep(1000)
  const afterEmptyClick = await evaluate(`JSON.stringify({
    rows: document.querySelectorAll('.st__modelRow').length,
    errorText: document.querySelector('.st__hint--error')?.innerText ?? null,
    errorColour: (() => { const el = document.querySelector('.st__hint--error'); return el ? getComputedStyle(el).color : null })()
  })`)
  console.log(`  empty click: ${afterEmptyClick}`)
  const emptyResult = JSON.parse(afterEmptyClick)
  check('an empty click adds nothing', emptyResult.rows === beforeEmptyClick, `${beforeEmptyClick} -> ${emptyResult.rows}`)
  check(
    'AN EMPTY CLICK SAYS SOMETHING (silent no-op is the defect)',
    typeof emptyResult.errorText === 'string' && emptyResult.errorText.length > 0,
    'clicking 添加模型 with an empty field produced no feedback at all',
  )
  check(
    'the message explains the provider-name mix-up',
    String(emptyResult.errorText ?? '').includes('服务商名称'),
    String(emptyResult.errorText),
  )
  // A rejected action must not read as another grey caption line.
  check(
    'the message is rendered as an error, not a hint',
    String(emptyResult.errorColour ?? '').startsWith('rgb(') && emptyResult.errorColour !== 'rgb(173, 178, 184)',
    String(emptyResult.errorColour),
  )

  // Typing must clear it, or the message would linger after the user fixed it.
  await evaluate(`(() => {
    const input = [...document.querySelectorAll('input')].find(i => (i.placeholder || '').includes('模型名'))
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
    setter.call(input, 'x')
    input.dispatchEvent(new Event('input', { bubbles: true }))
    return 'typed'
  })()`)
  await sleep(400)
  const cleared = await evaluate(`!document.querySelector('.st__hint--error')`)
  check('typing clears the message', cleared === true, String(cleared))

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
