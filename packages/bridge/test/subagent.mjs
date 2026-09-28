/**
 * Subagent + skill/catalog verification.
 *
 * Two layers, because one mock cannot honestly cover both:
 *
 *   A. LIVE — a real claude.exe against a mock backend that asks for the `Task` tool. Proves
 *      the tool call is surfaced with its subagent_type and that the initialize catalog is
 *      populated. A synthetic backend CANNOT produce genuine subagent frames: those are
 *      minted by the CLI's own agent loop, and hand-crafting the SSE envelope would only test
 *      the mock.
 *
 *   B. UNIT — `normalizeEvent` against synthetic stream frames that DO carry
 *      `parent_tool_use_id`, which is where the CLI puts lineage (on the frame envelope, a
 *      sibling of `message` — not inside it). This is the contract the UI nests on.
 *
 * Run: node packages/bridge/test/subagent.mjs
 */
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { normalizeEvent } from '../src/session.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const BRIDGE = join(here, '..', 'src', 'cli.mjs')
const CLAUDE = process.env.CCCN_CLAUDE_BINARY ?? 'D:\\Claudecode-CN\\_probe\\package\\claude.exe'

const results = []
function check(name, ok, detail = '') {
  results.push({ name, ok })
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${name}${detail ? '  — ' + detail : ''}`)
}

// ============================================================== B. lineage unit =====

console.log('=== B. lineage normalization (synthetic frames) ===')

const SID = 'session-test'

const subagentText = normalizeEvent(
  {
    type: 'assistant',
    parent_tool_use_id: 'toolu_task_1',
    message: { role: 'assistant', content: [{ type: 'text', text: 'inner reasoning' }] },
  },
  SID,
)
check('subagent text is normalized', subagentText?.kind === 'text')
check('subagent text carries parentToolUseId', subagentText?.parentToolUseId === 'toolu_task_1', subagentText?.parentToolUseId)

const topLevelText = normalizeEvent(
  {
    type: 'assistant',
    parent_tool_use_id: null,
    message: { role: 'assistant', content: [{ type: 'text', text: 'outer answer' }] },
  },
  SID,
)
check('top-level text has a null parentToolUseId', topLevelText?.parentToolUseId === null)

const subagentToolUse = normalizeEvent(
  {
    type: 'assistant',
    parent_tool_use_id: 'toolu_task_1',
    message: {
      role: 'assistant',
      content: [{ type: 'tool_use', id: 'toolu_inner', name: 'Read', input: { file_path: 'x' } }],
    },
  },
  SID,
)
check('nested tool_use keeps its lineage', subagentToolUse?.parentToolUseId === 'toolu_task_1' && subagentToolUse?.name === 'Read')

const subagentToolResult = normalizeEvent(
  {
    type: 'user',
    parent_tool_use_id: 'toolu_task_1',
    message: {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 'toolu_inner', content: 'file body' }],
    },
  },
  SID,
)
check('nested tool_result keeps its lineage', subagentToolResult?.parentToolUseId === 'toolu_task_1')

const subagentThinking = normalizeEvent(
  {
    type: 'assistant',
    parent_tool_use_id: 'toolu_task_1',
    message: { role: 'assistant', content: [{ type: 'thinking', thinking: 'weighing options' }] },
  },
  SID,
)
check('nested thinking keeps its lineage', subagentThinking?.parentToolUseId === 'toolu_task_1')

// ================================================================ A. live run =======

console.log('\n=== A. live Task tool call + catalog (real CLI) ===')

function sse(res, frames) {
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' })
  for (const [event, data] of frames) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
  res.end()
}

const startFrames = (model) => [
  [
    'message_start',
    {
      type: 'message_start',
      message: {
        id: 'msg_' + Date.now(),
        type: 'message',
        role: 'assistant',
        model,
        content: [],
        stop_reason: null,
        usage: { input_tokens: 100, output_tokens: 0 },
      },
    },
  ],
]

const endFrames = (stopReason, tokens) => [
  ['message_delta', { type: 'message_delta', delta: { stop_reason: stopReason }, usage: { output_tokens: tokens } }],
  ['message_stop', { type: 'message_stop' }],
]

function createBackend() {
  return createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    if (req.method === 'HEAD' && url.pathname === '/api/hello') {
      res.writeHead(200).end()
      return
    }
    if (req.method !== 'POST' || url.pathname !== '/v1/messages') {
      res.writeHead(404).end('{}')
      return
    }
    const chunks = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      const assistantTurns = (body.messages ?? []).filter((m) => m.role === 'assistant').length

      if (assistantTurns === 0) {
        sse(res, [
          ...startFrames(body.model),
          [
            'content_block_start',
            {
              type: 'content_block_start',
              index: 0,
              content_block: { type: 'tool_use', id: 'toolu_task_1', name: 'Task', input: {} },
            },
          ],
          [
            'content_block_delta',
            {
              type: 'content_block_delta',
              index: 0,
              delta: {
                type: 'input_json_delta',
                partial_json: JSON.stringify({
                  description: 'inspect the repo',
                  prompt: 'look around',
                  subagent_type: 'Explore',
                }),
              },
            },
          ],
          ['content_block_stop', { type: 'content_block_stop', index: 0 }],
          ...endFrames('tool_use', 30),
        ])
        return
      }

      sse(res, [
        ...startFrames(body.model),
        ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }],
        ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'done' } }],
        ['content_block_stop', { type: 'content_block_stop', index: 0 }],
        ...endFrames('end_turn', 10),
      ])
    })
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

async function readEvents(url, { until, timeoutMs = 90000 }) {
  const controller = new AbortController()
  const response = await fetch(url, { signal: controller.signal, headers: { accept: 'text/event-stream' } })
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  const events = []
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
        const dataLine = frame.split('\n').find((l) => l.startsWith('data: '))
        if (!dataLine) continue
        try {
          const event = JSON.parse(dataLine.slice(6))
          events.push(event)
          if (until(event, events)) return events
        } catch {
          /* skip */
        }
      }
    }
  } finally {
    controller.abort()
  }
  return events
}

if (!existsSync(CLAUDE)) {
  console.error(`claude.exe not found at ${CLAUDE}`)
  process.exit(2)
}

const backend = createBackend()
await new Promise((r) => backend.listen(0, '127.0.0.1', r))

const bridge = spawn(
  process.execPath,
  [BRIDGE, '--port', '0', '--claude', CLAUDE, '--base-url', `http://127.0.0.1:${backend.address().port}`, '--token', 'sk-mock'],
  { stdio: ['ignore', 'pipe', 'pipe'] },
)

try {
  const ready = await waitForReady(bridge)
  const base = `http://127.0.0.1:${ready.port}`

  const session = await (
    await fetch(`${base}/api/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ cwd: process.cwd() }),
    })
  ).json()

  // The initialize handshake fires at spawn, so the catalog fills without a turn.
  let catalog = null
  for (let i = 0; i < 30; i++) {
    catalog = await (await fetch(`${base}/api/sessions/${session.id}/catalog`)).json()
    if (catalog.ready) break
    await new Promise((r) => setTimeout(r, 500))
  }
  check('catalog becomes ready from the initialize reply', catalog?.ready === true)
  check('catalog lists skills/slash-commands', (catalog?.commands?.length ?? 0) > 0, `${catalog?.commands?.length ?? 0} commands`)
  check('catalog lists subagent types', (catalog?.agents?.length ?? 0) > 0, `${catalog?.agents?.length ?? 0} agents`)
  check('catalog lists models with effort capability', (catalog?.models ?? []).some((m) => m.supportsEffort))
  check('catalog reports the credential source', Boolean(catalog?.account?.tokenSource), catalog?.account?.tokenSource)
  check(
    'catalog entries carry descriptions',
    (catalog?.commands ?? []).every((c) => typeof c.description === 'string'),
  )

  await fetch(`${base}/api/sessions/${session.id}/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text: 'use the Task tool to explore the repo' }),
  })

  const events = await readEvents(`${base}/api/sessions/${session.id}/events`, {
    until: (event, list) =>
      event.kind === 'permission_request' || (list.length > 3 && (event.kind === 'result' || event.kind === 'tool_result')),
    timeoutMs: 90000,
  })

  const taskUse = events.find((event) => event.kind === 'tool_use' && event.name === 'Task')
  check('Task tool_use surfaced from the real CLI', taskUse !== undefined, taskUse?.id)
  if (taskUse) {
    check('Task carries its subagent_type', taskUse.input?.subagent_type === 'Explore', String(taskUse.input?.subagent_type))
    check('Task is top-level (no parent)', taskUse.parentToolUseId === null)
  }
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
