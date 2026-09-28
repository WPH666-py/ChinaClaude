/**
 * Show exactly what the CLI reports about a session's loaded components.
 *
 * Decides what a "plugin inventory" panel can honestly display: if `system/init` carries a
 * `plugins` array and an `mcp_servers` array, the panel can be built from real data rather than
 * from a hardcoded list that drifts.
 *
 * Run: node _probe/dump-init.mjs <port> <sessionId>
 */
const port = process.argv[2]
const sessionId = process.argv[3]
if (!port || !sessionId) {
  console.error('usage: node dump-init.mjs <port> <sessionId>')
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
  /* timeout */
}

for (const frame of buffer.split('\n\n')) {
  const line = frame.split('\n').find((l) => l.startsWith('data: '))
  if (!line) continue
  let event
  try {
    event = JSON.parse(line.slice(6))
  } catch {
    continue
  }
  if (event.kind !== 'init') continue

  console.log('init fields: ' + Object.keys(event).join(', '))
  console.log('')
  console.log('plugins      : ' + JSON.stringify(event.plugins, null, 2))
  console.log('mcpServers   : ' + JSON.stringify(event.mcpServers))
  console.log('claudeCode   : ' + event.claudeCodeVersion)
  console.log('model        : ' + event.model)
  console.log('permissionMode: ' + event.permissionMode)
  console.log('')
  console.log(`skills (${(event.skills ?? []).length}): ${(event.skills ?? []).join(', ')}`)
  console.log(`agents (${(event.agents ?? []).length}): ${(event.agents ?? []).join(', ')}`)
  console.log(`slashCommands (${(event.slashCommands ?? []).length})`)
  console.log(`capabilities: ${JSON.stringify(event.capabilities)}`)
}
