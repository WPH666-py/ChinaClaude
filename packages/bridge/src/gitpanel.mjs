/**
 * 代码管理 — the git shell-outs behind the panel.
 *
 * WHY THIS SHELLS OUT AT ALL: this app has no git library and must not grow one (zero dependencies, and
 * a JS implementation of the index would be a worse git than the one the user already has). Executing
 * the real `git` means the panel agrees with the terminal the user is also looking at.
 *
 * WHAT IT DELIBERATELY DOES NOT DO: push, pull, fetch, reset, checkout, clean, stash. Those either
 * touch a remote or discard work, and a GUI button is one misclick away from an unrecoverable state.
 * The panel submits what the user staged and reports git's own output; everything else is a terminal
 * away, on purpose.
 *
 * EVERY CALL IS BOUNDED AND NON-INTERACTIVE. `execFile` (never `exec`), argv only, no shell, `cwd`
 * validated as an existing absolute directory containing a `.git` entry, an explicit timeout, output
 * capped, and `GIT_TERMINAL_PROMPT=0` so a command that would ask for a password fails instead of
 * parking the panel behind a prompt nobody can answer.
 *
 * ON THIS MACHINE git is genuinely absent, which is why the missing-binary path is a first-class answer
 * with an install hint rather than an error string: "已安装但找不到" and "没装" look identical to a
 * user staring at an empty list, and only one of them is fixed by installing something.
 */
import { execFile } from 'node:child_process'
import { existsSync, statSync } from 'node:fs'
import { dirname, isAbsolute, join, normalize } from 'node:path'

/** Read commands are expected to answer in well under a second; 8 s is a hang, not slowness. */
const READ_TIMEOUT_MS = 8000
/** A commit runs the user's own hooks and rewrites the index, so it gets a longer leash than a read. */
const WRITE_TIMEOUT_MS = 20_000
/** Patch ceiling; a 50 MB diff rendered into a webview is a freeze, not a feature. */
const PATCH_CAP = 200 * 1024
/** Text ceiling for status/log output. */
const TEXT_CAP = 256 * 1024
/** Hard buffer ceiling, over which Node itself errors; reported as a truncation rather than a crash. */
const MAX_BUFFER = 4 * 1024 * 1024

const INSTALL_HINT =
  '装一个 Git 即可：从 https://registry.npmmirror.com/-/binary/git-for-windows/ 下载 Git for Windows 安装包（国内镜像，比 GitHub 快），或运行 winget install Git.Git；装完点「重新检测」。已装好但没被找到的话，可以用环境变量 CCCN_GIT 指定 git.exe 的完整路径。'

/**
 * The environment every git call runs with.
 *
 * GIT_TERMINAL_PROMPT: no command here is interactive, so a credential prompt must fail fast — a
 * bridge process has no terminal to answer it and would otherwise hang until the timeout.
 * GIT_OPTIONAL_LOCKS: `git status` refreshes the index by default, which takes the index lock; against
 * a read-only checkout that is a hard failure, and against a repository the user is committing to in
 * another window it is a race. The panel only reads, so it declares that.
 */
const GIT_ENV = {
  ...process.env,
  GIT_TERMINAL_PROMPT: '0',
  GIT_OPTIONAL_LOCKS: '0',
  GIT_PAGER: 'cat',
}

/**
 * Where to look for git, most explicit first.
 *
 * The Git for Windows paths are listed because a PATH that predates the install (or a stripped-down
 * environment inherited from the shell that launched the app) is the common case where git IS installed
 * and still not found — and that case must not be reported as "not installed".
 */
function candidates() {
  const list = []
  const override = String(process.env.CCCN_GIT ?? '').trim()
  if (override) list.push(override)
  list.push('git')
  if (process.platform === 'win32') {
    const roots = [
      process.env.ProgramFiles,
      process.env.ProgramW6432,
      process.env['ProgramFiles(x86)'],
      process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, 'Programs') : null,
    ]
    for (const root of roots) {
      if (root) list.push(join(root, 'Git', 'cmd', 'git.exe'))
    }
  }
  /**
   * Deduplicated case-insensitively. `%ProgramFiles%` and `%ProgramW6432%` are the same directory on
   * 64-bit Windows, and the candidate list is quoted verbatim in the "not found" message — listing one
   * path twice makes that message look like it searched harder than it did.
   */
  const seen = new Set()
  return list.filter((entry) => {
    const key = process.platform === 'win32' ? entry.toLowerCase() : entry
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

/** Strip CR and cap length. A lone CR renders as a line break in HTML, so CRLF repos double-space. */
function cleanText(value) {
  const text = Buffer.isBuffer(value) ? value.toString('utf8') : String(value ?? '')
  const stripped = text.replace(/\r/g, '')
  return stripped.length > TEXT_CAP ? `${stripped.slice(0, TEXT_CAP)}\n…（输出已截断）` : stripped
}

function firstLine(text) {
  const line = String(text ?? '')
    .split('\n')
    .map((entry) => entry.trim())
    .find((entry) => entry !== '')
  return line ?? ''
}

/**
 * One bounded git invocation.
 *
 * `shell: false` is the module's central safety property — a page-supplied file name reaches git as a
 * single argv element, so `a & del /f /q c:\` is a file name that git will not find, not a second
 * command. It is written out loud because `execFile` defaults it, and a future edit that "simplifies"
 * this into `exec` would silently remove the guarantee.
 *
 * Output is captured as a Buffer rather than a string so the diff cap can be applied in BYTES (a
 * character cap on multibyte CJK content is not the cap it claims to be) and so slicing cannot split a
 * character into a replacement glyph.
 */
function run(command, args, { cwd, timeoutMs }) {
  return new Promise((resolve) => {
    execFile(
      command,
      args,
      {
        cwd,
        timeout: timeoutMs,
        windowsHide: true,
        shell: false,
        encoding: 'buffer',
        maxBuffer: MAX_BUFFER,
        env: GIT_ENV,
      },
      (error, stdout, stderr) => {
        const stdoutBuffer = Buffer.isBuffer(stdout) ? stdout : Buffer.from(String(stdout ?? ''))
        const stderrText = cleanText(stderr)
        const base = {
          ok: error === null || error === undefined,
          code: 0,
          failure: null,
          stdoutBuffer,
          stdout: cleanText(stdoutBuffer),
          stderr: stderrText,
        }
        if (base.ok) return resolve(base)

        const code = typeof error?.code === 'number' ? error.code : null
        if (error?.code === 'ENOENT' || error?.code === 'EACCES') {
          return resolve({ ...base, ok: false, failure: 'missing', stderr: stderrText })
        }
        if (error?.killed === true || error?.signal) {
          return resolve({ ...base, ok: false, failure: 'timeout', code })
        }
        if (error?.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') {
          return resolve({ ...base, ok: false, failure: 'toobig', code })
        }
        return resolve({ ...base, ok: false, failure: 'exit', code })
      },
    )
  })
}

/**
 * The command a data call will use.
 *
 * An existing absolute candidate wins (which keeps this consistent with what `gitAvailable` found even
 * when the install is not on PATH); otherwise the first bare name, which the OS resolves through PATH.
 */
function pickCommand() {
  const list = candidates()
  return list.find((entry) => isAbsolute(entry) && existsSync(entry)) ?? list.find((entry) => !isAbsolute(entry)) ?? 'git'
}

/** The answer every call gives when there is no usable git binary. */
function unavailable(reason) {
  return { ok: false, available: false, error: reason, reason, hint: INSTALL_HINT }
}

/** Map a failed invocation onto an answer the panel can render. */
function failureAnswer(result, command, what) {
  if (result.failure === 'missing') {
    return unavailable(`没有找到可用的 git（尝试运行 ${command} 失败）`)
  }
  if (result.failure === 'timeout') {
    return {
      ok: false,
      available: true,
      error: `${what}超时（${READ_TIMEOUT_MS / 1000} 秒未返回）`,
      detail: '仓库可能太大，或 git 停在了交互提示上。',
    }
  }
  if (result.failure === 'toobig') {
    return {
      ok: false,
      available: true,
      error: `${what}输出超过 ${Math.round(MAX_BUFFER / 1024 / 1024)} MB，已放弃读取`,
      detail: '请缩小范围（先选择一个文件或减少提交条数）。',
    }
  }
  const message = firstLine(result.stderr) || firstLine(result.stdout) || `${what}失败（退出码 ${result.code ?? '未知'}）`
  // Measured on Windows: a repository owned by another account makes every read fail with this, and the
  // fix is one config line the user cannot guess from the message.
  if (/dubious ownership/i.test(result.stderr)) {
    return {
      ok: false,
      available: true,
      error: message,
      hint: 'git 认为该目录属于其他用户。在工作目录执行一次：git config --global --add safe.directory <该目录>',
    }
  }
  return { ok: false, available: true, error: message }
}

/** A `cwd` must be an existing absolute directory; a relative path means the page guessed. */
function validateCwd(cwd) {
  const raw = String(cwd ?? '').trim()
  if (raw === '') return { ok: false, error: '请先选择一个工作目录' }
  if (!isAbsolute(raw)) return { ok: false, error: `需要一个绝对路径，收到的是：${raw}` }
  let stats
  try {
    stats = statSync(raw)
  } catch {
    return { ok: false, error: `目录不存在：${raw}` }
  }
  if (!stats.isDirectory()) return { ok: false, error: `这不是一个目录：${raw}` }
  return { ok: true, dir: normalize(raw) }
}

/** Point at the enclosing repository when the chosen directory is a subdirectory of one. */
function ancestorRepoNote(dir) {
  let current = dir
  for (let hop = 0; hop < 6; hop += 1) {
    const parent = dirname(current)
    if (!parent || parent === current) break
    if (existsSync(join(parent, '.git'))) {
      return `该目录位于仓库 ${parent} 内，请直接选择仓库根目录。`
    }
    current = parent
  }
  return null
}

/**
 * `.git` is a directory in a normal clone but a FILE in a worktree and in a submodule, so presence is
 * checked with `existsSync` rather than `isDirectory` — treating a worktree as "not a repository" would
 * be wrong about the user's actual checkout.
 */
function repoGuard(dir) {
  if (existsSync(join(dir, '.git'))) return { ok: true }
  return { ok: false, error: '这不是一个 git 仓库', detail: ancestorRepoNote(dir) }
}

/**
 * Availability.
 *
 * `ok` here means THE CHECK RAN; `available` carries the answer. The two differ exactly when git is
 * missing — and keeping them apart is what lets the panel state "not installed" as a fact instead of
 * showing a failed request.
 *
 * Nothing is cached: the panel's 重新检测 button exists because a user installs git WHILE looking at
 * this window, and a cached "not installed" would keep saying so after the install finished.
 */
export async function gitAvailable() {
  try {
    const tried = candidates()
    for (const candidate of tried) {
      const probe = await run(candidate, ['--version'], { timeoutMs: READ_TIMEOUT_MS })
      if (probe.ok) {
        return {
          ok: true,
          available: true,
          version: probe.stdout.trim() || null,
          path: candidate,
          reason: null,
          hint: null,
        }
      }
      if (probe.failure === 'exit') {
        // The binary exists and refused to run: a broken install needs different advice than a missing
        // one, so this is not folded into the "not found" answer below.
        return {
          ok: true,
          available: false,
          version: null,
          path: candidate,
          reason: `找到了 git（${candidate}），但它无法运行：${firstLine(probe.stderr) || `退出码 ${probe.code ?? '未知'}`}`,
          hint: '可能是安装损坏或权限不足，重装 Git for Windows 后点「重新检测」。',
        }
      }
    }
    return {
      ok: true,
      available: false,
      version: null,
      path: null,
      reason: `本机没有找到可用的 git（已尝试：${tried.join('、')}）`,
      hint: INSTALL_HINT,
    }
  } catch (error) {
    return unavailable(`检测 git 时出错：${String(error?.message ?? error)}`)
  }
}

/** The two-character porcelain code pairs that mean "unmerged", spelled out rather than pattern-matched. */
const CONFLICT_PAIRS = new Set(['DD', 'AU', 'UD', 'UA', 'DU', 'AA', 'UU'])

function labelFor(index, worktree) {
  if (CONFLICT_PAIRS.has(`${index}${worktree}`)) return '冲突'
  if (index === 'R' || worktree === 'R') return '重命名'
  if (index === 'C' || worktree === 'C') return '复制'
  // A delete on either side wins over "modified": a file the user deleted in the worktree is gone, and
  // labelling it 修改 would send them looking for content that is not there.
  if (index === 'D' || worktree === 'D') return '删除'
  if (index === 'A') return '新增'
  if (index === 'T' || worktree === 'T') return '类型变更'
  if (index === 'M' || worktree === 'M') return '修改'
  return '未知'
}

/**
 * Parse `git status --porcelain=v1 -z --branch`.
 *
 * NUL-separated rather than line-separated because a path may contain a newline, and quoting is
 * disabled with `-z` — a parser built on the quoted form has to unescape C-style strings, which is one
 * more place for a file name to be misread as a change.
 *
 * The rename trap: in `-z` form a rename emits `R  <new>\0<old>\0`, so the field AFTER a rename entry is
 * the origin path, not another entry. Consuming it explicitly is what keeps the list from showing a
 * phantom file.
 */
function parseStatus(raw) {
  const fields = String(raw ?? '').split('\0')
  const files = []
  let branch = null
  let upstream = null
  let ahead = 0
  let behind = 0
  let detached = false

  let cursor = 0
  const head = fields[0] ?? ''
  if (head.startsWith('## ')) {
    cursor = 1
    const header = head.slice(3).trim()
    if (/^HEAD \(no branch\)/.test(header)) {
      detached = true
    } else {
      // 'main...origin/main [ahead 1, behind 2]' | 'main' | 'No commits yet on main'
      const unborn = header.match(/^(?:No commits yet on|Initial commit on)\s+(.+)$/i)
      const core = (unborn ? unborn[1] : header).trim()
      const [local, rest] = core.split('...')
      branch = (local ?? '').trim() || null
      upstream = ((rest ?? '').split(' [')[0] ?? '').trim() || null
      const tracking = header.match(/\[([^\]]*)\]/)
      if (tracking) {
        const aheadMatch = tracking[1].match(/ahead (\d+)/)
        const behindMatch = tracking[1].match(/behind (\d+)/)
        ahead = aheadMatch ? Number(aheadMatch[1]) : 0
        behind = behindMatch ? Number(behindMatch[1]) : 0
      }
    }
  }

  while (cursor < fields.length) {
    const entry = fields[cursor]
    cursor += 1
    if (!entry) continue
    const index = entry[0] ?? ' '
    const worktree = entry[1] ?? ' '
    const path = entry.slice(3)
    let from = null
    if (index === 'R' || index === 'C' || worktree === 'R' || worktree === 'C') {
      from = fields[cursor] ?? null
      cursor += 1
    }
    if (path === '') continue
    const untracked = index === '?' && worktree === '?'
    files.push({
      path,
      index,
      worktree,
      staged: !untracked && index !== ' ' && index !== '?',
      untracked,
      status: untracked ? '新增' : labelFor(index, worktree),
      from,
    })
  }

  return { branch, upstream, ahead, behind, detached, files }
}

/** The empty shape every status answer carries, so the panel never has to guard for missing fields. */
function statusShell(extra) {
  return { ok: false, available: true, branch: null, upstream: null, ahead: 0, behind: 0, detached: false, files: [], ...extra }
}

/** Branch, tracking state and per-file codes for one working directory. */
export async function gitStatus({ cwd } = {}) {
  try {
    const dir = validateCwd(cwd)
    if (!dir.ok) return statusShell({ error: dir.error })
    const guard = repoGuard(dir.dir)
    if (!guard.ok) return statusShell({ error: guard.error, detail: guard.detail })

    const command = pickCommand()
    // `--untracked-files` is left at git's default (`normal`): an untracked directory is reported as one
    // entry instead of thousands, which is what keeps a repository with a `node_modules` in it readable.
    const result = await run(command, ['status', '--porcelain=v1', '-z', '--branch'], {
      cwd: dir.dir,
      timeoutMs: READ_TIMEOUT_MS,
    })
    if (!result.ok) {
      const answer = failureAnswer(result, command, '读取状态')
      return statusShell({ ...answer, ok: false })
    }

    // Reported rather than hidden: a status list that silently forgot files is worse than one that says
    // it is incomplete. The cut is moved back to the last complete NUL-terminated record, because a
    // half-record parses into a file that does not exist.
    const truncated = result.stdoutBuffer.length > TEXT_CAP
    const raw = truncated ? result.stdout.slice(0, Math.max(0, result.stdout.lastIndexOf('\0'))) : result.stdout
    const parsed = parseStatus(raw)
    return {
      ok: true,
      available: true,
      branch: parsed.branch,
      upstream: parsed.upstream,
      ahead: parsed.ahead,
      behind: parsed.behind,
      detached: parsed.detached,
      files: parsed.files,
      truncated,
    }
  } catch (error) {
    return statusShell({ error: String(error?.message ?? error) })
  }
}

/** One file's patch, or the whole working tree when `file` is omitted. */
export async function gitDiff({ cwd, file, staged } = {}) {
  try {
    const dir = validateCwd(cwd)
    if (!dir.ok) return { ok: false, available: true, patch: '', truncated: false, error: dir.error }
    const guard = repoGuard(dir.dir)
    if (!guard.ok) return { ok: false, available: true, patch: '', truncated: false, error: guard.error, detail: guard.detail }

    const target = String(file ?? '').trim()
    if (target.includes('\0') || target.includes('\n')) {
      return { ok: false, available: true, patch: '', truncated: false, error: '文件路径非法' }
    }

    /**
     * `--no-ext-diff` and `--no-textconv` are not decoration: a repository can nominate an external diff
     * driver in `.gitattributes`, and without these flags a read-only panel would execute whatever
     * command the repository names. The panel streams untrusted repositories; those drivers are exactly
     * the kind of thing that must not run because a user clicked a file.
     */
    const args = ['diff', '--no-color', '--no-ext-diff', '--no-textconv']
    if (staged === true) args.push('--cached')
    args.push('--')
    if (target !== '') args.push(target)

    const command = pickCommand()
    const result = await run(command, args, { cwd: dir.dir, timeoutMs: READ_TIMEOUT_MS })
    if (!result.ok) {
      const answer = failureAnswer(result, command, '读取差异')
      return { ok: false, available: answer.available !== false, patch: '', truncated: false, ...answer }
    }

    const total = result.stdoutBuffer.length
    const truncated = total > PATCH_CAP
    const patch = truncated ? result.stdoutBuffer.subarray(0, PATCH_CAP).toString('utf8').replace(/\r/g, '') : result.stdout
    return {
      ok: true,
      available: true,
      patch,
      truncated,
      // Byte counts, not character counts: the UI reports how much was dropped, and a CJK diff measured
      // in characters would understate it by three quarters.
      bytes: Buffer.byteLength(patch, 'utf8'),
      totalBytes: total,
    }
  } catch (error) {
    return { ok: false, available: true, patch: '', truncated: false, error: String(error?.message ?? error) }
  }
}

/** Recent commits, newest first. */
export async function gitLog({ cwd, limit } = {}) {
  try {
    const dir = validateCwd(cwd)
    if (!dir.ok) return { ok: false, available: true, commits: [], error: dir.error }
    const guard = repoGuard(dir.dir)
    if (!guard.ok) return { ok: false, available: true, commits: [], error: guard.error, detail: guard.detail }

    const count = Math.min(Math.max(Number(limit) || 30, 1), 200)
    const command = pickCommand()
    const result = await run(
      command,
      ['log', `--max-count=${count}`, '--no-color', '--pretty=format:%H%x1f%h%x1f%an%x1f%aI%x1f%s'],
      { cwd: dir.dir, timeoutMs: READ_TIMEOUT_MS },
    )

    if (!result.ok) {
      // An empty repository is a normal state, not a failure: `git log` exits non-zero with no commits
      // yet, and reporting that as an error would put a scary banner over a brand-new project.
      if (result.failure === 'exit' && /does not have any commits|unknown revision|bad default revision|no commits yet/i.test(result.stderr)) {
        return { ok: true, available: true, commits: [], note: '仓库还没有任何提交' }
      }
      const answer = failureAnswer(result, command, '读取提交历史')
      return { ok: false, available: answer.available !== false, commits: [], ...answer }
    }

    const commits = result.stdout
      .split('\n')
      .filter((line) => line.trim() !== '')
      .map((line) => {
        const parts = line.split('\x1f')
        return {
          sha: parts[0] ?? '',
          short: parts[1] ?? (parts[0] ?? '').slice(0, 7),
          author: parts[2] ?? '',
          at: parts[3] ?? '',
          // The subject is last, and a subject containing the separator must not lose its tail.
          subject: parts.slice(4).join('\x1f'),
        }
      })
      .filter((commit) => commit.sha !== '')

    return { ok: true, available: true, commits }
  } catch (error) {
    return { ok: false, available: true, commits: [], error: String(error?.message ?? error) }
  }
}

/**
 * Stage the named paths (when any are given) and commit.
 *
 * The only write this module performs, and it is bounded on every side: no remote, no history rewrite,
 * no `--amend`, no `--no-verify`. A message is required because an empty one leaves a commit nobody can
 * read later, and the paths are taken literally — see the wildcard refusal below.
 */
export async function gitCommit({ cwd, message, files } = {}) {
  try {
    const dir = validateCwd(cwd)
    if (!dir.ok) return { ok: false, available: true, output: '', error: dir.error }
    const guard = repoGuard(dir.dir)
    if (!guard.ok) return { ok: false, available: true, output: '', error: guard.error, detail: guard.detail }

    const text = String(message ?? '').trim()
    if (text === '') return { ok: false, available: true, output: '', error: '提交信息不能为空' }

    const paths = (Array.isArray(files) ? files : [])
      .filter((entry) => typeof entry === 'string' && entry.trim() !== '')
      .map((entry) => entry.trim())
    /**
     * No shell is involved, but GIT ITSELF expands pathspecs, so a `*` here would stage files the caller
     * never listed — a page-supplied list must mean exactly the files it names.
     */
    if (paths.some((entry) => /[*?[\]]/.test(entry))) {
      return { ok: false, available: true, output: '', error: '文件路径不支持通配符，请传入具体文件' }
    }
    if (paths.some((entry) => entry.includes('\0') || entry.includes('\n'))) {
      return { ok: false, available: true, output: '', error: '文件路径非法' }
    }

    const command = pickCommand()
    let output = ''

    if (paths.length > 0) {
      const add = await run(command, ['add', '--', ...paths], { cwd: dir.dir, timeoutMs: WRITE_TIMEOUT_MS })
      output += add.stdout + add.stderr
      if (!add.ok) {
        const answer = failureAnswer(add, command, '暂存文件')
        return { ok: false, available: answer.available !== false, output: output.trim(), ...answer }
      }
    }

    const commit = await run(command, ['commit', '-m', text], { cwd: dir.dir, timeoutMs: WRITE_TIMEOUT_MS })
    // git writes the useful part of a commit to stdout ("1 file changed") and the useful part of a
    // refusal to stderr, so both are returned and the panel shows them verbatim.
    output = `${output}${commit.stdout}${commit.stderr}`.trim()

    if (!commit.ok) {
      if (commit.failure === 'exit' && /nothing to commit|no changes added to commit|nothing added to commit/i.test(commit.stdout + commit.stderr)) {
        return { ok: false, available: true, output, error: '没有可提交的改动（暂存区是空的）' }
      }
      const answer = failureAnswer(commit, command, '提交')
      return { ok: false, available: answer.available !== false, output, ...answer }
    }

    return { ok: true, available: true, output }
  } catch (error) {
    return { ok: false, available: true, output: '', error: String(error?.message ?? error) }
  }
}
