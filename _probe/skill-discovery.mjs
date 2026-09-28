/**
 * Determine where Claude Code discovers Skills from.
 *
 * Bundling modlens is only possible if a skill placed by the installer is actually discovered.
 * The `system/init` frame lists the skills the session loaded, so asking the CLI directly is the
 * only honest way to know — the docs describe intent, this reports behaviour.
 *
 * Cases:
 *   A. cwd = a project containing .claude/skills/probe-skill
 *   B. --add-dir pointing at that project, cwd elsewhere
 *   C. a skill dir passed as an extra --add-dir
 *
 * Run: node _probe/skill-discovery.mjs
 */
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { buildChildArgs, buildChildEnv } from '../packages/bridge/src/session.mjs'

const CLAUDE = process.env.CCCN_CLAUDE_BINARY ?? 'D:\\Claudecode-CN\\_probe\\package\\claude.exe'
const PROJECT = 'D:\\Claudecode-CN\\_probe\\skilltest'

const backend = createServer((req, res) => {
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
  void req
})
await new Promise((r) => backend.listen(0, '127.0.0.1', r))
const port = backend.address().port

/** Run one turn and return the `system/init` frame's skills list. */
async function probeInit(label, { cwd, extraArgs = [] }) {
  const env = buildChildEnv({ baseUrl: `http://127.0.0.1:${port}`, authToken: 'sk' }, process.env)
  const args = buildChildArgs({ cwd: undefined }).concat(extraArgs)

  const child = spawn(CLAUDE, args, { env, cwd, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
  let buffer = ''
  let skills = null
  let initSeen = false

  child.stdout.setEncoding('utf8')
  child.stdout.on('data', (chunk) => {
    buffer += chunk
    let i
    while ((i = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, i).trim()
      buffer = buffer.slice(i + 1)
      if (!line) continue
      let raw
      try {
        raw = JSON.parse(line)
      } catch {
        continue
      }
      if (raw.type === 'system' && raw.subtype === 'init') {
        initSeen = true
        skills = raw.skills ?? []
      }
    }
  })

  child.stdin.write(
    JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'hi' }] } }) + '\n',
  )
  await new Promise((r) => setTimeout(r, 9000))
  child.kill()

  const found = (skills ?? []).includes('probe-skill')
  console.log(`${found ? 'FOUND   ' : 'missing '} ${label}`)
  console.log(`          init=${initSeen} skills=${(skills ?? []).length} probe=${found}`)
  return found
}

console.log('=== skill discovery probes ===')
console.log(`probe skill lives at: ${PROJECT}\\.claude\\skills\\probe-skill\\SKILL.md\n`)

const a = await probeInit('A. cwd = the project itself', { cwd: PROJECT })
const b = await probeInit('B. --add-dir <project>, cwd elsewhere', {
  cwd: 'D:\\Claudecode-CN',
  extraArgs: ['--add-dir', PROJECT],
})
const c = await probeInit('C. --add-dir <project>/.claude/skills', {
  cwd: 'D:\\Claudecode-CN',
  extraArgs: ['--add-dir', `${PROJECT}\\.claude\\skills`],
})

console.log(`\nverdict: cwd=${a} add-dir(project)=${b} add-dir(skills-dir)=${c}`)
backend.close()
process.exit(0)
