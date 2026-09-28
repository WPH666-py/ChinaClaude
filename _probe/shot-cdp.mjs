/**
 * Screenshot a URL over the Chrome DevTools Protocol.
 *
 * WHY NOT `--screenshot --virtual-time-budget`: that flag waits for the page to go idle under
 * virtual time, and this app holds an OPEN SSE STREAM for the whole time a session is attached. The
 * page therefore never goes idle and Edge hangs until it is killed — which is exactly what happened
 * when the first attempt to capture the sidebar cost card timed out with no PNG written.
 *
 * CDP has no such assumption: navigate, wait a fixed wall-clock delay, then capture. An open stream
 * is irrelevant.
 *
 * Run: node _probe/shot-cdp.mjs <url> <out.png> [waitMs] [width] [height]
 *
 * Set CCCN_EVAL to a JavaScript expression to print a value from the page instead of only
 * screenshotting it. Screenshots show what a page LOOKS like; when the answer is "did this code
 * path even run", reading state out of the page is the only way to avoid guessing. The expression
 * is evaluated after the wait, and the screenshot is still taken.
 */
import { spawn } from 'node:child_process'
import { writeFileSync, mkdtempSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const [, , url, out, waitMsArg, widthArg, heightArg] = process.argv
if (!url || !out) {
  console.error('usage: node _probe/shot-cdp.mjs <url> <out.png> [waitMs] [width] [height]')
  process.exit(2)
}
const waitMs = Number(waitMsArg ?? 6000)
const width = Number(widthArg ?? 1440)
const height = Number(heightArg ?? 900)

const EDGE = [
  `${process.env.ProgramFiles}\\Microsoft\\Edge\\Application\\msedge.exe`,
  `${process.env['ProgramFiles(x86)']}\\Microsoft\\Edge\\Application\\msedge.exe`,
].find((candidate) => candidate && existsSync(candidate))

if (!EDGE) {
  console.error('msedge.exe not found')
  process.exit(1)
}

const profile = mkdtempSync(join(tmpdir(), 'cccn-cdp-'))
const port = 9500 + Math.floor(Math.random() * 400)

const browser = spawn(
  EDGE,
  [
    '--headless=new',
    '--disable-gpu',
    '--hide-scrollbars',
    '--no-first-run',
    '--no-default-browser-check',
    `--user-data-dir=${profile}`,
    `--remote-debugging-port=${port}`,
    `--window-size=${width},${height}`,
    'about:blank',
  ],
  { stdio: ['ignore', 'ignore', 'pipe'] },
)

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** Poll the DevTools HTTP endpoint until the browser is listening. */
async function waitForDevTools(timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/version`)
      if (response.ok) return await response.json()
    } catch {
      /* not up yet */
    }
    await sleep(150)
  }
  throw new Error('devtools endpoint never came up')
}

/** A page target plus a minimal CDP session over the built-in WebSocket client. */
async function openPage() {
  const response = await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT' })
  const target = await response.json()
  const socket = new WebSocket(target.webSocketDebuggerUrl)
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true })
    socket.addEventListener('error', () => reject(new Error('cdp socket failed')), { once: true })
  })

  let nextId = 1
  const pending = new Map()
  socket.addEventListener('message', (event) => {
    let message
    try {
      message = JSON.parse(event.data)
    } catch {
      return
    }
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

  return { send, close: () => socket.close() }
}

let exitCode = 0
try {
  await waitForDevTools()
  const page = await openPage()

  await page.send('Page.enable')
  await page.send('Emulation.setDeviceMetricsOverride', {
    width,
    height,
    deviceScaleFactor: 1,
    mobile: false,
  })
  await page.send('Page.navigate', { url })

  /**
   * Optional `CCCN_SEED`: JavaScript to run on the loaded origin BEFORE the final capture, followed
   * by a reload.
   *
   * Needed because each run gets a throwaway profile, so `localStorage` set by one invocation is gone
   * by the next. Anything that depends on stored settings — a configured provider, a custom price
   * table — otherwise screenshots as the unconfigured state, which is exactly what happened when the
   * model/provider line was first captured.
   */
  const seed = process.env.CCCN_SEED
  if (seed) {
    await sleep(2500)
    const seeded = await page.send('Runtime.evaluate', { expression: seed, returnByValue: true, awaitPromise: true })
    if (seeded.exceptionDetails) {
      console.error(`seed threw: ${seeded.exceptionDetails.text ?? ''}`)
      exitCode = 1
    } else {
      console.log(`seeded: ${JSON.stringify(seeded.result?.value ?? null)}`)
      await page.send('Page.reload', { ignoreCache: false })
      await sleep(waitMs)
    }
  }

  // Wall-clock wait. The app streams SSE forever, so "wait for network idle" would never return.
  await sleep(seed ? 3000 : waitMs)

  const expression = process.env.CCCN_EVAL
  if (expression) {
    const evaluated = await page.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
    })
    if (evaluated.exceptionDetails) {
      console.log(`EVAL threw: ${evaluated.exceptionDetails.text ?? ''} ${evaluated.result?.description ?? ''}`)
    } else {
      console.log(`EVAL => ${JSON.stringify(evaluated.result?.value ?? null)}`)
    }
  }

  const shot = await page.send('Page.captureScreenshot', { format: 'png' })
  writeFileSync(out, Buffer.from(shot.data, 'base64'))
  console.log(`wrote ${out}`)
  page.close()
} catch (error) {
  console.error(`screenshot failed: ${String(error.message ?? error)}`)
  exitCode = 1
} finally {
  browser.kill()
  // Edge keeps file handles briefly; a failed cleanup must not fail the capture.
  await sleep(300)
  try {
    rmSync(profile, { recursive: true, force: true })
  } catch {
    /* best effort */
  }
}

process.exit(exitCode)
