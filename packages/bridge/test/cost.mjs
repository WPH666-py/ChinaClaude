/**
 * Verify cost accounting end to end: CLI usage -> bridge timeline -> price.
 *
 * This is the test that would catch the two ways a bill silently goes wrong:
 *
 *   1. CACHE HITS COUNTED AS MISSES. The mock reports a large `cache_read_input_tokens` next to a
 *      small `input_tokens`, exactly as the real endpoint does. At flash rates a hit is 50x cheaper
 *      than a miss, so a pipeline that drops the cache bucket overshoots by an order of magnitude.
 *   2. A MID-SESSION MODEL SWITCH RETROACTIVELY REPRICING EARLIER TURNS. Two turns run on two
 *      models; each must be priced at the model that RAN it, which is why the bridge stamps
 *      `model` onto the result event at push time.
 *
 * The expected price is computed HERE from the published table, in a separate implementation from
 * `pricing.mjs`. Importing the module under test would make the check a tautology — it would still
 * pass if the rate table itself were wrong.
 *
 * Rate source: https://api-docs.deepseek.com/zh-cn/quick_start/pricing (2026-09), CNY per 1M tokens.
 *
 * Run: node packages/bridge/test/cost.mjs
 */
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { finish, stopChild } from './harness.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const BRIDGE = join(here, '..', 'src', 'cli.mjs')
const CLAUDE = process.env.CCCN_CLAUDE_BINARY ?? 'D:\\Claudecode-CN\\_probe\\package\\claude.exe'

// The published table, transcribed independently of pricing.mjs.
const RATES = {
  'deepseek-flash': {
    offPeak: { cacheHit: 0.02, cacheMiss: 1, output: 4 },
    peak: { cacheHit: 0.04, cacheMiss: 2, output: 8 },
  },
  'deepseek-v4-pro': {
    offPeak: { cacheHit: 0.15, cacheMiss: 4.5, output: 13.5 },
    peak: { cacheHit: 0.3, cacheMiss: 9, output: 27 },
  },
}

/** Beijing weekday business hours, recomputed here rather than imported. */
function peakAt(at) {
  const beijing = new Date(at + 8 * 3600 * 1000)
  const day = beijing.getUTCDay()
  if (day === 0 || day === 6) return false
  const minutes = beijing.getUTCHours() * 60 + beijing.getUTCMinutes()
  return (minutes >= 540 && minutes < 720) || (minutes >= 840 && minutes < 1080)
}

/** Independent price of one turn, from the table above. */
function expectedCny(usage, billed, at) {
  const rate = peakAt(at) ? RATES[billed].peak : RATES[billed].offPeak
  const miss = (usage.inputTokens ?? 0) + (usage.cacheCreationTokens ?? 0)
  const hit = usage.cacheReadTokens ?? 0
  const out = usage.outputTokens ?? 0
  return (miss * rate.cacheMiss + hit * rate.cacheHit + out * rate.output) / 1e6
}

const results = []
function check(name, ok, detail = '') {
  results.push({ name, ok })
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${name}${detail ? '  — ' + detail : ''}`)
}

/**
 * Mock endpoint. Reports cache-heavy usage so the cache bucket is exercised, and varies
 * output_tokens per call so the two turns are distinguishable in the totals.
 */
function createBackend() {
  let calls = 0
  return createServer((req, res) => {
    if (req.method === 'HEAD') {
      res.writeHead(200).end()
      return
    }
    calls++
    const output = 400 * calls
    const usage = {
      input_tokens: 900,
      cache_creation_input_tokens: 100,
      cache_read_input_tokens: 2000,
      output_tokens: 1,
    }
    res.writeHead(200, { 'Content-Type': 'text/event-stream' })
    res.end(
      [
        'event: message_start',
        `data: ${JSON.stringify({ type: 'message_start', message: { id: `m${calls}`, type: 'message', role: 'assistant', model: 'mock', content: [], stop_reason: null, usage } })}`,
        '',
        'event: content_block_start',
        'data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}',
        '',
        'event: content_block_delta',
        `data: ${JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: `reply ${calls}` } })}`,
        '',
        'event: content_block_stop',
        'data: {"type":"content_block_stop","index":0}',
        '',
        'event: message_delta',
        `data: ${JSON.stringify({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: output } })}`,
        '',
        'event: message_stop',
        'data: {"type":"message_stop"}',
        '',
        '',
      ].join('\n'),
    )
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

/**
 * Collect the session's SSE stream into an array, so assertions read the SAME events the UI does
 * rather than the bridge's internal state.
 */
function openStream(base, sessionId) {
  const collected = []
  const controller = new AbortController()
  const done = (async () => {
    const response = await fetch(`${base}/api/sessions/${sessionId}/events`, { signal: controller.signal })
    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    for (;;) {
      let chunk
      try {
        chunk = await reader.read()
      } catch {
        return
      }
      if (chunk.done) return
      buffer += decoder.decode(chunk.value, { stream: true })
      let index
      while ((index = buffer.indexOf('\n\n')) >= 0) {
        const frame = buffer.slice(0, index)
        buffer = buffer.slice(index + 2)
        const dataLine = frame.split('\n').find((line) => line.startsWith('data:'))
        if (!dataLine) continue
        try {
          collected.push(JSON.parse(dataLine.slice(5).trim()))
        } catch {
          /* ignore keep-alives */
        }
      }
    }
  })()
  return { collected, close: () => controller.abort(), done }
}

async function createSession(base, body = {}) {
  const response = await fetch(`${base}/api/sessions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ cwd: process.cwd(), ...body }),
  })
  return response.json()
}

async function sendTurn(base, sessionId, text) {
  await fetch(`${base}/api/sessions/${sessionId}/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text }),
  })
}

/** Wait until the stream shows `count` finished turns, or time out. */
async function waitForTurns(stream, count, timeoutMs = 90000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const turns = stream.collected.filter((event) => event.kind === 'result')
    if (turns.length >= count) return turns
    await new Promise((r) => setTimeout(r, 300))
  }
  return stream.collected.filter((event) => event.kind === 'result')
}

async function cost(base, sessionId) {
  const response = await fetch(`${base}/api/sessions/${sessionId}/cost`)
  return { status: response.status, body: await response.json().catch(() => ({})) }
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

let stream = null
try {
  const ready = await waitForReady(bridge)
  const base = `http://127.0.0.1:${ready.port}`

  // A session on a sonnet-class model: the relay bills that as deepseek-flash.
  const session = await createSession(base, { model: 'claude-sonnet-5' })
  stream = openStream(base, session.id)

  // An untouched session must NOT report a confident zero.
  const empty = await cost(base, session.id)
  check('cost route answers', empty.status === 200, `HTTP ${empty.status}`)
  check('cost is quoted in CNY', empty.body.currency === 'CNY', String(empty.body.currency))
  check('a session with no turns is unpriced, not ¥0.00', empty.body.cost?.priced === false, JSON.stringify(empty.body.cost?.pricedTurns))
  check('unpriced cost still reports zero turns', empty.body.cost?.pricedTurns === 0)

  await sendTurn(base, session.id, 'first turn')
  const afterFirst = await waitForTurns(stream, 1)
  check('one turn was recorded', afterFirst.length === 1, String(afterFirst.length))

  const turn1 = afterFirst[0]
  check('result event carries usage', (turn1?.usage?.inputTokens ?? 0) > 0, JSON.stringify(turn1?.usage))
  check(
    'result event carries the model that ran it',
    typeof turn1?.model === 'string' && turn1.model.length > 0,
    String(turn1?.model),
  )
  check(
    'cache reads are reported separately from input',
    (turn1?.usage?.cacheReadTokens ?? 0) >= 2000,
    `in=${turn1?.usage?.inputTokens} cache=${turn1?.usage?.cacheReadTokens}`,
  )

  const first = await cost(base, session.id)
  check('cost is now priced', first.body.cost?.priced === true)
  check('one priced turn', first.body.cost?.pricedTurns === 1, String(first.body.cost?.pricedTurns))
  check('turn is billed as flash', first.body.cost?.perModel?.[0]?.model === 'deepseek-flash', String(first.body.cost?.perModel?.[0]?.model))

  // Independent recomputation from the OBSERVED usage and timestamp.
  const want1 = expectedCny(turn1.usage, 'deepseek-flash', turn1.at)
  const got1 = first.body.cost.totalCny
  check(
    'price matches an independent recomputation of the published table',
    Math.abs(got1 - want1) < 1e-9,
    `bridge=${got1} expected=${want1} (${peakAt(turn1.at) ? 'peak' : 'off-peak'})`,
  )
  check(
    'cache hits are billed at the hit rate, not the miss rate',
    got1 < expectedCny({ ...turn1.usage, cacheReadTokens: 0, inputTokens: turn1.usage.inputTokens + turn1.usage.cacheReadTokens }, 'deepseek-flash', turn1.at),
    'cache was folded into input',
  )

  // --- mid-session switch ---------------------------------------------------
  const switched = await fetch(`${base}/api/sessions/${session.id}/model`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'deepseek-v4-pro' }),
  })
  check('model switch accepted', switched.status === 200, `HTTP ${switched.status}`)
  await new Promise((r) => setTimeout(r, 1200))

  await sendTurn(base, session.id, 'second turn')
  const afterSecond = await waitForTurns(stream, 2)
  check('two turns were recorded', afterSecond.length === 2, String(afterSecond.length))

  const turn2 = afterSecond[1]
  check('second turn was stamped with the switched model', turn2?.model === 'deepseek-v4-pro', String(turn2?.model))
  check('first turn kept its original stamp', turn1?.model !== turn2?.model, `${turn1?.model} vs ${turn2?.model}`)

  const second = await cost(base, session.id)
  check('both turns are priced', second.body.cost?.pricedTurns === 2, String(second.body.cost?.pricedTurns))
  check(
    'the two turns are attributed to two different models',
    (second.body.cost?.perModel ?? []).length === 2,
    JSON.stringify((second.body.cost?.perModel ?? []).map((m) => m.model)),
  )

  const wantTotal = want1 + expectedCny(turn2.usage, 'deepseek-v4-pro', turn2.at)
  check(
    'total is each turn priced at the model that RAN it',
    Math.abs(second.body.cost.totalCny - wantTotal) < 1e-9,
    `bridge=${second.body.cost.totalCny} expected=${wantTotal}`,
  )
  // Had the switch rewritten history, the total would be pro(turn1) + pro(turn2). The gap between
  // that and the real total must be exactly the pro-vs-flash delta of the FIRST turn.
  const repriceBound =
    expectedCny(turn1.usage, 'deepseek-v4-pro', turn1.at) + expectedCny(turn2.usage, 'deepseek-v4-pro', turn2.at)
  check(
    'the earlier turn was not repriced at the new model',
    second.body.cost.totalCny < repriceBound - 1e-12,
    `total=${second.body.cost.totalCny} would-be-if-rewritten=${repriceBound}`,
  )
  check(
    'the gap is exactly the first turn priced at its own model instead of the new one',
    Math.abs(repriceBound - second.body.cost.totalCny - (expectedCny(turn1.usage, 'deepseek-v4-pro', turn1.at) - want1)) < 1e-9,
  )
  check(
    'pro rates are higher than flash for the same usage',
    expectedCny(turn2.usage, 'deepseek-v4-pro', turn2.at) > expectedCny(turn2.usage, 'deepseek-flash', turn2.at),
  )

  // A session created with an unknown model must degrade to "unpriced", never to a number.
  const odd = await createSession(base, { model: 'gpt-9' })
  const oddStream = openStream(base, odd.id)
  await sendTurn(base, odd.id, 'unknown model turn')
  await waitForTurns(oddStream, 1)
  const oddCost = await cost(base, odd.id)
  check('an unknown model is unpriced rather than free', oddCost.body.cost?.priced === false, JSON.stringify(oddCost.body.cost?.perModel))
  check('the unpriced turn is counted so the UI can explain it', oddCost.body.cost?.unpricedTurns === 1, String(oddCost.body.cost?.unpricedTurns))
  oddStream.close()
} finally {
  stream?.close()
  await stopChild(bridge)
  backend.close()
}

finish(results)
