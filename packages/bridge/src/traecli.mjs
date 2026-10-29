/**
 * Trae 本机 CLI 路由：把 Anthropic Messages 请求翻译成一次 `traecli exec`。
 *
 * WHY THIS EXISTS: the IDE has no model API and its stored login is opaque, but the vendor ships an
 * official CLI 2.0 (`traecli`) with a headless mode — `exec --json`, `-o` for the last message,
 * `--sandbox read-only`, `-a never` for approvals, and `login status`. That is the sanctioned,
 * machine-independent route; the same shape as the WorkBuddy connector.
 *
 * WHY `-o` AND NOT THE JSONL STREAM: JSONL event shapes are versioned and undocumented in detail, while
 * `--output-last-message` is documented as "the agent's final message" — one small file that cannot be
 * mis-parsed. Events are still requested for diagnostics when the call fails.
 */
import { execFile } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const DEFAULT_TIMEOUT_MS = 180000
const MAX_OUTPUT_BYTES = 8 * 1024 * 1024

/** Common locations, plus PATH. Windows shims are `.cmd`, which need `cmd /c`. */
function candidates() {
  const explicit = String(process.env.CCCN_TRAECLI ?? process.env.TRAECLI_PATH ?? '').trim()
  if (explicit !== '') return [explicit]
  const local = process.env.LOCALAPPDATA ?? ''
  return [
    join(local, 'Programs', 'TraeCLI', 'bin', 'traecli.cmd'),
    join(local, 'Programs', 'TraeCLI', 'bin', 'traecli.exe'),
    join(local, 'trae-cli', 'bin', 'traecli.cmd'),
    join(process.env.USERPROFILE ?? '', '.trae', 'bin', 'traecli.cmd'),
  ].filter((path) => path !== '')
}

let cached = null

export function discoverTraeCli({ refresh = false } = {}) {
  if (cached && !refresh) return cached
  for (const candidate of candidates()) {
    if (existsSync(candidate)) return (cached = { cli: candidate, source: 'common' })
  }
  cached = { cli: null, source: null }
  return cached
}

export function traeCliStatus() {
  const { cli } = discoverTraeCli()
  return {
    ok: true,
    available: cli !== null,
    cli,
    hint: cli
      ? '第一次使用需要登录：点「打开 TRAE CLI 登录窗口」执行 traecli login（浏览器授权），或 traecli login --with-trae-pat。'
      : '没有找到 traecli。安装：irm https://trae.cn/trae-cli/install_v2.ps1 | iex',
    installCommand: 'irm https://trae.cn/trae-cli/install_v2.ps1 | iex',
  }
}

/** Run traecli (a .cmd shim on Windows) and resolve with stdout/stderr/exit code. */
function run(cli, args, { cwd, timeoutMs } = {}) {
  const isShim = /\.(cmd|bat)$/i.test(cli)
  const file = isShim ? 'cmd' : cli
  const finalArgs = isShim ? ['/c', cli, ...args] : args
  return new Promise((resolve) => {
    execFile(
      file,
      finalArgs,
      {
        cwd: cwd && existsSync(cwd) ? cwd : undefined,
        timeout: Math.min(Math.max(Number(timeoutMs) || DEFAULT_TIMEOUT_MS, 5000), 600000),
        windowsHide: true,
        shell: false,
        maxBuffer: MAX_OUTPUT_BYTES,
      },
      (error, stdout, stderr) => {
        resolve({
          code: error?.killed ? 'timeout' : error ? 'failed' : 'ok',
          exitCode: typeof error?.code === 'number' ? error.code : 0,
          stdout: String(stdout ?? ''),
          stderr: String(stderr ?? ''),
          killed: Boolean(error?.killed),
        })
      },
    )
  })
}

/** `traecli login status` — the only reliable way to tell "logged in" from "not". */
export async function traeLoginStatus({ cliPath } = {}) {
  const cli = String(cliPath ?? discoverTraeCli().cli ?? '')
  if (cli === '') return { ok: false, available: false, error: '没有找到 traecli' }
  const result = await run(cli, ['login', 'status'], { timeoutMs: 30000 })
  const text = `${result.stdout}\n${result.stderr}`.trim()
  const loggedIn = result.exitCode === 0 && !/not logged in/i.test(text)
  return { ok: true, available: true, loggedIn, detail: text.slice(0, 200) }
}

/**
 * One headless call. The answer is read from `-o` (documented "last message"), never from the event
 * stream; the stream is kept only for the error message when the call fails.
 */
export async function askTrae({ prompt, cwd, timeoutMs, cliPath } = {}) {
  const cli = String(cliPath ?? discoverTraeCli().cli ?? '')
  if (cli === '') return { ok: false, code: 'no-cli', error: '没有找到 traecli' }
  const text = String(prompt ?? '').trim()
  if (text === '') return { ok: false, error: '请求里没有可发送的文本' }

  const dir = mkdtempSync(join(tmpdir(), 'cccn-traecli-'))
  const outFile = join(dir, 'last.txt')
  try {
    const result = await run(
      cli,
      [
        'exec',
        '--json',
        '--sandbox', 'read-only',
        '--ephemeral',
        '-o', outFile,
        ...(cwd && existsSync(cwd) ? ['-C', cwd] : []),
        '--',
        text,
      ],
      { cwd, timeoutMs },
    )
    const combined = `${result.stdout}\n${result.stderr}`
    if (/not logged in/i.test(combined)) {
      return { ok: false, code: 'unauthenticated', error: 'TRAE CLI 还没有登录：运行 traecli login（或 login --with-trae-pat）。' }
    }
    // MEASURED on this machine: without a login, 0.209.1 tries a git-based "Codebase authentication" and
    // fails with a git-not-found error instead of a login prompt. Reporting that verbatim would send the
    // user chasing the wrong problem, so it is translated into the two things that actually fix it.
    if (/Codebase Git authentication failed|git Codebase authentication failed/i.test(combined)) {
      return {
        ok: false,
        code: 'requires-git-or-login',
        error: 'TRAECLI 先用 git 做一次「代码库认证」但本机没有 git：安装 Git for Windows，或先运行 traecli login 再试。',
      }
    }
    if (result.code === 'timeout') return { ok: false, code: 'timeout', error: 'TRAECLI 超时' }
    if (existsSync(outFile)) {
      const answer = readFileSync(outFile, 'utf8').trim()
      if (answer !== '') return { ok: true, text: answer }
    }
    if (result.exitCode !== 0) {
      const first = combined.split(/\r?\n/).find((line) => line.trim() !== '') ?? 'traecli 执行失败'
      return { ok: false, code: 'failed', error: first.slice(0, 300) }
    }
    return { ok: false, code: 'empty', error: 'traecli 没有返回内容' }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

export function flattenAnthropicRequest(body) {
  const lines = []
  if (typeof body?.system === 'string' && body.system.trim() !== '') lines.push(`System:\n${body.system.trim()}`)
  for (const message of Array.isArray(body?.messages) ? body.messages : []) {
    const role = message?.role === 'assistant' ? 'Assistant' : 'User'
    const parts = Array.isArray(message?.content) ? message.content : [{ type: 'text', text: String(message?.content ?? '') }]
    const text = parts.map((part) => (part?.type === 'text' ? String(part.text ?? '') : '')).filter(Boolean).join('\n')
    if (text !== '') lines.push(`${role}:\n${text}`)
  }
  return lines.join('\n\n')
}

/**
 * 真实的 Trae 模型清单：`traecli models` 逐行输出模型 id。
 *
 * WHY THIS EXISTS: 之前只导入一条 `trae-default`，用户看到的下拉里没有具体模型。CLI 自己就能列，
 * 所以导入应该是「列出来 → 每个一行 → 全部指向本桥代理」，而不是替用户编一个名字。
 */
export async function listTraeModels({ cliPath } = {}) {
  const cli = String(cliPath ?? discoverTraeCli().cli ?? '')
  if (cli === '') return { ok: false, error: '没有找到 traecli' }
  const result = await run(cli, ['models'], { timeoutMs: 60000 })
  if (result.exitCode !== 0 && result.stdout.trim() === '') {
    return { ok: false, error: (result.stderr || 'traecli models 执行失败').split(/\r?\n/)[0].slice(0, 200) }
  }
  const models = result.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '' && !/^[=\-]/.test(line) && !/^usage:/i.test(line))
  return { ok: true, models }
}

/**
 * 启动登录并把「浏览器授权 URL」交回去。
 *
 * MEASURED: `traecli login` starts a local callback server and prints the URL on stderr; the URL this build
 * prints is `console.enterprise.trae.cn/...` (ToB SSO). We surface the URL instead of hiding a terminal, so
 * the user gets a browser page with no console to type into — and we do NOT pretend a personal login flow
 * exists when the URL says otherwise.
 */
export async function startTraeLogin({ timeoutMs = 12000 } = {}) {
  const cli = String(discoverTraeCli().cli ?? '')
  if (cli === '') return { ok: false, error: '没有找到 traecli' }
  const { spawn } = await import('node:child_process')
  const isShim = /\.(cmd|bat)$/i.test(cli)
  const child = spawn(isShim ? 'cmd' : cli, isShim ? ['/c', cli, 'login'] : ['login'], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
  let text = ''
  const collect = (chunk) => {
    text += String(chunk)
  }
  child.stdout.on('data', collect)
  child.stderr.on('data', collect)
  const url = await new Promise((resolve) => {
    const started = Date.now()
    const timer = setInterval(() => {
      const match = /https:\/\/[^\s"']+/.exec(text)
      if (match) {
        clearInterval(timer)
        resolve(match[0])
        return
      }
      if (Date.now() - started > timeoutMs) {
        clearInterval(timer)
        resolve(null)
      }
    }, 250)
  })
  child.unref()
  if (!url) return { ok: false, error: '登录流程没有输出授权地址（CLI 可能已登录或网络不可用）', pid: child.pid }
  const enterprise = /console\.enterprise\.trae\.cn/.test(url)
  return { ok: true, url, enterprise, pid: child.pid, hint: enterprise ? '这是 CLI 默认打开的企业版 SSO 登录页；当前 CLI 构建没有个人版登录入口。' : '已在浏览器打开授权页。' }
}
