/**
 * Verify that a bundled skill is actually DISCOVERED by the CLI, through the bridge.
 *
 * This is the whole question for shipping skills inside the installer: staging files is
 * meaningless if the session does not list the skill. `system/init` reports the loaded skills, so
 * the assertion is on that frame rather than on the filesystem.
 *
 * Run: node packages/bridge/test/bundled-skill.mjs
 */
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(here, '..', '..', '..')
const BRIDGE = join(here, '..', 'src', 'cli.mjs')
const CLAUDE = process.env.CCCN_CLAUDE_BINARY ?? 'D:\\Claudecode-CN\\_probe\\package\\claude.exe'
const SKILLS_ROOT = join(repoRoot, 'packages', 'desktop', 'src-tauri', 'resources', 'sidecar', 'skills')

const results = []
function check(name, ok, detail = '') {
  results.push({ name, ok })
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${name}${detail ? '  — ' + detail : ''}`)
}

function createBackend() {
  return createServer((req, res) => {
    if (req.method === 'HEAD') {
      res.writeHead(200).end()
      return
    }
    res.writeHead(200, { 'Content-Type': 'text/event-stream' })
    res.end(
      [
        'event: message_start',
        'data: {"type":"message_start","message":{"id":"m","type":"message","role":"assistant","model":"m","content":[],"stop_reason":null,"usage":{"input_tokens":1,"output_tokens":0}}}',
        '',
        'event: message_delta',
        'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":1}}',
        '',
        'event: message_stop',
        'data: {"type":"message_stop"}',
        '',
        '',
      ].join('\n'),
    )
  })
}

function waitForReady(child, timeoutMs = 40000) {
  return new Promise((resolve, reject) => {
    let buffer = ''
    const timer = setTimeout(() => reject(new Error('bridge not ready')), timeoutMs)
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk) => {
      buffer += chunk
      const match = buffer.match(/CCCN_READY (\{.*\})/)
      if (match) {
        clearTimeout(timer)
        resolve(JSON.parse(match[1]))
      }
    })
    child.on('exit', (code) => {
      clearTimeout(timer)
      reject(new Error(`bridge exited (${code})`))
    })
  })
}

/** Read the timeline until an `init` frame arrives, and return its skills list. */
async function readInitSkills(base, sessionId, timeoutMs = 60000) {
  const controller = new AbortController()
  const response = await fetch(`${base}/api/sessions/${sessionId}/events`, {
    signal: controller.signal,
    headers: { accept: 'text/event-stream' },
  })
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  const deadline = Date.now() + timeoutMs
  try {
    while (Date.now() < deadline) {
      const { value, done } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      let index
      while ((index = buffer.indexOf('\n\n')) >= 0) {
        const frame = buffer.slice(0, index)
        buffer = buffer.slice(index + 1)
        const line = frame.split('\n').find((l) => l.startsWith('data: '))
        if (!line) continue
        try {
          const event = JSON.parse(line.slice(6))
          if (event.kind === 'init') {
            controller.abort()
            return event.skills ?? []
          }
        } catch {
          /* skip */
        }
      }
    }
  } catch {
    /* abort is the normal exit */
  } finally {
    controller.abort()
  }
  return []
}

console.log(`skills root: ${SKILLS_ROOT}`)
check('skills root exists on disk', existsSync(SKILLS_ROOT))
check(
  'SKILL.md is at the path the CLI expects',
  existsSync(join(SKILLS_ROOT, '.claude', 'skills', 'modlens', 'SKILL.md')),
)

const backend = createBackend()
await new Promise((r) => backend.listen(0, '127.0.0.1', r))

const bridge = spawn(
  process.execPath,
  [BRIDGE, '--port', '0', '--claude', CLAUDE, '--base-url', `http://127.0.0.1:${backend.address().port}`, '--token', 'sk-mock'],
  {
    stdio: ['ignore', 'pipe', 'pipe'],
    // This is what the packaged app sets implicitly by living in the sidecar layout.
    env: { ...process.env, CCCN_SKILLS_ROOT: SKILLS_ROOT },
  },
)

try {
  const ready = await waitForReady(bridge)
  const base = `http://127.0.0.1:${ready.port}`

  const session = await (
    await fetch(`${base}/api/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      // A cwd that does NOT contain the skill: discovery must come from the --add-dir root.
      body: JSON.stringify({ cwd: process.cwd() }),
    })
  ).json()

  check('bridge mounted the skills root for the session', ready.binary === CLAUDE)

  // The CLI emits nothing until a turn is sent, so the init frame needs one.
  await fetch(`${base}/api/sessions/${session.id}/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text: 'hi' }),
  })

  const skills = await readInitSkills(base, session.id)
  console.log(`  loaded skills (${skills.length}): ${skills.join(', ')}`)

  check('init frame reported skills', skills.length > 0, `${skills.length}`)
  check('bundled modlens skill is discovered', skills.includes('modlens'), skills.includes('modlens') ? 'present' : 'ABSENT')
} finally {
  bridge.kill()
  backend.close()
}

const failed = results.filter((r) => !r.ok)
console.log(`\n=== ${results.length - failed.length}/${results.length} checks passed ===`)
if (failed.length > 0) {
  console.log('failures:')
  for (const f of failed) console.log('  - ' + f.name)
  process.exit(1)
}
process.exit(0)
