/**
 * Verify the connection test that backs the simplified add-model form.
 *
 * The form now has three fields — model, API-KEY, Base-URL — and a 测试连接 button whose whole value is
 * that it tells the truth. So the assertions target the ways a test lies:
 *
 *   1. FALSE SUCCESS. A 200 whose body is an error must not pass. Several relays answer 200 and put the
 *      failure in the payload.
 *   2. FALSE FAILURE ON A VALID URL. A Base-URL written as `…/v1` is common and documented; appending
 *      `/v1/messages` blindly produces `/v1/v1/messages`, a 404 that reads as a wrong host.
 *   3. A VAGUE REASON. 401 / 404 / 400 must be distinguishable, because each points at a different
 *      field (key, URL, model name).
 *
 * A local mock endpoint stands in for a vendor, so every case is deterministic and none of this needs
 * network access or a real key.
 *
 * Run: node packages/bridge/test/connect-test.mjs
 */
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { finish } from './harness.mjs'
import { messagesUrl } from '../src/connect-test.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const BRIDGE = join(here, '..', 'src', 'cli.mjs')
const CLAUDE = process.env.CCCN_CLAUDE_BINARY ?? 'D:\\Claudecode-CN\\_probe\\package\\claude.exe'

const results = []
function check(name, ok, detail = '') {
  results.push({ name, ok })
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${name}${detail ? '  — ' + detail : ''}`)
}

console.log('URL joining (pure)')
check('plain base URL gets /v1/messages', messagesUrl('https://api.example.com/anthropic') === 'https://api.example.com/anthropic/v1/messages', messagesUrl('https://api.example.com/anthropic'))
check('a base URL already ending in /v1 does not double it', messagesUrl('https://api.example.com/v1') === 'https://api.example.com/v1/messages', messagesUrl('https://api.example.com/v1'))
check('a trailing slash is tolerated', messagesUrl('https://api.example.com/anthropic/') === 'https://api.example.com/anthropic/v1/messages', messagesUrl('https://api.example.com/anthropic/'))
check('an empty value yields no URL', messagesUrl('') === '', messagesUrl(''))

/**
 * Mock vendor. Routes are chosen by path so each failure mode is a real HTTP response:
 *   /ok/v1/messages           200 with a normal payload
 *   /liar/v1/messages         200 with an ERROR payload  (the false-success case)
 *   /v1/messages              401 always
 *   /anthropic/v1/messages    400 naming the model, when the model is not what it expects
 */
const VENDOR = createServer((req, res) => {
  const chunks = []
  req.on('data', (chunk) => chunks.push(chunk))
  req.on('end', () => {
    let body = {}
    try {
      body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    } catch {
      /* keep {} */
    }
    const url = req.url ?? ''

    if (url === '/ok/v1/messages') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ id: 'msg_1', type: 'message', role: 'assistant', content: [{ type: 'text', text: 'pong' }] }))
      return
    }
    if (url === '/liar/v1/messages') {
      // 200, but the body says it failed. A status-only check calls this success.
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: { type: 'invalid_request_error', message: 'model not found' } }))
      return
    }
    if (url === '/v1/messages') {
      res.writeHead(401, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: { type: 'authentication_error', message: 'invalid api key' } }))
      return
    }
    if (url === '/anthropic/v1/messages') {
      if (body.model !== 'good-model') {
        res.writeHead(400, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: { type: 'invalid_request_error', message: `model '${body.model}' does not exist` } }))
        return
      }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ id: 'msg_2', content: [{ type: 'text', text: 'pong' }] }))
      return
    }
    res.writeHead(404, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: { message: 'not found' } }))
  })
})
await new Promise((resolve) => VENDOR.listen(0, '127.0.0.1', resolve))
const vendorBase = `http://127.0.0.1:${VENDOR.address().port}`

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
})

try {
  const ready = await waitForReady(bridge)
  const base = `http://127.0.0.1:${ready.port}`
  const test = async (payload) => {
    const response = await fetch(`${base}/api/test-connection`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    })
    return { status: response.status, body: await response.json().catch(() => ({})) }
  }

  const ok = await test({ baseUrl: `${vendorBase}/ok`, apiKey: 'sk-x', model: 'm' })
  check('a working endpoint reports success', ok.status === 200 && ok.body.ok === true, JSON.stringify(ok.body))
  check('success reports latency', typeof ok.body.latencyMs === 'number' && ok.body.latencyMs >= 0, String(ok.body.latencyMs))

  const liar = await test({ baseUrl: `${vendorBase}/liar`, apiKey: 'sk-x', model: 'm' })
  check('a 200 carrying an error is NOT reported as success', liar.body.ok === false, JSON.stringify(liar.body))
  check('...and the endpoint’s own message is surfaced', String(liar.body.message).includes('model not found'), String(liar.body.message))

  const unauth = await test({ baseUrl: vendorBase, apiKey: 'sk-x', model: 'm' })
  check('a 401 is reported as an auth problem, not a generic failure', String(unauth.body.message).includes('API-KEY'), String(unauth.body.message))

  const badModel = await test({ baseUrl: `${vendorBase}/anthropic`, apiKey: 'sk-x', model: 'nope' })
  check('a 400 is reported as a model/parameter problem', String(badModel.body.message).includes('模型名'), String(badModel.body.message))
  check('...and names the model the endpoint rejected', String(badModel.body.message).includes('nope'), String(badModel.body.message))

  const goodModel = await test({ baseUrl: `${vendorBase}/anthropic`, apiKey: 'sk-x', model: 'good-model' })
  check('the same endpoint passes with a model it serves', goodModel.body.ok === true, JSON.stringify(goodModel.body))

  // The /v1 case: the mock only implements `/v1/messages`, so a base URL ending in /v1 must reach it.
  const withV1 = await test({ baseUrl: `${vendorBase}/v1`, apiKey: 'sk-x', model: 'm' })
  check('a Base-URL ending in /v1 does not become /v1/v1', withV1.body.status === 401, `status=${withV1.body.status} url=${withV1.body.url}`)

  const noKey = await test({ baseUrl: `${vendorBase}/ok`, apiKey: '', model: 'm' })
  check('an empty key is rejected before any request', String(noKey.body.message).includes('API-KEY'), String(noKey.body.message))

  const noModel = await test({ baseUrl: `${vendorBase}/ok`, apiKey: 'sk-x', model: '' })
  check('an empty model is rejected before any request', String(noModel.body.message).includes('模型名称'), String(noModel.body.message))

  const noUrl = await test({ baseUrl: '', apiKey: 'sk-x', model: 'm' })
  check('an empty URL is rejected before any request', String(noUrl.body.message).includes('Base-URL'), String(noUrl.body.message))

  // A key with a full-width character (easy to paste out of a Chinese console) must be named as such,
  // not surfaced as "Cannot convert argument to a ByteString".
  const fullWidth = await test({ baseUrl: `${vendorBase}/ok`, apiKey: 'sk-ａｂｃ', model: 'm' })
  check(
    'a non-ASCII key is explained instead of throwing a ByteString error',
    String(fullWidth.body.message).includes('非 ASCII'),
    String(fullWidth.body.message),
  )
  check('...and the offending character is named', String(fullWidth.body.message).includes('U+'), String(fullWidth.body.message))

  // Surrounding whitespace is trimmed, not reported: the trim fixes a paste artifact, so the key works.
  const padded = await test({ baseUrl: `${vendorBase}/ok`, apiKey: ' sk-x ', model: 'm' })
  check('a key with surrounding whitespace is trimmed and works', padded.body.ok === true, String(padded.body.message))

  const junk = await test({ baseUrl: 'not a url', apiKey: 'sk-x', model: 'm' })
  check('an invalid URL is named as such', String(junk.body.message).includes('不是合法地址'), String(junk.body.message))

  const dead = await test({ baseUrl: 'http://127.0.0.1:9', apiKey: 'sk-x', model: 'm' })
  check('an unreachable host reports a connection error', dead.body.ok === false && String(dead.body.message).includes('无法连接'), String(dead.body.message))

  // A real endpoint, really reached, with an invalid key: the path a user with a typo takes.
  const realhost = await test({ baseUrl: 'https://api.deepseek.com/anthropic', apiKey: 'sk-invalid', model: 'deepseek-chat' })
  check(
    'a real vendor with a bad key reports auth failure (live)',
    realhost.body.ok === false && (realhost.body.status === 401 || realhost.body.status === 403),
    `status=${realhost.body.status} message=${realhost.body.message}`,
  )
} finally {
  await stopChild(bridge)
  VENDOR.close()
}

finish(results)
