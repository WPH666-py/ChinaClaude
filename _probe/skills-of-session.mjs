/**
 * Print the skills a live session loaded, plus its last reply.
 *
 * Used to confirm that a bundled skill was actually discovered by the running app, not merely
 * staged on disk. PowerShell mangles inline scripts, hence a file.
 *
 * Run: node _probe/skills-of-session.mjs <port> <sessionId>
 */
const port = process.argv[2]
const sessionId = process.argv[3]
if (!port || !sessionId) {
  console.error('usage: node skills-of-session.mjs <port> <sessionId>')
  process.exit(2)
}

const response = await fetch(`http://127.0.0.1:${port}/api/sessions/${sessionId}/events`, {
  headers: { accept: 'text/event-stream' },
  signal: AbortSignal.timeout(3000),
}).catch(() => null)

if (!response?.body) {
  console.error('could not open the event stream')
  process.exit(1)
}

const reader = response.body.getReader()
const decoder = new TextDecoder()
let buffer = ''
try {
  for (;;) {
    const { value, done } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
  }
} catch {
  /* the timeout is the normal exit */
}

let sawInit = false
for (const frame of buffer.split('\n\n')) {
  const line = frame.split('\n').find((l) => l.startsWith('data: '))
  if (!line) continue
  let event
  try {
    event = JSON.parse(line.slice(6))
  } catch {
    continue
  }
  if (event.kind === 'init') {
    sawInit = true
    const skills = event.skills ?? []
    console.log(`SKILLS (${skills.length}):`)
    for (const skill of skills) {
      console.log(`  ${skill === 'modlens' ? '-> ' : '   '}${skill}`)
    }
  }
  if (event.kind === 'text') console.log(`REPLY: ${String(event.text).slice(0, 160)}`)
  if (event.kind === 'result') console.log(`RESULT: ${event.stopReason} tokens=${event.usage?.outputTokens}`)
}

if (!sawInit) console.log('no init frame in the replayed timeline (send a turn first)')
