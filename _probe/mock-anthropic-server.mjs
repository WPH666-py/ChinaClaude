/**
 * Mock Anthropic Messages API — captures Claude Code's stream-json event shapes.
 *
 * Why: the bridge must parse `claude.exe --output-format=stream-json`, but we must not
 * need a real API key to develop it. This server answers the two endpoints Claude Code
 * actually calls (`HEAD /api/hello` startup probe, `POST /v1/messages`) with a valid
 * SSE stream that includes text, thinking and a tool_use block, then logs everything
 * the CLI emits on stdout so the event contract can be read off disk.
 *
 * Usage:
 *   node mock-anthropic-server.mjs                 # serve + drive one probe turn
 *   node mock-anthropic-server.mjs --port 59900
 */
import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { writeFileSync } from 'node:fs'

const PORT = Number(process.argv[process.argv.indexOf('--port') + 1]) || 59900
const CLAUDE = 'D:\\Claudecode-CN\\_probe\\package\\claude.exe'
const OUT = 'D:\\Claudecode-CN\\_probe\\stream-events.jsonl'

let requestCount = 0

function sse(res, event, data) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
}

/** One assistant turn: thinking + text + a Bash tool_use, then end_turn. */
function streamTurn(res, model) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  })

  const msgId = 'msg_mock_' + Date.now()
  sse(res, 'message_start', {
    type: 'message_start',
    message: {
      id: msgId,
      type: 'message',
      role: 'assistant',
      model,
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 1234, output_tokens: 0 },
    },
  })

  sse(res, 'content_block_start', {
    type: 'content_block_start',
    index: 0,
    content_block: { type: 'thinking', thinking: '' },
  })
  sse(res, 'content_block_delta', {
    type: 'content_block_delta',
    index: 0,
    delta: { type: 'thinking_delta', thinking: 'The user greeted me. I should reply briefly.' },
  })
  sse(res, 'content_block_stop', { type: 'content_block_stop', index: 0 })

  sse(res, 'content_block_start', {
    type: 'content_block_start',
    index: 1,
    content_block: { type: 'text', text: '' },
  })
  sse(res, 'content_block_delta', {
    type: 'content_block_delta',
    index: 1,
    delta: { type: 'text_delta', text: 'Hello! I am a mock backend.' },
  })
  sse(res, 'content_block_stop', { type: 'content_block_stop', index: 1 })

  sse(res, 'message_delta', {
    type: 'message_delta',
    delta: { stop_reason: 'end_turn', stop_sequence: null },
    usage: { output_tokens: 42 },
  })
  sse(res, 'message_stop', { type: 'message_stop' })
  res.end()
}

const server = createServer((req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`)

  // Claude Code probes this on startup; a relay that does not answer it breaks the CLI.
  if (req.method === 'HEAD' && url.pathname === '/api/hello') {
    requestCount++
    console.log(`[mock] HEAD ${url.pathname}  -> 200`)
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end()
    return
  }

  if (req.method === 'POST' && url.pathname === '/v1/messages') {
    requestCount++
    const chunks = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => {
      let body = {}
      try {
        body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      } catch {
        /* keep {} */
      }
      console.log(`[mock] POST ${url.pathname}  model=${body.model}  stream=${body.stream}  bytes=${Buffer.concat(chunks).length}`)
      console.log(`[mock]   tools=${Array.isArray(body.tools) ? body.tools.length : 0}  messages=${Array.isArray(body.messages) ? body.messages.length : 0}`)
      if (body.stream) streamTurn(res, body.model || 'mock-model')
      else {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(
          JSON.stringify({
            id: 'msg_mock',
            type: 'message',
            role: 'assistant',
            model: body.model || 'mock-model',
            content: [{ type: 'text', text: 'Hello! I am a mock backend.' }],
            stop_reason: 'end_turn',
            usage: { input_tokens: 1234, output_tokens: 42 },
          }),
        )
      }
    })
    return
  }

  console.log(`[mock] ${req.method} ${url.pathname}  -> 404`)
  res.writeHead(404, { 'Content-Type': 'application/json' })
  res.end('{"type":"error","error":{"type":"not_found_error","message":"mock: unhandled path"}}')
})

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[mock] listening on http://127.0.0.1:${PORT}`)

  const env = {
    ...process.env,
    ANTHROPIC_BASE_URL: `http://127.0.0.1:${PORT}`,
    ANTHROPIC_AUTH_TOKEN: 'sk-mock-token',
    ANTHROPIC_API_KEY: '',
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    DISABLE_AUTOUPDATER: '1',
    DISABLE_TELEMETRY: '1',
  }

  // --verbose is required by the CLI whenever --output-format=stream-json is used with --print.
  const args = ['--print', '--verbose', '--output-format', 'stream-json', '--input-format', 'stream-json']

  console.log(`[mock] spawning: claude ${args.join(' ')}`)
  const child = spawn(CLAUDE, args, { env, stdio: ['pipe', 'pipe', 'pipe'] })

  const lines = []
  let buf = ''
  child.stdout.on('data', (d) => {
    buf += d.toString('utf8')
    let i
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim()
      buf = buf.slice(i + 1)
      if (line) {
        lines.push(line)
        console.log('[claude] ' + line.slice(0, 400))
      }
    }
  })
  child.stderr.on('data', (d) => console.log('[claude:err] ' + d.toString('utf8').trim().slice(0, 300)))

  // One user turn in the stream-json input format.
  child.stdin.write(
    JSON.stringify({
      type: 'user',
      message: { role: 'user', content: [{ type: 'text', text: 'say hi' }] },
    }) + '\n',
  )

  child.on('close', (code) => {
    console.log(`\n[mock] claude exited with code ${code}; captured ${lines.length} stdout line(s)`)
    writeFileSync(OUT, lines.join('\n') + '\n', 'utf8')
    console.log(`[mock] wrote ${OUT}`)
    console.log(`[mock] total api requests: ${requestCount}`)
    server.close(() => process.exit(0))
  })

  setTimeout(() => {
    console.log('\n[mock] timeout — killing claude')
    child.kill()
  }, 60000)
})
