/**
 * End-to-end check for the attach button.
 *
 * The button was a disabled placeholder before, so "it renders" proves nothing. This drives the real
 * `<input type="file">` through CDP (`DOM.setFileInputFiles`, which is how a genuine OS file choice
 * reaches the page), then asserts the OUTCOME the user cares about:
 *
 *   1. an absolute path appears in the composer, because Claude Code reads files by path;
 *   2. that path really exists on disk with the right bytes — the whole point of routing the upload
 *      through the bridge is that a webview cannot write files;
 *   3. the path is NOT the client-side filename, since a browser never had a real path to give.
 *
 * Run: node _probe/attach-check.mjs <bridgeUrl> <uiUrl>
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const bridgeUrl = process.argv[2] ?? process.env.CCCN_BRIDGE_URL ?? 'http://127.0.0.1:43200'
const uiUrl = process.argv[3] ?? process.env.CCCN_UI_URL ?? 'http://127.0.0.1:5200'

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

// A real file on disk to hand to the picker.
const scratch = mkdtempSync(join(tmpdir(), 'cccn-attachsrc-'))
const sourceFile = join(scratch, 'diagram.png')
const CONTENT = 'i am a picture, honestly'
writeFileSync(sourceFile, CONTENT)

// A session must exist for the composer to render.
for (const session of (await api('/api/sessions')).sessions ?? []) {
  await api(`/api/sessions/${session.id}?purge=1`, { method: 'DELETE' })
}
const session = await api('/api/sessions', {
  method: 'POST',
  body: JSON.stringify({ cwd: process.cwd(), model: 'claude-sonnet-5' }),
})
console.log(`session ${session.id}`)

const profile = mkdtempSync(join(tmpdir(), 'cccn-attachui-'))
const port = 9700 + Math.floor(Math.random() * 80)
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
  let ready = false
  while (Date.now() < deadline && !ready) {
    try {
      ready = (await fetch(`http://127.0.0.1:${port}/json/version`)).ok
    } catch {
      /* not up */
    }
    if (!ready) await sleep(150)
  }
  if (!ready) throw new Error('devtools never came up')

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
  await send('DOM.enable')
  await send('Page.navigate', { url: `${uiUrl}${uiUrl.includes('?') ? '&' : '?'}session=newest` })
  await sleep(9000)

  const before = await evaluate(`JSON.stringify({
    attach: !!document.querySelector('.composer__add'),
    disabled: document.querySelector('.composer__add')?.disabled ?? null,
    title: document.querySelector('.composer__add')?.title ?? null,
    fileInput: !!document.querySelector('.composer__file')
  })`)
  console.log(`  before: ${before}`)
  const parsed = JSON.parse(before)
  check('the attach control exists', parsed.attach === true)
  check('the attach control is ENABLED (it used to be a disabled placeholder)', parsed.disabled === false, String(parsed.disabled))
  check('the hidden file input exists', parsed.fileInput === true)

  // Hand the real file to the input, the same way the OS picker would.
  const doc = await send('DOM.getDocument', { depth: -1 })
  const node = await send('DOM.querySelector', { nodeId: doc.root.nodeId, selector: '.composer__file' })
  check('the file input is reachable in the DOM', node.nodeId > 0, String(node.nodeId))
  await send('DOM.setFileInputFiles', { files: [sourceFile], nodeId: node.nodeId })

  await sleep(4000)
  const draft = await evaluate(`document.querySelector('textarea')?.value ?? null`)
  console.log(`  composer draft: ${JSON.stringify(draft)}`)

  check('the composer received a path', typeof draft === 'string' && draft.trim().length > 0, String(draft))
  check('the inserted text is an absolute path', /^[A-Za-z]:\\/.test(String(draft).trim()), String(draft))
  check('the path is not the browser-side filename', !String(draft).includes('diagram.png'), String(draft))
  check('the extension was preserved', String(draft).trim().endsWith('.png'), String(draft))

  const storedPath = String(draft).trim().split('\n').pop() ?? ''
  check('the stored file exists on disk', existsSync(storedPath), storedPath)
  if (existsSync(storedPath)) {
    check('the bytes round-tripped exactly', readFileSync(storedPath, 'utf8') === CONTENT, readFileSync(storedPath, 'utf8'))
  }
  check('no attach error is shown', !(await evaluate(`document.body.innerText.includes('附件保存失败')`)))

  // The bridge should now report the attachment it holds.
  const usage = await api('/api/attachments')
  check('the bridge reports the stored attachment', usage.files >= 1, `${usage.files} file(s), ${usage.bytes} bytes`)

  // Clean up what the app wrote, through the app's own endpoint.
  await api('/api/attachments', { method: 'DELETE' })
  await api(`/api/sessions/${session.id}?purge=1`, { method: 'DELETE' })
  socket.close()
} catch (error) {
  console.error(`check failed: ${String(error.message ?? error)}`)
  failures++
} finally {
  browser.kill()
  await sleep(300)
  rmSync(profile, { recursive: true, force: true })
  rmSync(scratch, { recursive: true, force: true })
}

console.log(`\n${failures === 0 ? 'all checks passed' : failures + ' check(s) failed'}`)
process.exit(failures === 0 ? 0 : 1)
