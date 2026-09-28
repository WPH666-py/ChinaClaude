/**
 * Verify the two features added on request: file attachments and account balance.
 *
 * Both are things a user asks for in one sentence and that fail quietly if built carelessly, so the
 * assertions target the specific failure modes:
 *
 *   ATTACHMENTS — a webview cannot write to disk, so the bridge does. The dangerous part is the
 *   filename: it arrives from the client and must never reach the filesystem. The probe submits
 *   traversal names (`../../evil.js`), an absolute-looking Windows path, and a name with no
 *   extension, then asserts every stored file landed INSIDE the attachments root with a generated
 *   basename.
 *
 *   BALANCE — the failure that matters is a wrong number, not a missing one. So a provider with no
 *   adapter must report "no balance available" rather than a zero, and an unreachable endpoint must
 *   report the reason. Nothing here asserts a real account value; that is not testable and would
 *   differ per machine.
 *
 * Run: node packages/bridge/test/attachments-balance.mjs
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'
import { finish } from './harness.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const BRIDGE = join(here, '..', 'src', 'cli.mjs')
const CLAUDE = process.env.CCCN_CLAUDE_BINARY ?? 'D:\\Claudecode-CN\\_probe\\package\\claude.exe'

const results = []
function check(name, ok, detail = '') {
  results.push({ name, ok })
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${name}${detail ? '  — ' + detail : ''}`)
}

if (!existsSync(CLAUDE)) {
  console.error(`claude.exe not found at ${CLAUDE}`)
  process.exit(2)
}

// Keep the real home clean: attachments go to a scratch directory for this run.
const attachRoot = mkdtempSync(join(tmpdir(), 'cccn-attach-'))
const OUTSIDE = join(attachRoot, '..', 'PWNED.js')

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
  return new Promise((resolveDone) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolveDone()
      return
    }
    const timer = setTimeout(resolveDone, timeoutMs)
    child.once('close', () => {
      clearTimeout(timer)
      resolveDone()
    })
    child.kill()
  })
}

const bridge = spawn(process.execPath, [BRIDGE, '--port', '0', '--claude', CLAUDE, '--token', 'sk-mock'], {
  stdio: ['ignore', 'pipe', 'pipe'],
  env: { ...process.env, CCCN_ATTACHMENTS_DIR: attachRoot },
})

const b64 = (text) => Buffer.from(text, 'utf8').toString('base64')

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

  console.log('attachments')
  const upload = await api('/api/attachments', {
    method: 'POST',
    body: JSON.stringify({
      files: [
        { name: 'note.txt', dataUrl: `data:text/plain;base64,${b64('hello attachment')}` },
        { name: 'shot.png', dataUrl: `data:image/png;base64,${b64('not really a png')}` },
        // Names chosen to escape the root if the client name were ever used to build the path.
        { name: '../../evil.js', dataUrl: `data:text/plain;base64,${b64('traversal')}` },
        { name: 'C:\\Windows\\System32\\drivers\\etc\\hosts', dataUrl: `data:text/plain;base64,${b64('absolute')}` },
        { name: 'no-extension', dataUrl: `data:text/plain;base64,${b64('bare')}` },
        { name: 'evil.exe', dataUrl: `data:application/octet-stream;base64,${b64('exe')}` },
      ],
    }),
  })
  check('upload answers 200', upload.status === 200, `HTTP ${upload.status}`)
  check('every file is reported', upload.body.results?.length === 6, String(upload.body.results?.length))
  check('every file succeeded', (upload.body.results ?? []).every((entry) => entry.ok), JSON.stringify(upload.body.results))

  const paths = (upload.body.results ?? []).filter((e) => e.ok).map((e) => e.path)
  check('paths are absolute', paths.every((p) => resolve(p) === p), paths[0] ?? '')
  check(
    'EVERY stored file is inside the attachments root',
    paths.every((p) => resolve(p).startsWith(resolve(attachRoot))),
    paths.find((p) => !resolve(p).startsWith(resolve(attachRoot))) ?? '',
  )
  check('no traversal escaped the root', !existsSync(OUTSIDE), OUTSIDE)
  check('the client filename is not reused as the basename', !paths.some((p) => /evil\.js$/.test(p)), paths.join(' | '))
  check('a disallowed extension is stored as .bin', paths.some((p) => p.endsWith('.bin')), paths.join(' | '))
  check('a real extension is preserved', paths.some((p) => p.endsWith('.txt')) && paths.some((p) => p.endsWith('.png')))

  const onDisk = readdirSync(attachRoot)
  check('the number of files on disk matches', onDisk.length === 6, String(onDisk.length))
  check(
    'content round-trips through base64',
    statSync(paths.find((p) => p.endsWith('.txt'))).size === 'hello attachment'.length,
    String(statSync(paths.find((p) => p.endsWith('.txt'))).size),
  )

  const usage = await api('/api/attachments')
  check('usage reports a count', usage.body.files === 6, String(usage.body.files))
  check('usage reports a size', usage.body.bytes > 0, String(usage.body.bytes))

  const empty = await api('/api/attachments', { method: 'POST', body: JSON.stringify({ files: [] }) })
  check('an empty upload is rejected', empty.status === 400, `HTTP ${empty.status}`)

  const junk = await api('/api/attachments', {
    method: 'POST',
    body: JSON.stringify({ files: [{ name: 'x.txt', dataUrl: 'data:text/plain;base64,' }] }),
  })
  check('empty content is rejected per file', junk.body.results?.[0]?.ok === false, JSON.stringify(junk.body.results))

  const cleared = await api('/api/attachments', { method: 'DELETE' })
  check('cleanup removes the files', cleared.body.ok === true && readdirSync(attachRoot).length === 0, JSON.stringify(cleared.body))

  console.log('balance')
  // DeepSeek's adapter is matched by host; pointed at a dead port it must fail with a reason, not 0.
  const unreachable = await api('/api/balance', {
    method: 'POST',
    body: JSON.stringify({ baseUrl: 'http://127.0.0.1:9', apiKey: 'sk-x' }),
  })
  check('an unknown endpoint reports no adapter', unreachable.body.available === false, JSON.stringify(unreachable.body))
  check('the reason names the missing adapter', String(unreachable.body.error ?? '').includes('没有内置余额接口'), String(unreachable.body.error))
  check('an unreadable balance is NEVER reported as zero', unreachable.body.total === null, String(unreachable.body.total))

  const noKey = await api('/api/balance', {
    method: 'POST',
    body: JSON.stringify({ baseUrl: 'https://api.deepseek.com/anthropic', apiKey: '' }),
  })
  check('a missing key is reported, not attempted', String(noKey.body.error ?? '').includes('未配置 API KEY'), String(noKey.body.error))

  // A custom endpoint with no server: the error must be the transport failure, not a silent zero.
  const dead = await api('/api/balance', {
    method: 'POST',
    body: JSON.stringify({ baseUrl: 'https://api.deepseek.com/anthropic', apiKey: 'sk-x', balanceUrl: 'http://127.0.0.1:9/balance' }),
  })
  check('a dead custom endpoint reports a transport error', dead.body.available === false && Boolean(dead.body.error), JSON.stringify(dead.body))
  check('the URL actually queried is returned for diagnosis', dead.body.url === 'http://127.0.0.1:9/balance', String(dead.body.url))

  // Rejecting key: a real host, an invalid token. This is the path a wrong key takes.
  const badKey = await api('/api/balance', {
    method: 'POST',
    body: JSON.stringify({ baseUrl: 'https://api.deepseek.com/anthropic', apiKey: 'sk-definitely-not-valid' }),
  })
  check(
    'an invalid key is reported as such',
    badKey.body.available === false && Boolean(badKey.body.error),
    JSON.stringify({ error: badKey.body.error, url: badKey.body.url }),
  )
  check('the built-in DeepSeek endpoint is matched by host', badKey.body.adapter === 'deepseek', String(badKey.body.adapter))
  check(
    'the balance URL ignores the /anthropic prefix',
    badKey.body.url === 'https://api.deepseek.com/user/balance',
    String(badKey.body.url),
  )
} finally {
  await stopChild(bridge)
  rmSync(attachRoot, { recursive: true, force: true })
}

finish(results)
