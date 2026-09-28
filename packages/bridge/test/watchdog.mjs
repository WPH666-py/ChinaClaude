/**
 * Verify the bridge's parent watchdog.
 *
 * A force-killed Tauri shell cannot run its Drop handler, so the bridge must notice on its
 * own. This test spawns the bridge as a child, hard-kills the PARENT (this script), and
 * then checks from a detached observer whether the bridge exited.
 *
 * A truly detached observer is needed because the parent is the thing being killed. So the
 * observer runs as a separate process, watches the bridge pid, and writes a verdict file.
 *
 * Run: node packages/bridge/test/watchdog.mjs
 */
import { spawn } from 'node:child_process'
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const NODE = 'D:\\Claudecode-CN\\packages\\desktop\\src-tauri\\resources\\sidecar\\node.exe'
const BRIDGE = 'D:\\Claudecode-CN\\packages\\desktop\\src-tauri\\resources\\sidecar\\bridge\\cli.mjs'
const VERDICT = join(here, 'watchdog-verdict.json')

rmSync(VERDICT, { force: true })

if (process.argv.includes('--observe')) {
  // Second stage: runs detached; watches whether the bridge is still alive.
  const bridgePid = Number(process.argv[process.argv.indexOf('--observe') + 1])
  const alive = (pid) => {
    try {
      process.kill(pid, 0)
      return true
    } catch (error) {
      return error?.code === 'EPERM'
    }
  }

  const deadline = Date.now() + 20000
  let exited = false
  let waitedMs = 0
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 500))
    waitedMs += 500
    if (!alive(bridgePid)) {
      exited = true
      break
    }
  }
  writeFileSync(VERDICT, JSON.stringify({ bridgePid, exited, waitedMs }, null, 2), 'utf8')
  process.exit(0)
}

// Stage one: start the bridge, start a detached observer, then die hard.
const bridge = spawn(NODE, [BRIDGE, '--port', '0'], { stdio: ['ignore', 'pipe', 'pipe'] })

let ready = false
bridge.stdout.setEncoding('utf8')
bridge.stdout.on('data', (chunk) => {
  if (String(chunk).includes('CCCN_READY')) ready = true
})

await new Promise((r) => setTimeout(r, 2500))
if (!ready) {
  console.error('bridge did not report ready; cannot test the watchdog')
  bridge.kill()
  process.exit(2)
}
console.log(`bridge started, pid ${bridge.pid}`)

// Detached so it survives us being killed.
const observer = spawn(process.execPath, [fileURLToPath(import.meta.url), '--observe', String(bridge.pid)], {
  detached: true,
  stdio: 'ignore',
})
observer.unref()

console.log('observer detached; killing this parent process hard…')
// SIGKILL-equivalent: no chance to run cleanup handlers.
process.kill(process.pid, 'SIGKILL')
