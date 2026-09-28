/**
 * Print the event timeline of a running bridge session, one line per event.
 *
 * Used for UI verification: it shows exactly what the interface will render, including which
 * events carry subagent lineage.
 *
 * Run: node _probe/dump-events.mjs <port> <sessionId>
 */
const port = process.argv[2] ?? '59970'
const sessionId = process.argv[3]
if (!sessionId) {
  console.error('usage: node dump-events.mjs <port> <sessionId>')
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
const events = []
try {
  for (;;) {
    const { value, done } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
  }
} catch {
  /* the timeout is the normal exit */
}

for (const frame of buffer.split('\n\n')) {
  const dataLine = frame.split('\n').find((line) => line.startsWith('data: '))
  if (!dataLine) continue
  try {
    events.push(JSON.parse(dataLine.slice(6)))
  } catch {
    /* skip */
  }
}

console.log(`events: ${events.length}`)
for (const event of events) {
  const lineage = event.parentToolUseId ? `  [sub of ${String(event.parentToolUseId).slice(0, 12)}]` : ''
  const detail =
    event.name ??
    event.dialogKind ??
    (event.text ? String(event.text).slice(0, 40) : '') ??
    ''
  console.log(`  seq=${String(event.seq).padStart(3)}  ${event.kind.padEnd(20)} ${String(detail).slice(0, 50)}${lineage}`)
}
