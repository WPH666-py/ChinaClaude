/**
 * WorkBuddy 本机 CLI 路由：把 Anthropic Messages 请求翻译成 CodeBuddy CLI 的一次 `-p` 调用。
 *
 * WHY THE CLI AND NOT THE APP'S TOKEN: the desktop app holds an encrypted session that only its own
 * native binding can decrypt. The vendor ships an agent CLI that uses its own login (`codebuddy /login`),
 * and that is the sanctioned way to drive it from outside — no decryption, no MITM, no guessing at a
 * private SSE. The upstream plugin does the same thing for its `codebuddy_ask`.
 *
 * WHY IT IS A TRANSLATION AND NOT A FORWARD: the CLI takes a prompt and prints an answer; it does not
 * speak Anthropic Messages. So a request's system prompt and message history are flattened into text,
 * and the CLI's answer is wrapped back into the Anthropic response shape (including SSE, because
 * `claude.exe` streams).
 */
import { execFile, execFileSync, spawn } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname } from 'node:path'
import { join } from 'node:path'
import { dataFile } from './paths.mjs'

const DEFAULT_TIMEOUT_MS = 180000
const MAX_OUTPUT_BYTES = 8 * 1024 * 1024

/**
 * 跨机器发现 WorkBuddy 的 CLI 入口。
 *
 * WHY NOT A FIXED PATH: this machine installs it under `D:\Workbuddy海外版`, someone else under
 * `%LOCALAPPDATA%\Programs`, and a third under `%ProgramFiles%`. A hard-coded path works on exactly one
 * computer, which is the opposite of the goal. The order is cheap-to-expensive:
 *
 *   1. `CCCN_CBC_CLI` / `CODEBUDDY_CLI` — explicit override, also what tests use;
 *   2. the uninstall registry entries — the same source Windows' "Apps & features" reads;
 *   3. Start Menu shortcuts — catches custom install directories (this machine is one);
 *   4. common install roots — the default cases, no subprocess needed;
 *   5. a running `WorkBuddyAI.exe` — the app is open, so its directory is authoritative.
 */
const CLI_RELATIVE = join('resources', 'app.asar.unpacked', 'cli', 'dist', 'codebuddy-lite-wb.mjs')

function fromRoot(root) {
  if (typeof root !== 'string' || root.trim() === '') return []
  const base = root.replace(/^"|"$/g, '').trim()
  return [join(base, CLI_RELATIVE), join(base, 'WorkBuddyAI', CLI_RELATIVE), join(base, 'WorkBuddy', CLI_RELATIVE)]
}

function registryRoots() {
  const roots = []
  try {
    const output = execFileSync('reg', ['query', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall', '/s', '/f', 'WorkBuddy'], {
      encoding: 'utf8',
      timeout: 8000,
      windowsHide: true,
    })
    // `reg query` prints blocks; take InstallLocation / DisplayIcon from each.
    for (const line of output.split(/\r?\n/)) {
      const match = /(InstallLocation|DisplayIcon)\s+REG_\w+\s+(.+)$/.exec(line)
      if (!match) continue
      const value = match[2].trim().replace(/^"|"$/g, '')
      if (value === '') continue
      const cleaned = value.replace(/,\d+$/, '')
      roots.push(/\\.exe$/i.test(cleaned) ? dirname(cleaned) : cleaned)
    }
  } catch {
    /* registry access is best-effort; a locked-down machine falls through to the other sources */
  }
  return roots
}

function shortcutRoots() {
  const roots = []
  try {
    const script =
      "[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; $s=(New-Object -ComObject WScript.Shell); Get-ChildItem \"$env:APPDATA\\Microsoft\\Windows\\Start Menu\\Programs\",\"$env:ProgramData\\Microsoft\\Windows\\Start Menu\\Programs\" -Recurse -Filter *.lnk -ErrorAction SilentlyContinue | ForEach-Object { $t=$s.CreateShortcut($_.FullName).TargetPath; if ($t -match 'WorkBuddy|CodeBuddy') { Split-Path $t -Parent } }"
    const output = execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], {
      encoding: 'utf8',
      timeout: 12000,
      windowsHide: true,
    })
    for (const line of output.split(/\r?\n/)) if (line.trim() !== '') roots.push(line.trim())
  } catch {
    /* no shortcuts or PowerShell blocked; harmless */
  }
  return roots
}

function processRoots() {
  const roots = []
  try {
    const output = execFileSync(
      'powershell',
      ['-NoProfile', '-NonInteractive', '-Command', "[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; Get-Process -Name WorkBuddyAI,WorkBuddy,CodeBuddy -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Path"],
      { encoding: 'utf8', timeout: 8000, windowsHide: true },
    )
    for (const line of output.split(/\r?\n/)) if (line.trim() !== '') roots.push(dirname(line.trim()))
  } catch {
    /* not running */
  }
  return roots
}

function commonRoots() {
  const env = process.env
  return [
    join(env.LOCALAPPDATA ?? '', 'Programs', 'WorkBuddy'),
    join(env.LOCALAPPDATA ?? '', 'Programs', 'WorkBuddyAI'),
    join(env.PROGRAMFILES ?? '', 'WorkBuddy'),
    join(env['PROGRAMFILES(X86)'] ?? '', 'WorkBuddy'),
    join(env.ProgramW6432 ?? '', 'WorkBuddy'),
  ].filter((path) => path !== '')
}

let discovered = null

/** Every candidate, with where it came from — the UI shows the reason, not just a path. */
export function discoverWorkBuddyCli({ refresh = false } = {}) {
  if (discovered && !refresh) return discovered
  const explicit = String(process.env.CCCN_CBC_CLI ?? process.env.CODEBUDDY_CLI ?? '').trim()
  // An explicit override is a statement of intent: if it points nowhere, say so instead of quietly using a
  // different install, which would make a misconfigured path look like a working one.
  if (explicit !== '') {
    discovered = existsSync(explicit)
      ? { cli: explicit, source: 'env', tried: [`env:${explicit}`] }
      : { cli: null, source: 'env', tried: [`env:${explicit}`], error: `CCCN_CBC_CLI 指向的文件不存在：${explicit}` }
    return discovered
  }
  const groups = [
    ['env', explicit === '' ? [] : [explicit]],
    ['registry', registryRoots().flatMap(fromRoot)],
    ['shortcut', shortcutRoots().flatMap(fromRoot)],
    ['common', commonRoots().flatMap(fromRoot)],
    ['process', processRoots().flatMap(fromRoot)],
  ]
  const tried = []
  for (const [source, candidates] of groups) {
    for (const candidate of candidates) {
      if (!candidate) continue
      if (tried.length < 30) tried.push(`${source}:${candidate}`)
      if (existsSync(candidate)) {
        discovered = { cli: candidate, source, tried }
        return discovered
      }
    }
  }
  discovered = { cli: null, source: null, tried }
  return discovered
}

function locateCli() {
  return discoverWorkBuddyCli().cli
}

/** 上一次 `testCli` 的结果。「没有 status 子命令」时，这是唯一诚实的登录信号。 */
/** 本机保存的 WorkBuddy token（用户粘贴的个人令牌）。文件权限靠数据目录本身，不写入日志。 */
function readToken() {
  try {
    const parsed = JSON.parse(readFileSync(dataFile('workbuddy-token.json'), 'utf8'))
    return typeof parsed?.token === 'string' && parsed.token !== '' ? parsed.token : null
  } catch {
    return null
  }
}

/** 保存令牌并立刻用它跑一次真实请求；返回结果，避免「保存成功但根本没登录」。 */
export async function setToken({ token } = {}) {
  const value = String(token ?? '').trim()
  if (value === '') return { ok: false, error: '令牌为空' }
  writeFileSync(dataFile('workbuddy-token.json'), `${JSON.stringify({ token: value, at: Date.now() })}\n`, 'utf8')
  const answer = await askWorkBuddy({ prompt: '这是连接测试，只回复 OK 两个字。', timeoutMs: 120000 })
  recordTest(answer)
  return answer.ok
    ? { ok: true, text: answer.text, hint: '令牌有效，WorkBuddy 路由已可用。' }
    : { ok: false, code: answer.code, error: answer.error, hint: '令牌已保存，但请求失败：请确认它没有过期。' }
}

export function tokenStatus() {
  const stored = readToken()
  if (stored) return { hasToken: true, tokenSource: 'stored', tokenHint: `${stored.slice(0, 4)}…${stored.slice(-2)}` }
  const desktop = readDesktopToken()
  if (desktop.token) return { hasToken: true, tokenSource: 'desktop', tokenHint: `${desktop.token.slice(0, 4)}…${desktop.token.slice(-2)}` }
  // 加密但存在：说明已登录，只是需要按插件的方式解密。UI 要区分「未登录」与「登录了但读不到」。
  return { hasToken: false, tokenSource: desktop.encrypted ? 'encrypted' : null, tokenHint: null }
}

function readLastTest() {
  try {
    const parsed = JSON.parse(readFileSync(dataFile('cli-status.json'), 'utf8'))
    return typeof parsed?.at === 'number' ? parsed : null
  } catch {
    return null
  }
}

function recordTest(result) {
  try {
    writeFileSync(dataFile('cli-status.json'), `${JSON.stringify({ at: Date.now(), ok: result.ok === true, code: result.code ?? null })}\n`, 'utf8')
  } catch {
    /* 记录失败不影响这次测试本身 */
  }
}

/** Public status: where the CLI is, how it was found, and whether a prompt would need a login first. */
export function workbuddyStatus() {
  const { cli, source } = discoverWorkBuddyCli()
  const lastTest = readLastTest()
  return {
    ok: true,
    available: cli !== null,
    cli,
    source,
    loginCommand: cli ? `${JSON.stringify(process.execPath)} ${JSON.stringify(cli)}` : null,
    /**
     * 上一次「测试连接」的结果。
     *
     * WHY NOT A LIVE LOGIN CHECK: the CLI has no `status` subcommand, `doctor` answers
     * "No mapping found", and `~/.codebuddy` carries no plaintext credential to inspect. Probing by
     * starting a real `-p` call would spend a model call every time the settings page opens. So the card
     * shows the last EXPLICIT test and says so — an honest timestamp instead of a guessed badge.
     */
    lastTest,
    ...tokenStatus(),
    hint: cli
      ? '首次使用需要在该 CLI 里登录一次：点下面的「打开 CLI 登录窗口」，输入 /login。'
      : '没有找到 CodeBuddy CLI。请安装 WorkBuddy 桌面端，或设置 CCCN_CBC_CLI 指向 codebuddy-lite-wb.mjs。',
  }
}

/** Flatten an Anthropic request into one prompt. The CLI has no message array of its own. */
export function flattenRequest(body) {
  const lines = []
  const system = body?.system
  if (typeof system === 'string' && system.trim() !== '') lines.push(`System:\n${system.trim()}`)
  for (const message of Array.isArray(body?.messages) ? body.messages : []) {
    const role = message?.role === 'assistant' ? 'Assistant' : 'User'
    const parts = Array.isArray(message?.content) ? message.content : [{ type: 'text', text: String(message?.content ?? '') }]
    const text = parts
      .map((part) => (part?.type === 'text' ? String(part.text ?? '') : part?.type === 'tool_result' ? String(part.content ?? '') : ''))
      .filter((entry) => entry !== '')
      .join('\n')
    if (text !== '') lines.push(`${role}:\n${text}`)
  }
  return lines.join('\n\n')
}

/**
 * One CLI call.
 *
 * `--tools ""` keeps it read-only: this bridge is a model channel, and letting an unattended CLI edit
 * files in the middle of a chat turn is a different product with different consent.
 */
export function askWorkBuddy({ prompt, cwd, timeoutMs, cliPath } = {}) {
  const cli = String(cliPath ?? locateCli() ?? '')
  if (cli === '') return Promise.resolve({ ok: false, code: 'no-cli', error: '没有找到 CodeBuddy CLI' })
  const text = String(prompt ?? '').trim()
  if (text === '') return Promise.resolve({ ok: false, error: '请求里没有可发送的文本' })

  const limit = Math.min(Math.max(Number(timeoutMs) || DEFAULT_TIMEOUT_MS, 5000), 600000)
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [cli, '-p', text, '--output-format', 'json', '--permission-mode', 'dontAsk', '--tools', ''],
      {
        cwd: cwd && existsSync(cwd) ? cwd : undefined,
        timeout: limit,
        windowsHide: true,
        shell: false,
        maxBuffer: MAX_OUTPUT_BYTES,
        env: { ...process.env, CODEBUDDY_SKIP_GIT_BASH_CHECK: '1', ...(readToken() ? { CODEBUDDY_AUTH_TOKEN: readToken() } : {}) },
      },
      (error, stdout, stderr) => {
        const out = String(stdout ?? '')
        const err = String(stderr ?? '')
        // MEASURED: this CLI exits 0 and writes "Authentication required" to stderr, so an exit-code-only
        // check would report success with an empty answer. The stderr text is the real signal.
        if (/Authentication required/i.test(err + out)) {
          return resolve({ ok: false, code: 'unauthenticated', error: 'CodeBuddy CLI 还没有登录：运行 CLI 后输入 /login。' })
        }
        if (error) {
          if (error.killed) return resolve({ ok: false, code: 'timeout', error: `CLI 超时（${Math.round(limit / 1000)} 秒）` })
          return resolve({ ok: false, code: 'failed', error: err.trim().split('\n')[0] || 'CLI 执行失败' })
        }
        // `--output-format json` prints one JSON document; fall back to raw text if it ever does not.
        try {
          const parsed = JSON.parse(out)
          const answer = String(parsed?.result ?? parsed?.response ?? parsed?.text ?? '')
          if (answer.trim() === '') {
            return resolve({ ok: false, code: 'empty', error: err.trim().split('\n')[0] || 'CLI 没有返回内容' })
          }
          return resolve({ ok: true, text: answer, raw: parsed })
        } catch {
          const text = out.trim()
          if (text === '') return resolve({ ok: false, code: 'empty', error: err.trim().split('\n')[0] || 'CLI 没有返回内容' })
          return resolve({ ok: true, text })
        }
      },
    )
  })
}

function estimateTokens(text) {
  // Rough and deliberately conservative: the CLI does not report usage back, and a fabricated precise
  // count would be worse than an approximation that only feeds the cost display.
  return Math.max(1, Math.round(String(text).length / 3))
}

/** Wrap a CLI answer in the Anthropic Messages response shape. */
export function toAnthropicResponse({ text, model = 'workbuddy-cli' } = {}) {
  return {
    id: `msg_wb_${Date.now().toString(36)}`,
    type: 'message',
    role: 'assistant',
    model,
    content: [{ type: 'text', text: String(text ?? '') }],
    stop_reason: 'end_turn',
    stop_sequence: null,
    usage: { input_tokens: estimateTokens(''), output_tokens: estimateTokens(text) },
  }
}

/** The same answer as an Anthropic SSE stream: `claude.exe` asks for `stream: true`. */export function toAnthropicSse({ text, model = 'workbuddy-cli' } = {}) {
  const id = `msg_wb_${Date.now().toString(36)}`
  const events = [
    ['message_start', { type: 'message_start', message: { id, type: 'message', role: 'assistant', model, content: [], stop_reason: null, usage: { input_tokens: 0, output_tokens: 0 } } }],
    ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }],
    ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: String(text ?? '') } }],
    ['content_block_stop', { type: 'content_block_stop', index: 0 }],
    ['message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: estimateTokens(text) } }],
    ['message_stop', { type: 'message_stop' }],
  ]
  return events.map(([event, payload]) => `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`).join('')
}

/**
 * Open the CLI in a real console window so the user can type `/login`.
 *
 * WHY A VISIBLE WINDOW: the CLI's login is an interactive slash command; there is no flag for it. Driving
 * an interactive TUI through pipes would hang, so the honest flow is: open the console, let the human type
 * `/login`, then come back and press 测试连接.
 */
export function openCliLogin() {
  const status = workbuddyStatus()
  if (!status.available) return { ok: false, error: status.hint }
  if (process.platform !== 'win32') {
    return { ok: false, error: `请手动运行：node ${JSON.stringify(status.cli)}，然后输入 /login` }
  }
  try {
    // 隐藏控制台：CLI 自己在终端里等待 /login，但弹黑窗口对普通用户是惊吓而不是帮助。
    // 保留 stdio: ignore —— 登录交互由 CLI 内部完成，桥不需要读它的输出。
    // 必须给一个可见的终端：该 CLI 的登录是交互式 /login，隐藏窗口只会让用户以为「没反应」。
    spawn('cmd', ['/c', 'start', 'WorkBuddy 登录：输入 /login', process.execPath, JSON.stringify(status.cli)], {
      detached: true,
      stdio: 'ignore',
      windowsHide: false,
    }).unref()
    return { ok: true, hint: '已打开一个终端窗口：在里面输入 /login 完成登录，然后回到这里点「测试 CLI 连接」。' }
  } catch (error) {
    return { ok: false, error: `打开窗口失败：${String(error?.message ?? error)}` }
  }
}

/**
 * A one-shot connectivity check for the settings UI.
 *
 * It really calls the CLI (that is the only way to tell "logged in" from "not"), so it is a manual button
 * rather than something the panel runs on open: an automatic probe would spend a model call every time
 * someone looked at the settings page.
 */
export async function testCli() {
  const status = workbuddyStatus()
  if (!status.available) return { ok: false, code: 'no-cli', error: status.hint }
  const answer = await askWorkBuddy({ prompt: '这是连接测试，只回复 OK 两个字。', timeoutMs: 120000 })
  recordTest(answer)
  if (!answer.ok) return { ok: false, code: answer.code, error: answer.error }
  return { ok: true, text: answer.text, baseUrlHint: 'http://127.0.0.1:43130/proxy/workbuddy' }
}

/**
 * 真实模型清单：WorkBuddy AI 的 `/v3/config`。
 *
 * TRANSCRIBED FROM THE DSH PLUGIN (dsh-workbuddy-connect 0.6.5): the App-shaped document is served only
 * when the User-Agent carries the product name in the terse form `WorkBuddyAI/<version>`; the spaced form
 * was measured to be rejected (HTTP 400 / code 12403). Not guessing — the plugin records both measurements.
 */
export async function fetchWorkbuddyCatalog({ token, appVersion, host = 'https://www.workbuddy.ai' } = {}) {
  const base = String(host).replace(/\/+$/, '')
  const secret = String(token ?? readToken() ?? readDesktopToken().token ?? '').trim()
  if (secret === '') return { ok: false, code: 'no-token', error: '需要先保存 WorkBuddy 令牌' }
  const version = String(appVersion ?? process.env.WORKBUDDY_APP_VERSION ?? '5.8.4').trim()
  try {
    const response = await fetch(`${base}/v3/config`, {
      headers: {
        authorization: `Bearer ${secret}`,
        'user-agent': `WorkBuddyAI/${version}`,
        accept: 'application/json',
      },
      signal: AbortSignal.timeout(20000),
    })
    const text = await response.text()
    if (!response.ok) {
      return { ok: false, code: response.status === 401 ? 'unauthenticated' : 'failed', error: `WorkBuddy 返回 HTTP ${response.status}：${text.slice(0, 200)}` }
    }
    let payload = null
    try {
      payload = JSON.parse(text)
    } catch {
      return { ok: false, code: 'bad-json', error: '响应不是 JSON' }
    }
    return { ok: true, payload }
  } catch (error) {
    return { ok: false, code: 'network', error: `连不上 ${base}：${String(error?.message ?? error)}` }
  }
}

/** CodeBuddy 国内版：同一个桌面令牌，换一个上游域名。 */
export async function fetchCodebuddyCatalog(options = {}) {
  const host = String(process.env.CCCN_CODEBUDDY_HOST ?? '').trim() || 'https://copilot.tencent.com'
  return fetchWorkbuddyCatalog({ ...options, host })
}

/**
 * 直接读桌面端的登录令牌。
 *
 * MEASURED on this machine: WorkBuddy 5.8.4 keeps `auth.accessToken` as a PLAINTEXT JWT in
 * `%LOCALAPPDATA%\CodeBuddyExtension\Data\Public\auth\workbuddy-desktop.info` (1339 chars). Newer builds may
 * wrap it in `{$wbEncrypted:1, envelope}` (AES-256-GCM, key from the app's own `electron_browser_workbuddy_storage`
 * binding) — callers must treat "no plaintext token" as "needs decryption", never as "not logged in".
 */
function desktopAuthCandidates() {
  const env = process.env
  return [
    join(env.LOCALAPPDATA ?? '', 'CodeBuddyExtension', 'Data', 'Public', 'auth', 'workbuddy-desktop.info'),
    join(env.LOCALAPPDATA ?? '', 'WorkBuddyAI', 'Data', 'Public', 'auth', 'workbuddy-desktop.info'),
    join(env.APPDATA ?? '', 'CodeBuddyExtension', 'Data', 'Public', 'auth', 'workbuddy-desktop.info'),
  ].filter((path) => path !== '')
}

export function readDesktopToken() {
  for (const file of desktopAuthCandidates()) {
    if (!existsSync(file)) continue
    try {
      const parsed = JSON.parse(readFileSync(file, 'utf8'))
      const token = parsed?.auth?.accessToken
      if (typeof token === 'string' && token.length > 20) {
        return { token, file, encrypted: false, expiresAt: Number(parsed?.auth?.expiresAt) || null }
      }
      if (token && typeof token === 'object' && token.wbEncrypted === 1) {
        return { token: null, file, encrypted: true, expiresAt: Number(parsed?.auth?.expiresAt) || null }
      }
    } catch {
      /* 下一处候选 */
    }
  }
  return { token: null, file: null, encrypted: false, expiresAt: null }
}
