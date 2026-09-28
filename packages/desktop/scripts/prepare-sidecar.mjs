/**
 * Stage the bridge + runtime + bundled skills into `src-tauri/resources/sidecar/`, the layout
 * the Rust shell expects and the Tauri bundler copies.
 *
 *   sidecar/node.exe             the runtime
 *   sidecar/claude.exe           the Claude Code CLI itself (231 MB — see below)
 *   sidecar/bridge/*.mjs         the bridge (no external dependencies)
 *   sidecar/skills/.claude/skills/modlens/   a bundled Claude Code Skill
 *   sidecar/vet/                 the vendored plugin-vet audit engine + its one dependency
 *
 * WHY THE AUDIT ENGINE SHIPS AS A CHILD PROCESS: `vendor/vet/scanner-bin/` reads one JSON request on
 * stdin and writes one JSON response on stdout. Its single non-builtin import is `typescript`, used
 * for AST predicates only, so only `lib/typescript.js` is vendored rather than the 23 MB package.
 * The engine is never imported by the bridge, which keeps a scan crash from taking down sessions.
 *
 * WHY THE SKILL LIVES UNDER `.claude/skills`: verified by probe (see _probe/skill-discovery.mjs)
 * that Claude Code discovers skills from `<root>/.claude/skills/<name>/SKILL.md` where `<root>` is
 * either the session cwd or any `--add-dir` root. Pointing `--add-dir` straight AT a skills
 * directory does NOT work. So a bundled skill needs its own root directory containing
 * `.claude/skills/`, which is what this stages.
 *
 * WHY modlens IS BUNDLED RATHER THAN FETCHED: its skill launcher falls back to
 * `npx @liustack/modlens@<ver>`, and `registry.npmjs.org` is unreachable from the target network
 * (measured at the start of this project). A skill that cannot fetch its own CLI on first use is
 * not a working skill, so the CLI and its two dependencies ship inside the installer.
 *
 * Env:
 *   CCCN_NODE          explicit node.exe to bundle (defaults to the running interpreter)
 *   CCCN_CLAUDE_BINARY explicit claude.exe to bundle (defaults to _probe/package/claude.exe)
 *   CCCN_SKIP_NODE=1   stage only the bridge and skills
 *   CCCN_SKIP_CLAUDE=1 stage without the CLI (the result needs Claude Code installed separately)
 *   CCCN_SKIP_SKILLS=1 stage without skills (bridge-only builds)
 *   CCCN_SKIP_VET=1    stage without the audit engine (bridge-only builds)
 */
import { copyFileSync, cpSync, mkdirSync, rmSync, statSync, readdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const desktopDir = join(here, '..')
const repoRoot = join(desktopDir, '..', '..')

// Staged INSIDE src-tauri/resources so exactly one copy is both the dev-time source and the
// bundled artifact (`tauri.conf.json` maps bundle.resources -> "resources/sidecar/**").
const target = join(desktopDir, 'src-tauri', 'resources', 'sidecar')
const bridgeSrc = join(repoRoot, 'packages', 'bridge', 'src')

/**
 * Vendored third-party skills, kept in-repo so a build needs no network.
 *
 * Each source package ships its skill at `<pkg>/skills/<name>/SKILL.md`, but Claude Code expects
 * `<root>/.claude/skills/<name>/SKILL.md`. So the package's `skills/` CONTENT is lifted to the
 * skill root, while the CLI payload (`dist`, `node_modules`) goes BESIDE the skill directory —
 * that is the layout the bundled launcher resolves against:
 *
 *   .claude/skills/<name>/SKILL.md          what the CLI discovers
 *   .claude/skills/<name>/dist/main.js      what the launcher runs
 *   .claude/skills/<name>/node_modules/     the CLI's dependencies
 */
const SKILL_SOURCES = [
  {
    name: 'modlens',
    from: join(repoRoot, 'vendor', 'skills', 'modlens'),
    /** Copied next to the skill folder (the CLI itself). */
    payload: ['dist', 'node_modules', 'package.json', 'README.md', 'LICENSE'],
    /** Lifted to the skill root: this is where SKILL.md and its references live. */
    skillContent: join('skills', 'modlens'),
  },
]

function log(message) {
  process.stdout.write(`[sidecar] ${message}\n`)
}

function dirSizeMB(dir) {
  let total = 0
  const walk = (p) => {
    for (const entry of readdirSync(p, { withFileTypes: true })) {
      const full = join(p, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (entry.isFile()) total += statSync(full).size
    }
  }
  walk(dir)
  return (total / 1024 / 1024).toFixed(1)
}

/**
 * Clear the staging directory, with an actionable message when it is locked.
 *
 * On Windows a RUNNING app holds the sidecar's `node.exe` open, so the delete fails with a bare
 * `EPERM ... syscall: 'rm'` that says nothing about the cause. Since the natural workflow is
 * "launch the app, notice something, rebuild", this is the expected failure rather than an exotic
 * one — so it names the fix instead of printing a stack.
 */
try {
  rmSync(target, { recursive: true, force: true })
} catch (error) {
  const locked = error?.code === 'EPERM' || error?.code === 'EBUSY' || error?.code === 'EACCES'
  console.error(
    locked
      ? `[sidecar] ERROR cannot clear ${target}\n` +
          '[sidecar]   a running claude-code-cn (or its node.exe sidecar) is holding these files.\n' +
          '[sidecar]   Close the app and rebuild:\n' +
          '[sidecar]     Get-Process claude-code-cn -ErrorAction SilentlyContinue | Stop-Process -Force'
      : `[sidecar] ERROR cannot clear ${target}: ${String(error?.message ?? error)}`,
  )
  process.exit(1)
}
mkdirSync(join(target, 'bridge'), { recursive: true })

// --- bridge -------------------------------------------------------------------
let staged = 0
for (const entry of readdirSync(bridgeSrc)) {
  if (!entry.endsWith('.mjs')) continue
  copyFileSync(join(bridgeSrc, entry), join(target, 'bridge', entry))
  staged++
}
log(`staged ${staged} bridge module(s)`)

// A package.json with type:module keeps .mjs/ESM resolution unambiguous in the bundle.
writeFileSync(
  join(target, 'bridge', 'package.json'),
  JSON.stringify({ name: 'cccn-bridge', private: true, type: 'module' }, null, 2) + '\n',
  'utf8',
)

// --- bundled skills -----------------------------------------------------------
if (process.env.CCCN_SKIP_SKILLS === '1') {
  log('CCCN_SKIP_SKILLS=1 — skills not staged')
} else {
  /**
   * The skills root is a directory whose ONLY job is to hold `.claude/skills/`. The shell adds it
   * with `--add-dir`, which makes the skills visible to every session without touching the user's
   * workspace.
   */
  const skillsRoot = join(target, 'skills')
  for (const skill of SKILL_SOURCES) {
    if (!existsSync(skill.from)) {
      log(`WARNING skill source missing, skipped: ${skill.from}`)
      continue
    }
    const dest = join(skillsRoot, '.claude', 'skills', skill.name)
    mkdirSync(dest, { recursive: true })

    for (const entry of skill.payload) {
      const src = join(skill.from, entry)
      if (!existsSync(src)) continue
      cpSync(src, join(dest, entry), { recursive: true })
    }

    // Lift the package's skill content up to the skill root, so SKILL.md lands where the CLI
    // looks for it and the launcher's `..`-relative paths resolve.
    const content = join(skill.from, skill.skillContent)
    if (existsSync(content)) {
      cpSync(content, dest, { recursive: true })
    } else {
      log(`WARNING skill content missing, SKILL.md will not be discovered: ${content}`)
    }

    log(`staged skill '${skill.name}' (${dirSizeMB(dest)} MB)`)
  }
}

// --- vendored audit engine ----------------------------------------------------
if (process.env.CCCN_SKIP_VET === '1') {
  log('CCCN_SKIP_VET=1 — audit engine not staged')
} else {
  const vetSource = join(repoRoot, 'vendor', 'vet')
  if (!existsSync(vetSource)) {
    log(`WARNING audit engine missing, security audit will report unavailable: ${vetSource}`)
  } else {
    // Copied whole: `scanner-bin/` is the engine and `node_modules/typescript/` is what makes its
    // `import ts from 'typescript'` resolve. The engine is a CHILD PROCESS, so it uses ordinary
    // node resolution from its own directory — NODE_PATH would not work for an ESM import.
    const vetDest = join(target, 'vet')
    cpSync(vetSource, vetDest, { recursive: true })
    log(`staged audit engine (${dirSizeMB(vetDest)} MB)`)
  }
}

// --- node runtime -------------------------------------------------------------
if (process.env.CCCN_SKIP_NODE === '1') {
  log('CCCN_SKIP_NODE=1 — runtime not staged')
} else {
  const nodeSource = process.env.CCCN_NODE || process.execPath
  if (!statSync(nodeSource).isFile()) {
    console.error(`[sidecar] node runtime not found: ${nodeSource}`)
    process.exit(1)
  }
  copyFileSync(nodeSource, join(target, 'node.exe'))
  const mb = (statSync(join(target, 'node.exe')).size / 1024 / 1024).toFixed(1)
  log(`staged runtime: ${nodeSource} (${mb} MB)`)
}

// --- claude.exe (the CLI itself) ----------------------------------------------
/**
 * WHY THE 231 MB CLI SHIPS INSIDE THE INSTALLER: without it the app installs and opens on a clean
 * machine but cannot run a single turn — discovery finds no `claude.exe`, so every session fails
 * with "未找到 claude.exe". Shipping it is what makes the installer self-contained; the cost is
 * that the setup exe grows from ~26 MB to ~130 MB.
 *
 * Staged BESIDE the documents-bearing sidecar directories because discovery checks
 * `<sidecar>/claude.exe` first, so both a development checkout and an installed build resolve the
 * same copy with no configuration.
 *
 * NOT downloaded: `registry.npmjs.org` is unreachable from the target network, and a build that
 * silently fetched a 231 MB binary would also produce a different product each time it ran.
 */
if (process.env.CCCN_SKIP_CLAUDE === '1') {
  log('CCCN_SKIP_CLAUDE=1 — CLI not staged (the installed app will not be able to run sessions)')
} else {
  const candidates = [
    process.env.CCCN_CLAUDE_BINARY,
    join(repoRoot, '_probe', 'package', 'claude.exe'),
  ].filter(Boolean)
  const claudeSource = candidates.find((candidate) => existsSync(candidate) && statSync(candidate).isFile())

  if (!claudeSource) {
    console.error(
      `[sidecar] ERROR no claude.exe to bundle. Looked in:\n` +
        candidates.map((candidate) => `[sidecar]   ${candidate}\n`).join('') +
        '[sidecar] Set CCCN_CLAUDE_BINARY to the CLI you want to ship, or CCCN_SKIP_CLAUDE=1 to\n' +
        '[sidecar] build an installer that requires the user to install Claude Code themselves.',
    )
    process.exit(1)
  }

  copyFileSync(claudeSource, join(target, 'claude.exe'))
  const mb = (statSync(join(target, 'claude.exe')).size / 1024 / 1024).toFixed(1)
  log(`staged CLI: ${claudeSource} (${mb} MB)`)
}

log(`done -> ${target}`)

/**
 * FAIL THE BUILD IF A STAGED DIRECTORY IS NOT LISTED IN `bundle.resources`.
 *
 * Staging something the bundler was never told about is silent: the build succeeds, the file sits in
 * `resources/`, and the installed app simply cannot find it. That is exactly how `sidecar/vet` was
 * almost lost — the audit engine staged correctly and would not have shipped, with the only symptom
 * being "审计引擎不可用" on a user's machine and never on the developer's.
 */
const confPath = join(desktopDir, 'src-tauri', 'tauri.conf.json')
try {
  const conf = JSON.parse(readFileSync(confPath, 'utf8'))
  const resources = conf?.bundle?.resources ?? []
  const listedLeaves = new Set(resources.map((entry) => entry.split(/[\\/]/).pop()))
  const stagedEntries = readdirSync(target)
  const missing = stagedEntries.filter((entry) => !listedLeaves.has(entry))
  if (missing.length > 0) {
    console.error(
      `[sidecar] ERROR staged but NOT in bundle.resources: ${missing.join(', ')}\n` +
        `[sidecar] add them to ${confPath} or the packaged app will not contain them`,
    )
    process.exit(1)
  }
  log(`bundle.resources covers all ${stagedEntries.length} staged entries`)
} catch (error) {
  console.error(`[sidecar] ERROR could not verify bundle.resources: ${String(error.message ?? error)}`)
  process.exit(1)
}

/**
 * FAIL THE BUILD IF A BRIDGE MODULE WAS NOT STAGED.
 *
 * The sibling failure to the one above: a stale sidecar. `tauri build` copies whatever is in
 * `resources/sidecar`, so a bridge module added after the last staging simply does not ship — and
 * the symptom is a 404 from a route that exists in the source and passes every test. That happened:
 * `attachments.mjs` and `balance.mjs` were missing from a built installer.
 *
 * Comparing NAMES (not contents) is deliberate: contents change constantly during development and
 * this runs on every build, while a missing file is always a mistake.
 */
try {
  const sourceModules = readdirSync(bridgeSrc).filter((entry) => entry.endsWith('.mjs'))
  const stagedModules = readdirSync(join(target, 'bridge')).filter((entry) => entry.endsWith('.mjs'))
  const absent = sourceModules.filter((entry) => !stagedModules.includes(entry))
  if (absent.length > 0) {
    console.error(`[sidecar] ERROR bridge module(s) not staged: ${absent.join(', ')}`)
    process.exit(1)
  }
  log(`all ${sourceModules.length} bridge module(s) present in the sidecar`)
} catch (error) {
  console.error(`[sidecar] ERROR could not verify staged bridge modules: ${String(error.message ?? error)}`)
  process.exit(1)
}
