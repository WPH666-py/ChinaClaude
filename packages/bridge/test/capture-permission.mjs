/**
 * Capture the CLI's permission control protocol.
 *
 * The first attempt failed to provoke a prompt because it asked for a `Bash` tool, which does
 * not exist on Windows (the tool list carries `PowerShell` instead) — the call was rejected as
 * an unknown tool before any permission check ran. This version asks for `Write`, which does
 * require approval under the default permission mode.
 *
 * `--permission-prompts` defaults to "host", so the CLI is supposed to ask the SDK host over
 * the stream-json control channel. This records exactly what it sends.
 *
 * Run: node packages/bridge/test/capture-permission.mjs
 */
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const OUT = join(here, 'permission-capture.jsonl')
const CLAUDE = process.env.CCCN_CLAUDE_BINARY ?? 'D:\\Claudecode-CN\\_probe\\package\\claude.exe'

/** Which tool the mock asks for; `Write` needs approval in the default mode. */
const TOOL_NAME = process.env.CCCN_PROBE_TOOL ?? 'Write'
const TOOL_INPUT =
  TOOL_NAME === 'Write'
    ? { file_path: 'D:\\Claudecode-CN\\_probe\\permission-probe.txt', content: 'permission probe\n' }
    : { command: 'Get-ChildItem -Name' }

function createMock(port) {
  return createServer((req, res) => {
    const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`)
    if (req.method === 'HEAD' && url.pathname === '/api/hello') {
      res.writeHead(200).end()
      return
    }
    if (req.method === 'POST' && url.pathname === '/v1/messages') {
      const chunks = []
      req.on('data', (c) => chunks.push(c))
      req.on('end', () => {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
        const assistantTurns = (body.messages ?? []).filter((m) => m.role === 'assistant').length
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
            usage: { input_tokens: 100, output_tokens: 0 },
          },
        })

        if (assistantTurns === 0) {
          send('content_block_start', {
            type: 'content_block_start',
            index: 0,
            content_block: { type: 'tool_use', id: 'toolu_perm_1', name: TOOL_NAME, input: {} },
          })
          send('content_block_delta', {
            type: 'content_block_delta',
            index: 0,
            delta: { type: 'input_json_delta', partial_json: JSON.stringify(TOOL_INPUT) },
          })
          send('content_block_stop', { type: 'content_block_stop', index: 0 })
          send('message_delta', { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 20 } })
        } else {
          send('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } })
          send('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Finished.' } })
          send('content_block_stop', { type: 'content_block_stop', index: 0 })
          send('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 10 } })
        }
        send('message_stop', { type: 'message_stop' })
        res.end()
      })
      return
    }
    res.writeHead(404).end('{}')
  })
}

const mock = createMock(0)
await new Promise((r) => mock.listen(0, '127.0.0.1', r))
const mockPort = mock.address().port
console.log(`mock backend on ${mockPort}; probing tool = ${TOOL_NAME}`)

const child = spawn(
  CLAUDE,
  ['--print', '--verbose', '--output-format', 'stream-json', '--input-format', 'stream-json',
   // This is the switch that turns on host-side permission prompts. Without it the CLI
   // auto-denies anything that would prompt (verified: no control_request is ever sent).
   '--permission-prompt-tool', 'stdio'],
  {
    env: {
      ...process.env,
      ANTHROPIC_BASE_URL: `http://127.0.0.1:${mockPort}`,
      ANTHROPIC_AUTH_TOKEN: 'sk-mock',
      ANTHROPIC_API_KEY: '',
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
      DISABLE_AUTOUPDATER: '1',
      CI: '1',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  },
)

const lines = []
let buffer = ''
child.stdout.setEncoding('utf8')
child.stdout.on('data', (chunk) => {
  buffer += chunk
  let index
  while ((index = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, index).trim()
    buffer = buffer.slice(index + 1)
    if (!line) continue
    lines.push(line)
    if (/"type"\s*:\s*"control_request"/.test(line)) {
      console.log('\n>>> CONTROL_REQUEST (this is the permission ask) <<<')
      console.log(JSON.stringify(JSON.parse(line), null, 2).slice(0, 2500))
    } else if (/"type"\s*:\s*"control_response"/.test(line)) {
      console.log('\n>>> CONTROL_RESPONSE <<<')
      console.log(line.slice(0, 800))
    } else {
      const short = line.length > 200 ? line.slice(0, 200) + '…' : line
      console.log('[out] ' + short)
    }
  }
})
child.stderr.setEncoding('utf8')
child.stderr.on('data', (d) => console.log('[err] ' + String(d).trim().slice(0, 200)))

child.stdin.write(
  JSON.stringify({
    type: 'user',
    message: { role: 'user', content: [{ type: 'text', text: `please use ${TOOL_NAME}` }] },
  }) + '\n',
)

await new Promise((r) => setTimeout(r, 25000))
child.kill()
mock.close()
writeFileSync(OUT, lines.join('\n') + '\n', 'utf8')

const controlRequests = lines.filter((line) => /"type"\s*:\s*"control_request"/.test(line))
console.log(`\ncaptured ${lines.length} stdout line(s) -> ${OUT}`)
console.log(`control_request lines: ${controlRequests.length}`)
for (const line of controlRequests) {
  console.log('\n=== permission request payload ===')
  console.log(JSON.stringify(JSON.parse(line), null, 2))
}
process.exit(0)
