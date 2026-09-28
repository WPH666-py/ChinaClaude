/**
 * Directory security audit, backed by the vendored `@jieai/dsh-plugin-vet` scanner engine.
 *
 * WHY A VENDORED ENGINE RATHER THAN A REWRITE
 *
 * The upstream plugin is DSH-bound at its shell (`lib/index.bundle.js` imports the Cordis and
 * dsh-tools packages), but its ANALYSIS ENGINE is not: `lib/scanner-bin/` is a self-contained child
 * process that reads one JSON ScanRequest on stdin and writes one JSON ScanResponse on stdout. Its
 * only non-builtin import is `typescript`, used for AST predicates (`isCallExpression`,
 * `forEachChild`, `SyntaxKind`) — no type checker, no tsc. Vendoring that engine verbatim keeps 20
 * battle-tested rules, and rewriting them here would be both worse and dishonest about parity.
 *
 * The engine is spawned, never imported: it never evals, and a scan that crashes the engine cannot
 * take the bridge down with it.
 *
 * WHAT IT IS FOR HERE
 *
 * Claude Code loads skills from `<root>/.claude/skills/<name>/SKILL.md` and can load plugins. Both
 * are arbitrary third-party code and, in the SKILL.md case, arbitrary INSTRUCTIONS — which is
 * exactly what the engine's R18 instruction-injection and R17 config-injection rules exist for.
 * So this is the "look before you trust" step for anything about to be dropped into a skills root.
 */
import { spawn } from 'node:child_process'
import { readdirSync, existsSync } from 'node:fs'
import { extname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Extensions the engine's AST rules can parse, plus the config/instruction surfaces it scans. */
const SOURCE_EXTENSIONS = new Set(['.js', '.mjs', '.cjs', '.jsx', '.ts', '.tsx', '.mts', '.cts'])
const TEXT_SURFACES = new Set(['.json', '.yml', '.yaml', '.md'])

/**
 * Directories never worth scanning.
 *
 * `node_modules` is excluded because a plugin's dependency tree is not the plugin: scanning it
 * would bury the plugin's own findings under thousands of third-party ones and blow the time
 * budget. `.git` and caches are excluded for the same reason.
 */
const SKIP_DIRECTORIES = new Set(['node_modules', '.git', '.cache', 'dist', 'build', '.next', 'coverage'])

/** Hard ceiling on files sent to the engine, so a huge tree degrades instead of hanging. */
const MAX_FILES = 3000
const MAX_DEPTH = 14

/**
 * Locate the vendored engine.
 *
 * Order mirrors the rest of the bridge: an explicit env override, then the packaged sidecar layout,
 * then the in-repo development layout. Returning null rather than throwing lets the route answer
 * "audit unavailable" with a reason instead of failing the whole request.
 */
export function resolveScannerDir() {
  const candidates = []
  if (process.env.CCCN_VET_DIR) candidates.push(process.env.CCCN_VET_DIR)
  const here = fileURLToPath(import.meta.url)
  const srcDir = resolve(here, '..')
  if (process.env.CCCN_SIDECAR_DIR) candidates.push(join(process.env.CCCN_SIDECAR_DIR, 'vet', 'scanner-bin'))
  // Packaged: bridge/ sits beside vet/ under the sidecar root.
  candidates.push(resolve(srcDir, '..', 'vet', 'scanner-bin'))
  // Development: packages/bridge/src -> repo/vendor/vet/scanner-bin
  candidates.push(resolve(srcDir, '..', '..', '..', 'vendor', 'vet', 'scanner-bin'))

  for (const candidate of candidates) {
    if (candidate && existsSync(join(candidate, 'index.js'))) return candidate
  }
  return null
}

/** Whether the audit feature can run at all, and why not when it cannot. */
export function scannerStatus() {
  const dir = resolveScannerDir()
  if (!dir) {
    return { available: false, reason: '未找到随包的审计引擎（vendor/vet/scanner-bin）', scannerDir: null }
  }
  // The engine's one non-builtin dependency. Checked explicitly because the failure mode is a bare
  // module-resolution crash inside a child process, which surfaces as unparseable empty stdout.
  const typescript = resolve(dir, '..', 'node_modules', 'typescript', 'lib', 'typescript.js')
  if (!existsSync(typescript)) {
    return { available: false, reason: '审计引擎缺少 typescript 运行时', scannerDir: dir }
  }
  return { available: true, reason: null, scannerDir: dir }
}

/**
 * Collect scannable files under `root`.
 *
 * Returns the list plus whether the ceiling was hit, because a truncated scan that reports "clean"
 * without saying it was truncated would be worse than no scan at all.
 */
export function collectFiles(root, options = {}) {
  const maxFiles = options.maxFiles ?? MAX_FILES
  const wantText = options.includeTextSurfaces !== false
  const files = []
  let truncated = false
  let skippedSymlinks = 0

  const walk = (dir, depth) => {
    if (truncated || depth > MAX_DEPTH) return
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (truncated) return
      // Symlinks are skipped rather than followed: a link out of the tree would let a scan read
      // files the user never chose, and a link loop would not terminate.
      if (entry.isSymbolicLink()) {
        skippedSymlinks++
        continue
      }
      const full = join(dir, entry.name)
      if (entry.isDirectory()) {
        if (SKIP_DIRECTORIES.has(entry.name.toLowerCase())) continue
        walk(full, depth + 1)
        continue
      }
      if (!entry.isFile()) continue
      const extension = extname(entry.name).toLowerCase()
      const isSource = SOURCE_EXTENSIONS.has(extension)
      // Config and instruction surfaces feed R17/R18, so they are scanned as text too — but only
      // when asked, because a repo full of .md files is mostly noise.
      const isText = wantText && TEXT_SURFACES.has(extension)
      if (!isSource && !isText) continue
      if (files.length >= maxFiles) {
        truncated = true
        return
      }
      files.push(full)
    }
  }

  walk(root, 0)
  return { files, truncated, skippedSymlinks }
}

/**
 * Time budget for one scan.
 *
 * Scales with file count as upstream does, because a fixed budget silently kills large scans
 * mid-way and reports a clean result for files that were never examined.
 */
export function scanBudget(fileCount, explicitMs, capMs = 60000) {
  const base = Number.isFinite(explicitMs) && explicitMs > 0 ? explicitMs : 15000
  return Math.min(Math.max(base, fileCount * 2000), capMs)
}

/**
 * Run the engine over a directory and return its report.
 *
 * Never throws for engine-level problems: an unreachable engine, a crash, a timeout and malformed
 * output all come back as `{ ok: false, error }`, so the UI can distinguish "audited and clean"
 * from "could not audit" — a distinction that matters more here than anywhere else.
 *
 * @returns {Promise<{ok: boolean, error?: string, report?: object, meta?: object}>}
 */
export async function scanDirectory(target, options = {}) {
  const status = scannerStatus()
  if (!status.available) return { ok: false, error: status.reason }

  const absolute = resolve(String(target ?? ''))
  if (!existsSync(absolute)) return { ok: false, error: `目录不存在：${absolute}` }

  const { files, truncated, skippedSymlinks } = collectFiles(absolute, options)
  if (files.length === 0) {
    return {
      ok: true,
      report: { engine: null, sourceCount: 0, findings: [], staticScore: 0, verdict: 'clean' },
      meta: { target: absolute, fileCount: 0, truncated: false, skippedSymlinks, empty: true, durationMs: 0 },
    }
  }

  const timeoutMs = scanBudget(files.length, options.timeoutMs)
  const request = {
    kind: 'files',
    files,
    // 'plugin' keeps the strict escape judgement, which is what "should I trust this?" needs.
    targetKind: options.targetKind ?? 'plugin',
    // A directory the user picked is usually a source tree, not a registry tarball. Under 'npm' the
    // engine flags an absent build output as a missing entry point, which would be a false positive
    // on a plain checkout.
    scanBasis: options.scanBasis ?? 'git',
    // OSV consults an online advisory board; opt-in only so a scan stays local by default.
    osv: options.osv === true,
    timeoutMs,
  }

  const started = Date.now()
  const child = spawn(process.execPath, [join(status.scannerDir, 'index.js')], {
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  })

  let stdout = ''
  let stderr = ''
  let timedOut = false

  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  child.stdout.on('data', (chunk) => {
    stdout += chunk
  })
  child.stderr.on('data', (chunk) => {
    stderr += chunk
  })

  const timer = setTimeout(() => {
    timedOut = true
    try {
      child.kill()
    } catch {
      /* already gone */
    }
  }, timeoutMs + 5000)

  child.stdin.end(JSON.stringify(request))
  await new Promise((resolveClose) => child.on('close', resolveClose))
  clearTimeout(timer)

  const durationMs = Date.now() - started
  const meta = { target: absolute, fileCount: files.length, truncated, skippedSymlinks, timeoutMs, durationMs }

  if (timedOut) {
    return { ok: false, error: `审计超时（${timeoutMs}ms，${files.length} 个文件）`, meta }
  }

  let response
  try {
    response = JSON.parse(stdout)
  } catch {
    // Empty stdout with a stack trace on stderr is the engine's signature for a startup crash —
    // most often a missing dependency. Surfacing stderr is the difference between a fixable
    // message and "Unexpected end of JSON input".
    const detail = stderr.trim().split('\n').slice(-6).join(' ').slice(0, 400)
    return {
      ok: false,
      error: detail ? `审计引擎启动失败：${detail}` : `审计引擎没有返回结果（${stdout.length} 字节）`,
      meta,
    }
  }

  if (response?.ok !== true || !response.report) {
    return { ok: false, error: String(response?.error ?? '审计引擎返回了无效结果'), meta }
  }

  // A truncated scan must not be presentable as a clean bill of health.
  if (truncated) {
    meta.truncatedNotice = `文件数超过上限 ${MAX_FILES}，仅审计了前 ${files.length} 个文件`
  }
  return { ok: true, report: response.report, meta }
}

/** Findings grouped by severity, so the UI does not have to re-derive the order. */
export function groupFindings(findings) {
  const order = ['critical', 'high', 'medium', 'info']
  const groups = order.map((severity) => ({
    severity,
    items: (findings ?? []).filter((finding) => finding.severity === severity),
  }))
  return groups.filter((group) => group.items.length > 0)
}
