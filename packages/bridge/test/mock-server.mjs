/**
 * Standalone mock Anthropic Messages API (resident).
 *
 * Answers the two endpoints Claude Code calls against a custom base URL so the bridge and
 * UI can be developed and tested without a real key:
 *   HEAD /api/hello           startup probe — a relay that does not answer it breaks the CLI
 *   POST /v1/messages         SSE stream: thinking + text + optional tool_use
 *
 * Turn shape is chosen by keyword in the user text, so tests can request a tool call:
 *   "use a tool" / "tool" / "bash" / "run"  -> emits a tool_use and stops with tool_use
 *   anything else                           -> thinking + text, stops with end_turn
 *
 * The tool used is `Write`, deliberately: on Windows the CLI has no `Bash` tool, so asking
 * for one fails as "No such tool available" before the call reaches the permission layer —
 * which silently bypasses the very path approval tests need to exercise.
 *
 * Usage: node mock-server.mjs --port 59900 [--quiet]
 */
import { createServer } from 'node:http'

/** Scratch file the tool-use branch writes; harmless and inside the repo. */
const TOOL_TARGET = 'D:\\Claudecode-CN\\_probe\\mock-tool-ran.txt'

export function createMockAnthropic(options = {}) {
  const port = options.port ?? 59900
  const quiet = options.quiet ?? false
  const log = (...args) => {
    if (!quiet) console.log('[mock]', ...args)
  }

  let requests = 0

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`)

    if (req.method === 'HEAD' && url.pathname === '/api/hello') {
      requests++
      log('HEAD /api/hello -> 200')
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end()
      return
    }

    if (req.method === 'POST' && url.pathname === '/v1/messages') {
      requests++
      const chunks = []
      req.on('data', (c) => chunks.push(c))
      req.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8')
        let body = {}
        try {
          body = JSON.parse(raw)
        } catch {
          /* keep {} */
        }

        const lastUser = [...(body.messages ?? [])].reverse().find((m) => m.role === 'user')
        const text = typeof lastUser?.content === 'string'
          ? lastUser.content
          : (lastUser?.content ?? []).map((b) => b.text ?? '').join(' ')
        const wantsTool = /tool|bash|run/i.test(text.slice(0, 400))

        log(`POST /v1/messages model=${body.model} stream=${body.stream} bytes=${raw.length} tools=${body.tools?.length ?? 0} -> ${wantsTool ? 'tool_use' : 'end_turn'}`)

        if (!body.stream) {
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({
            id: 'msg_mock',
            type: 'message',
            role: 'assistant',
            model: body.model ?? 'mock-model',
            content: [{ type: 'text', text: 'Mock (non-streaming) reply.' }],
            stop_reason: 'end_turn',
            usage: { input_tokens: 100, output_tokens: 20 },
          }))
          return
        }

        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
        })
        const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)

        send('message_start', {
          type: 'message_start',
          message: {
            id: 'msg_mock_' + Date.now(),
            type: 'message',
            role: 'assistant',
            model: body.model ?? 'mock-model',
            content: [],
            stop_reason: null,
            stop_sequence: null,
            usage: { input_tokens: 1200, output_tokens: 0 },
          },
        })

        send('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } })
        send('content_block_delta', {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'thinking_delta', thinking: 'Considering the request before answering.' },
        })
        send('content_block_stop', { type: 'content_block_stop', index: 0 })

        if (wantsTool) {
          send('content_block_start', {
            type: 'content_block_start',
            index: 1,
            content_block: { type: 'tool_use', id: 'toolu_mock_1', name: 'Write', input: {} },
          })
          send('content_block_delta', {
            type: 'content_block_delta',
            index: 1,
            delta: {
              type: 'input_json_delta',
              partial_json: JSON.stringify({ file_path: TOOL_TARGET, content: 'mock tool ran\n' }),
            },
          })
          send('content_block_stop', { type: 'content_block_stop', index: 1 })
        } else {
          send('content_block_start', { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } })
          send('content_block_delta', {
            type: 'content_block_delta',
            index: 1,
            delta: { type: 'text_delta', text: 'Mock reply: the bridge, session and event stream are wired correctly.' },
          })
          send('content_block_stop', { type: 'content_block_stop', index: 1 })
        }

        send('message_delta', {
          type: 'message_delta',
          delta: { stop_reason: wantsTool ? 'tool_use' : 'end_turn', stop_sequence: null },
          usage: { output_tokens: 64 },
        })
        send('message_stop', { type: 'message_stop' })
        res.end()
      })
      return
    }

    log(`${req.method} ${url.pathname} -> 404`)
    res.writeHead(404, { 'Content-Type': 'application/json' })
    res.end('{"type":"error","error":{"type":"not_found_error","message":"mock: unhandled path"}}')
  })

  return {
    server,
    get requests() {
      return requests
    },
    listen() {
      return new Promise((resolve) => {
        server.listen(port, '127.0.0.1', () => {
          log(`listening on http://127.0.0.1:${port}`)
          resolve(port)
        })
      })
    },
    close() {
      return new Promise((resolve) => server.close(resolve))
    },
  }
}

const isMain = import.meta.url === `file://${process.argv[1]?.replace(/\\/g, '/')}`
if (isMain || process.argv[1]?.endsWith('mock-server.mjs')) {
  const portArg = process.argv.includes('--port') ? Number(process.argv[process.argv.indexOf('--port') + 1]) : 59900
  const instance = createMockAnthropic({ port: portArg, quiet: process.argv.includes('--quiet') })
  await instance.listen()
}
