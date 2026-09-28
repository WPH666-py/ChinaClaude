/**
 * Watch the packaged app's first-run state from the moment its webview is reachable.
 *
 * Two things had been observed on launch with ZERO sessions and were not explained by reading the
 * code, which has no path that closes the setup form without a click or an existing session:
 *   - the setup form not being rendered, and
 *   - a session appearing that nobody asked for.
 *
 * Reading the source again would not settle it — the question is WHEN the state changes, and only a
 * timed poll answers that. A form missing on the FIRST sample means a code path during mount; one
 * that disappears at t+14s means an interaction.
 *
 * Read-only: it evaluates DOM queries and never clicks.
 *
 * Run: node _probe/first-run-watch.mjs <cdpPort> [seconds]
 *      node _probe/first-run-watch.mjs --launch <url> [seconds]     (owns a headless Edge)
 *
 * `--launch` exists so the browser comparison is self-contained: leaving the browser's lifetime to
 * a separate short-lived launcher kills it as soon as that launcher exits.
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const launchIndex = process.argv.indexOf('--launch')
const launchUrl = launchIndex >= 0 ? process.argv[launchIndex + 1] : null
const cdpPort = Number(launchUrl ? 9400 + Math.floor(Math.random() * 90) : (process.argv[2] ?? 9334))
const seconds = Number((launchUrl ? process.argv[launchIndex + 2] : process.argv[3]) ?? 45)

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

let browser = null
let profile = null
if (launchUrl) {
  const EDGE = [
    `${process.env.ProgramFiles}\\Microsoft\\Edge\\Application\\msedge.exe`,
    `${process.env['ProgramFiles(x86)']}\\Microsoft\\Edge\\Application\\msedge.exe`,
  ].find((candidate) => candidate && existsSync(candidate))
  if (!EDGE) {
    console.error('msedge.exe not found')
    process.exit(1)
  }
  profile = mkdtempSync(join(tmpdir(), 'cccn-watch-'))
  browser = spawn(
    EDGE,
    [
      '--headless=new',
      '--disable-gpu',
      '--no-first-run',
      '--no-default-browser-check',
      `--user-data-dir=${profile}`,
      `--remote-debugging-port=${cdpPort}`,
      '--window-size=1440,900',
      'about:blank',
    ],
    { stdio: 'ignore' },
  )
  console.log(`launched headless Edge, cdp ${cdpPort}`)
}

/** Discover the webview target, retrying while the app is still booting. */
async function findTarget(timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${cdpPort}/json/list`)).json()
      const page = list.find((entry) => entry.type === 'page')
      if (page) return page
    } catch {
      /* devtools not up yet */
    }
    await sleep(200)
  }
  throw new Error(`no webview target on ${cdpPort}`)
}

const page = await findTarget()
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

const started = Date.now()
console.log(`watching ${cdpPort} for ${seconds}s — no clicks, no API calls from here`)
console.log('   t     setup  settings  sidebar  centerFirst   vueReady  sessions(dom)')

if (launchUrl) {
  await send('Page.enable')
  await send('Page.navigate', { url: launchUrl })
}

let previous = null
while ((Date.now() - started) / 1000 < seconds) {
  let snapshot
  try {
    const result = await send('Runtime.evaluate', {
      expression: `JSON.stringify({
        setup: document.querySelectorAll('.setup').length,
        settings: document.querySelectorAll('.st__railItem').length,
        sidebar: document.body.innerText.includes('暂无会话') ? 'empty' : 'has-rows',
        center: document.querySelector('.centerCol')?.firstElementChild?.className ?? 'none',
        vue: !!document.querySelector('#app')?.__vue_app__,
        pills: document.querySelectorAll('.sessionItem').length
      })`,
      returnByValue: true,
    })
    snapshot = JSON.parse(result.result?.value ?? '{}')
  } catch (error) {
    snapshot = { error: String(error.message ?? error) }
  }

  const t = ((Date.now() - started) / 1000).toFixed(1)
  const line = `  ${t.padStart(5)}s   ${String(snapshot.setup).padEnd(5)}  ${String(snapshot.settings).padEnd(8)}  ${String(snapshot.sidebar).padEnd(7)}  ${String(snapshot.center).padEnd(12)}  ${String(snapshot.vue).padEnd(8)}  ${snapshot.pills}`

  // Only print on change, so a steady state is obviously steady.
  const comparable = JSON.stringify({ ...snapshot, error: undefined })
  if (comparable !== previous) {
    console.log(`${line}${previous === null ? '   <- first sample' : '   <- CHANGED'}`)
    previous = comparable
  }
  await sleep(500)
}

console.log('watch ended')
socket.close()
if (browser) {
  browser.kill()
  await sleep(300)
  try {
    rmSync(profile, { recursive: true, force: true })
  } catch {
    /* best effort */
  }
}