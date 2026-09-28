/**
 * Real Anthropic-compatible backend for tests that must exercise tool execution.
 *
 * Two responsibilities the pure-mock cannot cover:
 *   1. `HEAD /api/hello` — the CLI's startup probe (a relay without it breaks the CLI).
 *   2. A first turn that asks for a tool which genuinely requires approval, then a second turn
 *      that closes out after the tool result.
 *
 * WHY A FILE, NOT A COMMAND: the first version used a PowerShell command running a
 * non-existent cmdlet and inferred "did it run?" from the error text. That is unobservable —
 * a *denied* call and an *allowed* call that both fail look identical. Writing a marker file
 * gives an unambiguous, filesystem-level answer: the file exists only if the tool was
 * permitted to execute.
 *
 * `Write` is used rather than `Bash` because Windows' CLI has no `Bash` tool: asking for one
 * makes the call fail as "unknown tool" before any permission check, silently skipping the
 * very path under test.
 *
 * Usage: node permission-mock.mjs --port 59940
 */
import { createServer } from 'node:http'
import { existsSync, rmSync } from 'node:fs'

/** Marker file the probe writes; its existence is the proof of execution. */
export const MARKER_PATH = 'D:\\Claudecode-CN\\_probe\\permission-executed.marker'

/** Remove the marker so a previous run cannot be mistaken for this one. */
export function resetMarker() {
  rmSync(MARKER_PATH, { force: true })
}

/** True when the allowed tool call actually wrote the marker. */
export function markerExists() {
  return existsSync(MARKER_PATH)
}

export function createPermissionMock(options = {}) {
  const port = options.port ?? 59940
  const toolName = options.toolName ?? 'Write'
  const toolInput = options.toolInput ?? { file_path: MARKER_PATH, content: 'executed\n' }
  const log = options.quiet ? () => {} : (...args) => console.log('[perm-mock]', ...args)

  let turns = 0

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`)

    if (req.method === 'HEAD' && url.pathname === '/api/hello') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end()
      return
    }

    if (req.method === 'POST' && url.pathname === '/v1/messages') {
      const chunks = []
      req.on('data', (c) => chunks.push(c))
      req.on('end', () => {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
        const assistantTurns = (body.messages ?? []).filter((m) => m.role === 'assistant').length
        turns++

        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' })
        const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)

        send('message_start', {
          type: 'message_start',
          message: {
            id: 'msg_' + Date.now(),
            type: 'message',
            role: 'assistant',
            model: body.model,
            content: [],
            stop_reason: null,
            usage: { input_tokens: 500, output_tokens: 0 },
          },
        })

        if (assistantTurns === 0) {
          log(`turn ${turns}: asking for ${toolName}`)
          send('content_block_start', {
            type: 'content_block_start',
            index: 0,
            content_block: { type: 'tool_use', id: 'toolu_probe', name: toolName, input: {} },
          })
          send('content_block_delta', {
            type: 'content_block_delta',
            index: 0,
            delta: { type: 'input_json_delta', partial_json: JSON.stringify(toolInput) },
          })
          send('content_block_stop', { type: 'content_block_stop', index: 0 })
          send('message_delta', { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 30 } })
        } else {
          log(`turn ${turns}: marker exists = ${markerExists()}`)
          send('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: 'closing' } })
          send('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'closing' } })
          send('content_block_stop', { type: 'content_block_stop', index: 0 })
          send('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 10 } })
        }

        send('message_stop', { type: 'message_stop' })
        res.end()
      })
      return
    }

    res.writeHead(404, { 'Content-Type': 'application/json' })
    res.end('{"type":"error","error":{"type":"not_found_error","message":"perm-mock: unhandled path"}}')
  })

  return {
    server,
    get turns() {
      return turns
    },
    listen() {
      return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve(server.address().port)))
    },
    close() {
      return new Promise((resolve) => server.close(resolve))
    },
  }
}

const invokedDirectly = process.argv[1]?.endsWith('permission-mock.mjs')
if (invokedDirectly) {
  const index = process.argv.indexOf('--port')
  const instance = createPermissionMock({ port: index >= 0 ? Number(process.argv[index + 1]) : 59940 })
  await instance.listen()
  console.log(`permission mock listening on ${instance.server.address().port}`)
}
