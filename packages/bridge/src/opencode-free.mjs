/**
 * opencode 免费模型路由：用官方 CLI 的匿名免费档当模型后端。
 *
 * MEASURED (1.19.4): `opencode run --format json -m opencode/glm-5.3-flash-free "…"` answers in ~0.5 s with
 * zero credentials (`opencode auth list` shows 0). The default `--format default` waits for a TTY, which is
 * why an earlier probe looked "hung" — the JSON format is the machine-readable one.
 *
 * WHY THE CLI AND NOT ITS HTTP SERVER: `opencode serve` is a session-oriented REST API that would need its
 * own client; `run --format json` is one process per question, which matches this bridge's request/response
 * shape and leaves no daemon to keep alive.
 */
import { spawn } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { dataSubDir } from './paths.mjs'

const DEFAULT_TIMEOUT_MS = 180000
const MAX_OUTPUT_BYTES = 8 * 1024 * 1024

function candidates() {
  const explicit = String(process.env.CCCN_OPENCODE ?? '').trim()
  if (explicit !== '') return [explicit]
  const sidecar = process.env.CCCN_SIDECAR_DIR ?? dirname(process.execPath)
  return [join(sidecar, 'opencode', 'opencode.exe'), 'opencode', 'opencode.exe']
}

let cached = null

/**
 * MEASURED: an opencode.exe that lives on drive D: fails at startup with
 * `FileSystem.open (...\opencode.log)`, while the same bytes on C: work. The install drive is the user's
 * choice, so the CLI is copied once into the app's data directory on C: and run from there.
 */
function materialize(cli) {
  try {
    if (!cli.includes('\\') && !cli.includes('/')) return cli
    const dir = dataSubDir('opencode-bin')
    const dest = join(dir, 'opencode.exe')
    const sourceSize = statSync(cli).size
    if (existsSync(dest) && statSync(dest).size === sourceSize) return dest
    mkdirSync(dir, { recursive: true })
    copyFileSync(cli, dest)
    return dest
  } catch {
    return cli
  }
}


export function discoverOpencode({ refresh = false } = {}) {
  if (cached && !refresh) return cached
  for (const candidate of candidates()) {
    if (candidate.includes('\\') || candidate.includes('/')) {
      if (existsSync(candidate)) return (cached = { cli: candidate, source: 'path' })
    } else {
      // Bare name: let the OS resolve it, but do not claim availability without checking.
      return (cached = { cli: candidate, source: 'path-name' })
    }
  }
  return (cached = { cli: null, source: null })
}

function runOpencode({ cli, args, cwd, timeoutMs }) {
  return new Promise((resolve) => {
    /**
     * stdio[0] MUST be 'ignore': with execFile's inherited stdin pipe the CLI waits for EOF that never comes,
     * which looked like a network hang for two probes in a row.
     */
    const child = spawn(cli, args, {
      cwd: cwd && existsSync(cwd) ? cwd : undefined,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, OPENCODE_DISABLE_AUTOUPDATE: '1' },
    })
    let stdout = ''
    let stderr = ''
    const limit = Math.min(Math.max(Number(timeoutMs) || DEFAULT_TIMEOUT_MS, 5000), 600000)
    const timer = setTimeout(() => {
      child.kill()
      resolve({ error: Object.assign(new Error('timeout'), { killed: true }), stdout, stderr })
    }, limit)
    child.stdout.on('data', (chunk) => {
      if (stdout.length < MAX_OUTPUT_BYTES) stdout += String(chunk)
    })
    child.stderr.on('data', (chunk) => {
      if (stderr.length < MAX_OUTPUT_BYTES) stderr += String(chunk)
    })
    child.on('error', (error) => {
      clearTimeout(timer)
      resolve({ error, stdout, stderr })
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({ error: code === 0 ? null : Object.assign(new Error('exit ' + code), { killed: false }), stdout, stderr })
    })
  })
}

/** `opencode models` 里形如 `opencode/xxx-free` 的行；只保留免费档。 */
export async function listFreeModels({ cliPath, timeoutMs = 60000 } = {}) {
  const cli = materialize(String(cliPath ?? discoverOpencode().cli ?? ''))
  if (cli === '') return { ok: false, error: '没有找到 opencode CLI' }
  const result = await runOpencode({ cli, args: ['models'], timeoutMs })
  if (result.error) return { ok: false, error: `opencode models 失败：${result.stderr.slice(0, 160) || result.error.message}` }
  const models = result.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => /^opencode\/.+-free$/.test(line))
  return models.length > 0 ? { ok: true, models } : { ok: false, error: 'opencode 没有报告免费模型' }
}

function parseTextEvents(raw) {
  let text = ''
  let reasoning = ''
  for (const line of String(raw).split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed.startsWith('{')) continue
    let event = null
    try {
      event = JSON.parse(trimmed)
    } catch {
      continue
    }
    const part = event?.part
    if (part?.type === 'text' && typeof part.text === 'string') text += part.text
    if (part?.type === 'reasoning' && typeof part.text === 'string') reasoning += part.text
  }
  return { text, reasoning }
}

export async function askOpencode({ prompt, model, cwd, timeoutMs, cliPath } = {}) {
  const cli = materialize(String(cliPath ?? discoverOpencode().cli ?? ''))
  if (cli === '') return { ok: false, code: 'no-cli', error: '没有找到 opencode CLI' }
  const text = String(prompt ?? '').trim()
  if (text === '') return { ok: false, error: '请求里没有可发送的文本' }
  const result = await runOpencode({
    cli,
    args: ['run', '--print-logs', '--log-level', 'ERROR', '--format', 'json', '--model', String(model ?? 'opencode/glm-5.3-flash-free'), text],
    cwd,
    timeoutMs,
  })
  if (result.error) {
    if (result.error.killed) return { ok: false, code: 'timeout', error: 'opencode 超时' }
    return { ok: false, code: 'failed', error: (result.stderr || result.error.message).slice(0, 300) }
  }
  const parsed = parseTextEvents(result.stdout)
  if (parsed.text === '') return { ok: false, code: 'empty', error: `opencode 没有返回文本：${result.stderr.slice(0, 160)}` }
  return { ok: true, text: parsed.text, reasoning: parsed.reasoning }
}
