/**
 * Verify the transcript import surface against a synthetic transcript tree.
 *
 * A synthetic tree rather than the user's real `~/.claude/projects`, because the assertions have to
 * be about KNOWN content: a real corpus changes under the test and would make "found 3 sessions"
 * meaningless.
 *
 * The three claims worth testing are the ones that would silently mislead a user:
 *
 *   1. NON-CONVERSATION RECORDS ARE NOT COUNTED AS TURNS. A real transcript is mostly `attachment`,
 *      `queue-operation` and `atis-latch` records; counting them would report a 2-turn conversation
 *      as 30 turns.
 *   2. SIDECHAIN (SUBAGENT) TRAFFIC IS EXCLUDED from the count. It is real traffic, but including
 *      it would describe a conversation as longer than the user experienced.
 *   3. A TOOL RESULT IS NOT A TITLE. Tool results arrive as `user` records, so a naive "first user
 *      record" would title a conversation `[tool result]`.
 *
 * Run: node packages/bridge/test/transcripts.mjs
 */
import { spawn } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { finish } from './harness.mjs'
import { encodeProjectDir } from '../src/transcripts.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const BRIDGE = join(here, '..', 'src', 'cli.mjs')
const CLAUDE = process.env.CCCN_CLAUDE_BINARY ?? 'D:\\Claudecode-CN\\_probe\\package\\claude.exe'

const results = []
function check(name, ok, detail = '') {
  results.push({ name, ok })
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${name}${detail ? '  — ' + detail : ''}`)
}

// ---- build a synthetic transcript tree --------------------------------------
const scratch = mkdtempSync(join(tmpdir(), 'cccn-transcripts-'))
const projectsRoot = join(scratch, 'projects')
const cwdA = 'D:\\Claudecode-CN'
const cwdB = '/home/dev/demo'
const projectA = join(projectsRoot, encodeProjectDir(cwdA))
const projectB = join(projectsRoot, encodeProjectDir(cwdB))
mkdirSync(projectA, { recursive: true })
mkdirSync(projectB, { recursive: true })

const SESSION_A = 'aaaaaaaa-1111-2222-3333-444444444444'
const SESSION_B = 'bbbbbbbb-1111-2222-3333-444444444444'
const SESSION_C = 'cccccccc-1111-2222-3333-444444444444'

const record = (extra) => JSON.stringify({ sessionId: SESSION_A, cwd: cwdA, version: '2.1.282', gitBranch: 'main', ...extra })

// Session A: a real conversation with noise, a sidechain turn, and a tool result before any prompt.
const sessionALines = [
  record({ type: 'queue-operation', operation: 'enqueue', timestamp: '2026-09-27T04:00:00.000Z' }),
  record({ type: 'queue-operation', operation: 'dequeue', timestamp: '2026-09-27T04:00:00.100Z' }),
  record({ type: 'atis-latch', atis: {} }),
  // A tool result arrives as a user record BEFORE the first real prompt.
  record({
    type: 'user',
    isSidechain: false,
    timestamp: '2026-09-27T04:00:01.000Z',
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] },
  }),
  record({
    type: 'user',
    isSidechain: false,
    timestamp: '2026-09-27T04:00:02.000Z',
    message: { role: 'user', content: [{ type: 'text', text: '把 claude-code 打包成桌面端' }] },
  }),
  record({ type: 'attachment', attachment: { kind: 'file' }, rendered: 'x', timestamp: '2026-09-27T04:00:03.000Z' }),
  record({
    type: 'assistant',
    isSidechain: false,
    timestamp: '2026-09-27T04:00:04.000Z',
    message: { role: 'assistant', content: [{ type: 'thinking', thinking: 'let me think' }, { type: 'text', text: '好的，我来处理。' }] },
  }),
  // Subagent traffic: real, but not part of the user's own turn count.
  record({
    type: 'assistant',
    isSidechain: true,
    timestamp: '2026-09-27T04:00:05.000Z',
    message: { role: 'assistant', content: [{ type: 'text', text: 'subagent working' }] },
  }),
  record({ type: 'last-prompt', lastPrompt: '...' }),
  record({ type: 'cost-state', totalCostUSD: 1.23 }),
  record({ type: 'system', subtype: 'info', level: 'info', timestamp: '2026-09-27T04:00:06.000Z', message: 'x' }),
]
const sessionAPath = join(projectA, `${SESSION_A}.jsonl`)
writeFileSync(sessionAPath, sessionALines.join('\n') + '\n')

// Session B: a second conversation in the same project, so grouping has something to group.
const sessionBPath = join(projectA, `${SESSION_B}.jsonl`)
writeFileSync(
  sessionBPath,
  [
    record({ sessionId: SESSION_B, type: 'user', timestamp: '2026-09-27T05:00:00.000Z', message: { role: 'user', content: 'second conversation' } }),
    record({ sessionId: SESSION_B, type: 'assistant', timestamp: '2026-09-27T05:00:01.000Z', message: { role: 'assistant', content: 'reply' } }),
  ].join('\n') + '\n',
)

// Session C: a different project, exercising the cwd grouping key.
writeFileSync(
  join(projectB, `${SESSION_C}.jsonl`),
  [
    JSON.stringify({ sessionId: SESSION_C, type: 'user', cwd: cwdB, version: '2.1.282', timestamp: '2026-09-26T05:00:00.000Z', message: { role: 'user', content: 'linux project chat' } }),
    JSON.stringify({ sessionId: SESSION_C, type: 'assistant', cwd: cwdB, timestamp: '2026-09-26T05:00:01.000Z', message: { role: 'assistant', content: 'ok' } }),
  ].join('\n') + '\n',
)

// A file that is not JSONL must be ignored rather than crashing the listing.
writeFileSync(join(projectA, 'notes.txt'), 'ignore me')

check('cwd encoding matches Claude Code', encodeProjectDir('D:\\Claudecode-CN') === 'D--Claudecode-CN', encodeProjectDir('D:\\Claudecode-CN'))
check('cwd encoding handles posix paths', encodeProjectDir('/home/dev/demo') === '-home-dev-demo', encodeProjectDir('/home/dev/demo'))

if (!existsSync(CLAUDE)) {
  console.error(`claude.exe not found at ${CLAUDE}`)
  process.exit(2)
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

function stopChild(child, timeoutMs = 5000) {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve()
      return
    }
    const timer = setTimeout(resolve, timeoutMs)
    child.once('close', () => {
      clearTimeout(timer)
      resolve()
    })
    child.kill()
  })
}

const bridge = spawn(process.execPath, [BRIDGE, '--port', '0', '--claude', CLAUDE, '--token', 'sk-mock'], {
  stdio: ['ignore', 'pipe', 'pipe'],
  env: { ...process.env, CLAUDE_CONFIG_DIR: scratch },
})

try {
  const ready = await waitForReady(bridge)
  const base = `http://127.0.0.1:${ready.port}`

  const api = async (path, init) => {
    const response = await fetch(`${base}${path}`, {
      ...init,
      headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
    })
    return { status: response.status, body: await response.json().catch(() => ({})) }
  }

  const listing = await api('/api/transcripts')
  check('transcript route answers', listing.status === 200, `HTTP ${listing.status}`)
  check('transcript root honours CLAUDE_CONFIG_DIR', String(listing.body.root ?? '').includes(scratch), String(listing.body.root))
  check('all three transcripts are listed', listing.body.total === 3, String(listing.body.total))
  check('the .txt file is ignored', !JSON.stringify(listing.body.transcripts).includes('notes.txt'))

  const byId = Object.fromEntries((listing.body.transcripts ?? []).map((item) => [item.sessionId, item]))
  const a = byId[SESSION_A]
  check('session A is found', Boolean(a))
  check('cwd is read from the records', a?.cwd === cwdA, String(a?.cwd))
  check('title is the first real prompt, not a tool result', a?.title === '把 claude-code 打包成桌面端', String(a?.title))
  check('non-conversation records are not counted as turns', a?.turns === 2, `${a?.turns} turns`)
  check('user and assistant turns are counted separately', a?.userTurns === 1 && a?.assistantTurns === 1, `u=${a?.userTurns} a=${a?.assistantTurns}`)
  check(
    'a tool result is counted as a tool result, not as a user turn',
    a?.toolResultRecords === 1,
    String(a?.toolResultRecords),
  )
  check(
    'the counts add up to the conversation records present',
    (a?.userTurns ?? 0) + (a?.assistantTurns ?? 0) + (a?.toolResultRecords ?? 0) === 3,
    `u+a+tr=${(a?.userTurns ?? 0) + (a?.assistantTurns ?? 0) + (a?.toolResultRecords ?? 0)}`,
  )
  check('sidechain traffic is tracked separately', a?.sidechainRecords === 1, String(a?.sidechainRecords))
  check('version is captured', a?.version === '2.1.282', String(a?.version))
  check('git branch is captured', a?.gitBranch === 'main', String(a?.gitBranch))
  check('timestamps bracket the conversation', a?.startedAt === '2026-09-27T04:00:01.000Z' && a?.endedAt === '2026-09-27T04:00:04.000Z', `${a?.startedAt} .. ${a?.endedAt}`)

  check('transcripts are grouped by working directory', (listing.body.groups ?? []).length === 2, JSON.stringify((listing.body.groups ?? []).map((g) => g.cwd)))
  const groupA = (listing.body.groups ?? []).find((g) => g.cwd === cwdA)
  check('the two sessions in one project are grouped together', groupA?.items.length === 2, String(groupA?.items.length))

  const search = await api('/api/transcripts?q=linux')
  check('search filters the listing', search.body.matched === 1, JSON.stringify(search.body.matched))
  check('search matches on the title', search.body.transcripts?.[0]?.sessionId === SESSION_C, String(search.body.transcripts?.[0]?.sessionId))

  const empty = await api('/api/transcripts?q=zzzz-no-such-text')
  check('a search with no hits returns none', empty.body.matched === 0, String(empty.body.matched))

  // Export: the portable half of chat-import's CLI, against Claude Code's format.
  const exported = await api('/api/transcripts/export', { method: 'POST', body: JSON.stringify({ sessionId: SESSION_A }) })
  check('export succeeds', exported.status === 200, `HTTP ${exported.status}`)
  const md = String(exported.body.markdown ?? '')
  check('export names the session in a heading', md.startsWith('# 把 claude-code 打包成桌面端'), md.split('\n')[0])
  check('export includes the working directory', md.includes(cwdA))
  check('export includes the user prompt text', md.includes('把 claude-code 打包成桌面端'))
  check('export includes the assistant text', md.includes('好的，我来处理。'))
  check('export keeps reasoning collapsed', md.includes('<details><summary>推理</summary>'))
  check('export excludes non-conversation records', !md.includes('queue-operation') && !md.includes('atis-latch'))

  const missing = await api('/api/transcripts/export', { method: 'POST', body: JSON.stringify({ sessionId: 'no-such-session' }) })
  check('exporting an unknown session fails loudly', missing.status === 404, `HTTP ${missing.status}`)

  const noId = await api('/api/transcripts/export', { method: 'POST', body: JSON.stringify({}) })
  check('export without an id is rejected', noId.status === 400, `HTTP ${noId.status}`)

  check('the transcript file was never modified', readFileSync(sessionAPath, 'utf8').split('\n').length - 1 === sessionALines.length)
} finally {
  await stopChild(bridge)
  rmSync(scratch, { recursive: true, force: true })
}

finish(results)
