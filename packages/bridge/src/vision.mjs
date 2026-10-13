/**
 * Image understanding: one image in, structured JSON evidence out, backed by the vendored
 * `@liustack/modlens` CLI.
 *
 * WHY THE CLI IS SPAWNED AND NEVER IMPORTED
 *
 * The upstream package is DSH-bound at its plugin surface (`dsh/index.js` pulls in the Cordis
 * runtime), but its CLI entry is an ordinary Node program with two dependencies. Importing it would
 * graft a third-party graph onto the bridge and turn a provider crash into a bridge crash; spawning
 * costs one process per image and keeps the blast radius at one child. It also keeps the bridge
 * dependency-free: the CLI resolves `commander`/`undici` relative to its own directory, which is
 * exactly how the sidecar stages it (see packages/desktop/scripts/prepare-sidecar.mjs).
 *
 * WHY A PREFLIGHT INSTEAD OF "JUST TRY THE READ"
 *
 * A read spends the user's quota and takes tens of seconds, so the window has to be able to say what
 * state the machine is in BEFORE the button is pressed. `visionStatus` therefore runs the CLI's own
 * `doctor --json`, which upstream documents as spending no quota and making no network request —
 * a preflight that could itself bill the user would be worse than none.
 *
 * WHAT WAS MEASURED AGAINST THE VENDORED BUILD (v3.26.5, the copy in vendor/skills/modlens):
 *   - `node dist/main.js doctor --json` exits 0 and prints the full report on stdout; on a machine
 *     with nothing configured every entry of `providers[]` is `ready: false` and both `chains.local`
 *     and `chains.remote` are empty. `selection.provider` is still named (the built-in default,
 *     `antigravity-cli`), so selection alone must NOT be read as availability.
 *   - `node dist/main.js -i <img>` with no provider exits 1, writes
 *     `Error: No vision provider is set up on this machine. ...` to STDERR and NOTHING to stdout.
 *   - `-i` on a missing path exits 1 with `Error: Input image not found: <path>`; on a directory,
 *     `Error: Input is not a file: <path>`; on a relative path it resolves against its own cwd
 *     rather than refusing — which is why this module requires an absolute path instead of trusting
 *     the CLI to complain.
 *   - The CLI validates the path and the EXTENSION but not the bytes: a text file renamed to `.png`
 *     is accepted and sent to the provider. Twelve bytes of signature check here is cheaper than a
 *     billed hallucination (`imageContentProblem` below).
 *   - On success stdout is exactly one JSON document: `{ image, provider, result, meta }`, with
 *     `result.{summary,ocr,layout,semantics,visual,uncertainty}`. Providers are lazy, so no bytes
 *     are read from the image before the provider is chosen (`dist/main.js` resolveInput).
 *
 * Every export returns a plain object and never throws: the HTTP layer passes these values straight
 * through, and a rejected promise there would become an unhandled rejection instead of a sentence
 * the user can act on.
 */
import { execFile } from 'node:child_process'
import { closeSync, existsSync, openSync, readFileSync, readSync, readdirSync, statSync } from 'node:fs'
import { extname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/** The CLI entry inside a skill directory; mirrors `package.json#bin` of the vendored package. */
const CLI_ENTRY = join('dist', 'main.js')

/** Extensions the picker offers and the reader accepts — the set modlens itself documents. */
const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp'])

/**
 * File-signature table for the content check.
 *
 * Only the fixed-prefix formats live here; WEBP is a RIFF container whose signature sits at byte 8,
 * so it is checked by hand in `imageContentProblem`.
 */
const IMAGE_SIGNATURES = [
  ['.png', [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]],
  ['.jpg', [0xff, 0xd8, 0xff]],
  ['.jpeg', [0xff, 0xd8, 0xff]],
  ['.gif', [0x47, 0x49, 0x46, 0x38]],
  ['.bmp', [0x42, 0x4d]],
]

/** A provider that runs away must cost memory, not the app: the child is cut off at this much. */
const STDOUT_CAP_BYTES = 2 * 1024 * 1024

/** What is handed back to the UI. The buffer cap above is a guard; these keep the JSON small. */
const RAW_CAP_CHARS = 20000
const STDERR_CAP_CHARS = 1000
const REASON_CAP_CHARS = 500
const HINT_CAP_CHARS = 500
const FOCUS_CAP_CHARS = 500

const DEFAULT_READ_TIMEOUT_MS = 120000
const DEFAULT_DOCTOR_TIMEOUT_MS = 20000

/**
 * Bounds for a caller-supplied read timeout.
 *
 * A floor because everything below a couple of seconds fails on a healthy provider and would read as
 * "broken"; a ceiling because the point of a timeout is that the window comes back at all.
 */
const MIN_TIMEOUT_MS = 5000
const MAX_TIMEOUT_MS = 600000

/**
 * Extra wall-clock allowed on top of the CLI's own provider timeout.
 *
 * `--timeout` is passed through to the provider so a hang is reported by modlens with the provider's
 * name; this margin is only for the case where modlens itself is stuck (a wedged subprocess engine),
 * and it must stay small enough that the window does not look frozen.
 */
const KILL_GRACE_MS = 5000

const DEFAULT_IMAGE_LIMIT = 200
const MAX_IMAGE_LIMIT = 1000

/** The module's own directory, used to resolve the in-repo layouts without touching the disk. */
const SRC_DIR = resolve(fileURLToPath(import.meta.url), '..')
/** Repo root in a checkout; the resource directory's parent in a packaged install. */
const THREE_UP = resolve(SRC_DIR, '..', '..', '..')
/** `<sidecar>/` in a packaged install; `packages/bridge/` in a checkout. */
const ONE_UP = resolve(SRC_DIR, '..')

/** The skill's own directory name, as it is staged under `.claude/skills/`. */
const SKILL_DIR = 'modlens'

/** Trim, clamp and keep a string's last N characters — stderr tails are read from the end. */
function tail(text, limit) {
  const trimmed = typeof text === 'string' ? text.trim() : ''
  return trimmed.length > limit ? trimmed.slice(trimmed.length - limit) : trimmed
}

/** Clamp a caller-supplied timeout into something that cannot hang the window. */
function clampTimeout(value, fallback) {
  const numeric = Number(value)
  if (!Number.isFinite(numeric) || numeric <= 0) return fallback
  return Math.min(Math.max(Math.round(numeric), MIN_TIMEOUT_MS), MAX_TIMEOUT_MS)
}

/**
 * Run one child process and always settle with a shape instead of throwing.
 *
 * `timeout` + `maxBuffer` are the two guards that matter here: without the first a wedged provider
 * holds the HTTP request open until the webview gives up, and without the second a chatty provider
 * grows the bridge's heap by however much it likes. Both surface as distinct error codes, which is
 * what lets the callers below tell "timed out" from "exited non-zero" from "printed too much".
 */
function runCli(file, args, timeoutMs) {
  return new Promise((settle) => {
    const started = Date.now()
    const done = (error, stdout, stderr) => {
      const failed = error ?? null
      settle({
        error: failed,
        stdout: typeof stdout === 'string' ? stdout : '',
        stderr: typeof stderr === 'string' ? stderr : '',
        durationMs: Date.now() - started,
        // execFile kills on timeout and reports it as a signal with no exit code; a non-zero exit
        // always carries the code instead.
        timedOut: Boolean(failed && (failed.killed === true || (failed.signal != null && failed.code == null))),
        overflowed: Boolean(failed && failed.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER'),
      })
    }
    try {
      execFile(
        file,
        args,
        { timeout: timeoutMs, maxBuffer: STDOUT_CAP_BYTES, windowsHide: true, encoding: 'utf8', env: process.env },
        done,
      )
    } catch (problem) {
      // Only reachable for a malformed call (bad argv type); a missing binary arrives as ENOENT in
      // the callback instead. Either way the caller sees a result, never an exception.
      done(problem, '', '')
    }
  })
}

/**
 * Find the CLI, most specific location first.
 *
 * The order encodes what each layout means: an explicit `skillsRoot` is the running install and wins;
 * the env override is the same install named from outside; then the two in-repo copies, so a
 * development checkout works with no configuration. Returning the SOURCE alongside the path is
 * deliberate — "modlens 未找到" is unactionable, while "modlens 未找到（期望在 packages/desktop/...）"
 * names the file that is missing.
 *
 * Both spellings of `skillsRoot` are accepted because the bridge already calls the skills directory
 * itself `skillsRoot` (`<sidecar>/skills`) while the installer calls the staging root that
 * (`<sidecar>`). Tolerating the ambiguity costs one `existsSync` and turns a mis-wired caller into a
 * working window instead of a permanent "未找到 modlens".
 */
function locateCli(skillsRoot) {
  const candidates = []
  const root = typeof skillsRoot === 'string' && skillsRoot.trim() !== '' ? resolve(skillsRoot.trim()) : null

  if (root) {
    candidates.push({
      path: join(root, 'skills', '.claude', 'skills', SKILL_DIR, CLI_ENTRY),
      source: '参数 skillsRoot（sidecar 根）',
    })
    candidates.push({
      path: join(root, '.claude', 'skills', SKILL_DIR, CLI_ENTRY),
      source: '参数 skillsRoot（技能根）',
    })
  }
  const envRoot = process.env.CCCN_SIDECAR_DIR
  if (typeof envRoot === 'string' && envRoot.trim() !== '') {
    candidates.push({
      path: join(resolve(envRoot.trim()), 'skills', '.claude', 'skills', SKILL_DIR, CLI_ENTRY),
      source: 'CCCN_SIDECAR_DIR',
    })
  }
  // Development checkout: the vendored source of truth.
  candidates.push({
    path: join(THREE_UP, 'vendor', 'skills', SKILL_DIR, CLI_ENTRY),
    source: '仓库内 vendor/skills/modlens',
  })
  // Development checkout: the copy the installer stages, byte-identical but the one that ships.
  candidates.push({
    path: join(THREE_UP, 'packages', 'desktop', 'src-tauri', 'resources', 'sidecar', 'skills', '.claude', 'skills', SKILL_DIR, CLI_ENTRY),
    source: '仓库内已打包的 sidecar',
  })
  candidates.push({
    path: join(THREE_UP, 'resources', 'sidecar', 'skills', '.claude', 'skills', SKILL_DIR, CLI_ENTRY),
    source: '打包布局 resources/sidecar',
  })
  // Packaged install: bridge/ sits beside skills/ under the sidecar root.
  candidates.push({
    path: join(ONE_UP, 'skills', '.claude', 'skills', SKILL_DIR, CLI_ENTRY),
    source: 'sidecar 同级目录',
  })

  for (const candidate of candidates) {
    try {
      if (existsSync(candidate.path)) return candidate
    } catch {
      /* an unreadable parent is simply not a candidate */
    }
  }
  return null
}

/**
 * The Node runtime to run the CLI with.
 *
 * The bundled `node.exe` is preferred over `process.execPath` because the CLI needs >= 22.19 and the
 * sidecar ships a runtime that satisfies it, while a packaged app cannot assume the machine has any
 * Node at all. `process.execPath` stays as the last resort so a development checkout — where no
 * sidecar has been staged yet — still works.
 */
function locateNode(skillsRoot) {
  const names = ['node.exe', 'node']
  const dirs = []
  const root = typeof skillsRoot === 'string' && skillsRoot.trim() !== '' ? resolve(skillsRoot.trim()) : null
  const envRoot = process.env.CCCN_SIDECAR_DIR
  if (typeof envRoot === 'string' && envRoot.trim() !== '') dirs.push(resolve(envRoot.trim()))
  if (root) {
    dirs.push(root)
    // `<sidecar>/skills` -> the runtime sits one level up.
    dirs.push(resolve(root, '..'))
  }
  dirs.push(ONE_UP)
  dirs.push(join(THREE_UP, 'packages', 'desktop', 'src-tauri', 'resources', 'sidecar'))
  dirs.push(join(THREE_UP, 'resources', 'sidecar'))

  for (const dir of dirs) {
    for (const name of names) {
      const candidate = join(dir, name)
      try {
        if (existsSync(candidate)) return candidate
      } catch {
        /* not a candidate */
      }
    }
  }
  return process.execPath
}

/**
 * The CLI's version, read from the manifest beside it.
 *
 * Chosen over `--version` because this runs on every status poll: the string is already on disk, and
 * a second process spawn for it would be pure latency. A missing or unreadable manifest degrades to
 * `null` rather than failing the status — the version is a caption, not a capability.
 */
function readCliVersion(cliPath) {
  try {
    const manifest = JSON.parse(readFileSync(resolve(cliPath, '..', '..', 'package.json'), 'utf8'))
    return typeof manifest?.version === 'string' ? manifest.version : null
  } catch {
    return null
  }
}

/**
 * Does this file actually contain an image?
 *
 * Returns a Chinese problem sentence, or null when the bytes match the extension. The CLI checks the
 * extension only, so without this a renamed `.txt` is uploaded to a paid provider and comes back as
 * a confident description of nothing.
 */
function imageContentProblem(file) {
  let handle
  try {
    handle = openSync(file, 'r')
  } catch (problem) {
    return `无法读取图片：${String(problem?.message ?? problem)}`
  }
  try {
    const head = Buffer.alloc(12)
    const read = readSync(handle, head, 0, head.length, 0)
    if (read < 4) return '文件内容为空或过短，不像图片'
    const extension = extname(file).toLowerCase()
    if (extension === '.webp') {
      const riff = head.subarray(0, 4).toString('latin1') === 'RIFF'
      const webp = head.subarray(8, 12).toString('latin1') === 'WEBP'
      return riff && webp ? null : '文件内容不像图片：扩展名是 .webp，但文件头不是 RIFF/WEBP'
    }
    const signature = IMAGE_SIGNATURES.find(([ext]) => ext === extension)
    if (!signature) return null
    const expected = signature[1]
    if (read < expected.length) return '文件内容为空或过短，不像图片'
    const matches = expected.every((byte, index) => head[index] === byte)
    return matches ? null : `文件内容不像图片：扩展名是 ${extension}，但文件头与图片格式不符`
  } finally {
    try {
      closeSync(handle)
    } catch {
      /* already closed */
    }
  }
}

/**
 * Validate what the user typed before it reaches the CLI or a provider.
 *
 * Written as one function so the picker and the reader cannot disagree about what "a valid image
 * path" is. `@returns {{path: string}|{error: string}}`.
 */
function validateImagePath(raw) {
  if (raw === '') return { error: '图片路径为空：请先在左侧选择一个图片文件' }
  if (!isAbsolute(raw)) return { error: `图片路径必须是绝对路径：${raw}` }
  let stats
  try {
    stats = statSync(raw)
  } catch {
    return { error: `图片不存在：${raw}` }
  }
  if (stats.isDirectory()) return { error: `这是一个目录，不是图片文件：${raw}` }
  if (!stats.isFile()) return { error: `不是普通文件：${raw}` }
  const extension = extname(raw).toLowerCase()
  if (!IMAGE_EXTENSIONS.has(extension)) {
    return { error: `不支持的图片格式（支持 png/jpg/jpeg/webp/gif/bmp）：${raw}` }
  }
  const contentProblem = imageContentProblem(raw)
  if (contentProblem) return { error: `${contentProblem}：${raw}` }
  return { path: raw }
}

/**
 * Turn modlens' stderr into one Chinese sentence naming the cause.
 *
 * Every message the CLI writes is English and most are long; the panel cannot show them raw. The
 * patterns are the CLI's own wording, measured against v3.26.5, and the fallback keeps the exit code
 * so an unrecognised failure is still diagnosable rather than vague.
 */
function classifyCliFailure(stderr) {
  const text = typeof stderr === 'string' ? stderr : ''
  if (/No vision provider is set up on this machine/i.test(text)) {
    return '缺少视觉 provider：modlens 报告本机没有任何可用的视觉通道（Antigravity CLI / Gemini API key / OpenAI 兼容端点 / Claude 都未配置）'
  }
  if (/Invocation guard denied/i.test(text)) {
    return '被 modlens 的调用防护拒绝：当前模型按规则应当自己读图，不再走视觉桥'
  }
  if (/timed out after/i.test(text)) {
    return 'vision provider 超时：模型没有在限定时间内返回结果'
  }
  if (/does not match the vision schema/i.test(text)) {
    return 'provider 返回的内容不符合证据结构：模型没有按约定输出 JSON 证据'
  }
  if (/Every configured vision provider failed/i.test(text)) {
    return '所有候选 provider 都失败了：具体错误见下面的 stderr'
  }
  if (/Input image not found/i.test(text)) {
    return '图片不存在：modlens 找不到这个文件（可能已被移动或删除）'
  }
  if (/Input is not a file/i.test(text)) {
    return '不是文件：这个路径指向的是目录'
  }
  return ''
}

/**
 * Whether image understanding can run on this machine, and why not when it cannot.
 *
 * Never rejects. `ok` means the probe produced a trustworthy verdict; `available` means a read would
 * actually work. The three "cannot" states are kept apart on purpose, because they need three
 * different user actions: no CLI file (rebuild/reinstall), CLI present but the probe broke (report a
 * bug), and CLI healthy with no vision provider (configure a key or a CLI login).
 *
 * @param {{skillsRoot?: string}} [options] The installer's sidecar root, when the caller knows it.
 * @returns {Promise<{ok: boolean, available: boolean, cli: string|null, cliSource?: string|null,
 *   version?: string|null, node?: string, provider?: string|null, reason?: string|null,
 *   hint?: string|null}>}
 */
export async function visionStatus(options = {}) {
  const skillsRoot = options?.skillsRoot
  let located = null
  try {
    located = locateCli(skillsRoot)
  } catch {
    located = null
  }

  if (!located) {
    return {
      ok: true,
      available: false,
      cli: null,
      cliSource: null,
      version: null,
      node: null,
      provider: null,
      reason: '未找到 modlens CLI：随包技能里没有 dist/main.js',
      hint: '构建时运行 packages/desktop/scripts/prepare-sidecar.mjs 把 vendor/skills/modlens 打进 sidecar（开发环境请确认 vendor/skills/modlens/dist/main.js 存在）。',
    }
  }

  const version = readCliVersion(located.path)
  const node = locateNode(skillsRoot)
  const run = await runCli(node, [located.path, 'doctor', '--json'], DEFAULT_DOCTOR_TIMEOUT_MS)
  const base = {
    cli: located.path,
    cliSource: located.source,
    version,
    node,
  }
  const stderrTail = tail(run.stderr, STDERR_CAP_CHARS)

  // Parsed before the exit code is judged: doctor can exit non-zero over a config-file permission
  // warning while still printing a complete, usable report, and reporting "doctor 失败" for that
  // would hide the real state.
  let doctor = null
  try {
    doctor = JSON.parse(run.stdout)
  } catch {
    doctor = null
  }

  if (!doctor || typeof doctor !== 'object') {
    const spawnedButSilent = run.error && run.stdout.trim() === ''
    const reason = run.timedOut
      ? `modlens doctor 超时（${DEFAULT_DOCTOR_TIMEOUT_MS}ms 内没有返回）`
      : run.overflowed
        ? `modlens doctor 输出超过 ${Math.round(STDOUT_CAP_BYTES / 1024 / 1024)} MB 上限`
        : spawnedButSilent
          ? `modlens doctor 启动失败：${String(run.error?.message ?? run.error)}`
          : 'modlens doctor 没有返回可解析的 JSON（CLI 版本不匹配或运行环境异常）'
    return {
      ...base,
      ok: false,
      available: false,
      provider: null,
      reason: tail(reason, REASON_CAP_CHARS),
      hint: stderrTail || null,
    }
  }

  const providers = Array.isArray(doctor.providers) ? doctor.providers : []
  const ready = providers.filter((provider) => provider && provider.ready === true)
  const localChain = Array.isArray(doctor.chains?.local)
    ? doctor.chains.local.filter((name) => typeof name === 'string')
    : []
  const remoteChain = Array.isArray(doctor.chains?.remote)
    ? doctor.chains.remote.filter((name) => typeof name === 'string')
    : []
  const selected =
    typeof doctor.selection?.canonical === 'string'
      ? doctor.selection.canonical
      : typeof doctor.selection?.provider === 'string'
        ? doctor.selection.provider
        : null

  // The chains are what a run would actually use; `selection` alone is not evidence of anything,
  // since it names the built-in default even on a machine with no provider at all.
  const chain = localChain.length > 0 ? localChain : remoteChain
  const available = chain.length > 0 || ready.length > 0
  if (available) {
    const provider = typeof ready[0]?.name === 'string' ? ready[0].name : (chain[0] ?? selected)
    return {
      ...base,
      ok: true,
      available: true,
      provider: provider ?? null,
      reason: null,
      hint: null,
    }
  }

  const missing = providers
    .filter((provider) => provider && provider.ready !== true)
    .slice(0, 3)
    .map((provider) => `${provider.name}: ${typeof provider.detail === 'string' ? provider.detail : '未就绪'}`)
  const fixes = providers
    .filter((provider) => provider && provider.ready !== true && typeof provider.fix === 'string')
    .slice(0, 2)
    .map((provider) => provider.fix)

  return {
    ...base,
    ok: true,
    available: false,
    provider: null,
    reason: tail(
      `缺少视觉 provider：本机没有任何能读图的通道${missing.length > 0 ? `（${missing.join('；')}）` : ''}`,
      REASON_CAP_CHARS,
    ),
    // The doctor's own fix commands, not a paraphrase: they are exact, and hardcoding upstream advice
    // here would rot the moment the CLI changes its setup steps.
    hint: tail(
      fixes.length > 0
        ? `可执行的修复命令（来自 modlens doctor）：${fixes.join('　')}`
        : '运行 modlens doctor 查看缺什么，再配置一个视觉 provider。',
      HINT_CAP_CHARS,
    ),
  }
}

/**
 * Read one image into structured evidence.
 *
 * Never rejects and never throws. The four failures that matter are told apart — no CLI, no
 * provider, timeout, non-zero exit, unparseable output — because each needs a different action, and
 * a single "读取失败" would make the user guess which one they are in.
 *
 * @param {{skillsRoot?: string, path?: string, focus?: string, timeoutMs?: number}} [options]
 * @returns {Promise<{ok: boolean, evidence: object|null, raw: string, stderr?: string,
 *   durationMs: number, error?: string}>}
 */
export async function readImage(options = {}) {
  const started = Date.now()
  const elapsed = () => Date.now() - started
  const skillsRoot = options?.skillsRoot
  const rawPath = typeof options?.path === 'string' ? options.path.trim() : ''
  const focus = typeof options?.focus === 'string' ? options.focus.trim().slice(0, FOCUS_CAP_CHARS) : ''
  const timeoutMs = clampTimeout(options?.timeoutMs, DEFAULT_READ_TIMEOUT_MS)

  let located = null
  try {
    located = locateCli(skillsRoot)
  } catch {
    located = null
  }
  if (!located) {
    return {
      ok: false,
      evidence: null,
      raw: '',
      durationMs: elapsed(),
      error: '未找到 modlens CLI：随包技能里没有 dist/main.js，图片理解不可用',
    }
  }

  const validated = validateImagePath(rawPath)
  if (validated.error) {
    return { ok: false, evidence: null, raw: '', durationMs: elapsed(), error: validated.error }
  }

  const node = locateNode(skillsRoot)
  const args = [located.path, '-i', validated.path]
  if (focus !== '') args.push('--prompt', focus)
  // Passed through so a hanging provider is reported by modlens (with its name) instead of being
  // killed silently by our own timer; KILL_GRACE_MS is only for modlens itself being wedged.
  args.push('--timeout', String(timeoutMs))

  const run = await runCli(node, args, timeoutMs + KILL_GRACE_MS)
  const raw = run.stdout.length > RAW_CAP_CHARS ? run.stdout.slice(0, RAW_CAP_CHARS) : run.stdout
  const stderrTail = tail(run.stderr, STDERR_CAP_CHARS)
  const withTail = (sentence) => (stderrTail === '' ? sentence : `${sentence} ｜ ${stderrTail}`)

  if (run.overflowed) {
    return {
      ok: false,
      evidence: null,
      raw,
      stderr: stderrTail,
      durationMs: elapsed(),
      error: withTail(`modlens 输出超过 ${Math.round(STDOUT_CAP_BYTES / 1024 / 1024)} MB 上限，已中止读取`),
    }
  }

  if (run.timedOut) {
    return {
      ok: false,
      evidence: null,
      raw,
      stderr: stderrTail,
      durationMs: elapsed(),
      error: withTail(`读取超时（${timeoutMs}ms）：modlens 没有在限定时间内返回`),
    }
  }

  if (run.error) {
    // A spawn failure means the runtime itself is missing, which is a different sentence from a
    // provider refusing: "读取失败" would send the user to the wrong place.
    if (run.error.code === 'ENOENT') {
      return {
        ok: false,
        evidence: null,
        raw,
        stderr: stderrTail,
        durationMs: elapsed(),
        error: `无法启动 Node 运行时：${node}（${String(run.error.message ?? run.error)}）`,
      }
    }
    const exitCode = typeof run.error.code === 'number' ? run.error.code : '未知'
    const cause = classifyCliFailure(run.stderr) || `modlens 读取失败（退出码 ${exitCode}）`
    return {
      ok: false,
      evidence: null,
      raw,
      stderr: stderrTail,
      durationMs: elapsed(),
      error: withTail(cause),
    }
  }

  let evidence = null
  try {
    evidence = JSON.parse(run.stdout)
  } catch {
    return {
      ok: false,
      evidence: null,
      raw,
      stderr: stderrTail,
      durationMs: elapsed(),
      error: withTail('modlens 退出码为 0，但输出不是 JSON（CLI 版本不匹配？）'),
    }
  }

  if (!evidence || typeof evidence !== 'object' || Array.isArray(evidence)) {
    return {
      ok: false,
      evidence: null,
      raw,
      stderr: stderrTail,
      durationMs: elapsed(),
      error: withTail('modlens 输出不是 JSON 对象'),
    }
  }

  // The documented contract top-level key. Checked because an object without it means the CLI
  // changed shape, and the window would otherwise render a plausible-looking empty result.
  if (evidence.result === undefined) {
    const keys = Object.keys(evidence).slice(0, 6).join(', ')
    return {
      ok: false,
      evidence: null,
      raw,
      stderr: stderrTail,
      durationMs: elapsed(),
      error: withTail(`modlens 输出缺少 result 字段（顶层字段：${keys || '空'}）`),
    }
  }

  return { ok: true, evidence, raw, stderr: stderrTail, durationMs: elapsed() }
}

/**
 * Image files directly inside one directory, for the picker.
 *
 * Synchronous and single-level on purpose: this backs a list the user scrolls while typing, so it
 * must never walk a tree, and `cwd` is offered as the start point rather than a recursive search.
 * Newest first, because the image someone wants is almost always the one they just made.
 *
 * @param {{dir?: string, limit?: number}} [options] `dir` must be absolute.
 * @returns {{ok: boolean, dir: string, images: Array<{path: string, name: string, size: number, at: number}>, error?: string, truncated?: boolean}}
 */
export function listImages(options = {}) {
  const dir = typeof options?.dir === 'string' ? options.dir.trim() : ''
  if (dir === '') return { ok: false, dir: '', images: [], error: '目录为空：请填写一个绝对路径' }
  if (!isAbsolute(dir)) return { ok: false, dir, images: [], error: `目录必须是绝对路径：${dir}` }

  let stats
  try {
    stats = statSync(dir)
  } catch {
    return { ok: false, dir, images: [], error: `目录不存在：${dir}` }
  }
  if (!stats.isDirectory()) return { ok: false, dir, images: [], error: `不是目录：${dir}` }

  const requested = Number(options?.limit)
  const limit = Number.isFinite(requested) && requested > 0 ? Math.min(Math.round(requested), MAX_IMAGE_LIMIT) : DEFAULT_IMAGE_LIMIT

  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch (problem) {
    return { ok: false, dir, images: [], error: `无法读取目录：${String(problem?.message ?? problem)}` }
  }

  const images = []
  for (const entry of entries) {
    // Symlinks are skipped rather than followed: a link out of the chosen directory would list a
    // file the user never pointed at, and the reader would then happily send it to a provider.
    if (!entry.isFile()) continue
    if (!IMAGE_EXTENSIONS.has(extname(entry.name).toLowerCase())) continue
    const full = join(dir, entry.name)
    let fileStats
    try {
      fileStats = statSync(full)
    } catch {
      continue
    }
    images.push({ path: full, name: entry.name, size: fileStats.size, at: fileStats.mtimeMs })
  }

  images.sort((a, b) => b.at - a.at)
  const truncated = images.length > limit
  return { ok: true, dir, images: images.slice(0, limit), truncated }
}
