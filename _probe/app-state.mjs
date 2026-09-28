/**
 * Read (and optionally drive) the PACKAGED app's own WebView2 over CDP.
 *
 * WHY THIS EXISTS: screenshotting the native window is indirect and, worse, unreliable — a MINIMIZED
 * or occluded WebView2 has its timers throttled by Chromium, so the app's 2.5 s session poll can
 * effectively stop and the app looks broken when the real cause is that nothing is being rendered.
 * That ambiguity is exactly what made it unclear whether the first-run setup form failed to adopt an
 * externally created session. Attaching to the webview answers "what state is the app in" directly,
 * in the app that actually ships, rather than in a browser approximation of it.
 *
 * `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=<port>` must be set when the app is
 * launched; Chromium flags cannot be passed to WebView2 any other way.
 *
 * Run: node _probe/app-state.mjs "<expression>" [port]
 *      node _probe/app-state.mjs --shot <out.png> [port]
 *
 * `--shot` captures the webview's own rendering instead of the native window. That sidesteps the
 * DPI and occlusion problems the window-capture script has to work around, and it is the app's
 * actual composed output rather than a compositor grab of it.
 *
 * The expression may also be supplied as CCCN_EVAL and the port as CCCN_CDP_PORT. That route exists
 * because a shell will happily split an expression containing quotes and backticks into several
 * argv entries, which silently drops the positional port back to its default.
 */
import { writeFileSync } from 'node:fs'

const shotIndex = process.argv.indexOf('--shot')
const shotPath = shotIndex >= 0 ? process.argv[shotIndex + 1] : null
const expression = shotPath ? null : (process.argv[2] ?? process.env.CCCN_EVAL)
const port = Number((shotPath ? process.argv[shotIndex + 2] : process.argv[3]) ?? process.env.CCCN_CDP_PORT ?? 9333)
if (!expression && !shotPath) {
  console.error('usage: node _probe/app-state.mjs "<javascript expression>" [port]')
  console.error('       node _probe/app-state.mjs --shot <out.png> [port]')
  console.error('       CCCN_EVAL="<expr>" CCCN_CDP_PORT=<port> node _probe/app-state.mjs')
  process.exit(2)
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
const page = targets.find((target) => target.type === 'page')
if (!page) {
  console.error('no page target — is the app running with remote debugging enabled?')
  process.exit(1)
}

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

try {
  if (shotPath) {
    const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })
    writeFileSync(shotPath, Buffer.from(shot.data, 'base64'))
    console.log(`wrote ${shotPath}`)
  } else {
    const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
    if (result.exceptionDetails) {
      console.error(`threw: ${result.exceptionDetails.text ?? ''} ${result.result?.description ?? ''}`)
      process.exitCode = 1
    } else {
      console.log(JSON.stringify(result.result?.value ?? null))
    }
  }
} finally {
  await sleep(50)
  socket.close()
}
