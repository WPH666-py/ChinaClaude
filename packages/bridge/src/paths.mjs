/**
 * Where this app is allowed to keep data of its own.
 *
 * WHY A SINGLE RESOLVER: every feature added alongside the menu bar (logs, memory, rules,
 * checkpoints, feedback, protection stats) needs a writable directory, and each one inventing its
 * own path is how a desktop app ends up scattering state across three dotfolders that nobody can
 * find or clean up. One resolver also makes the location overridable for tests and for a portable
 * install, which is the difference between "we can test the store" and "we can only test it on the
 * machine that happens to have the file".
 *
 * The directory is decided once, at module load, so a caller can never see two different answers
 * within one process.
 */
import { mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/**
 * The per-user data root.
 *
 * `CCCN_DATA_DIR` wins so tests (and a portable build) can point somewhere disposable. Windows then
 * uses `%LOCALAPPDATA%` — deliberately LOCAL rather than ROAMING: checkpoints and attachment copies
 * are large and machine-specific, and letting them roam would sync gigabytes through a domain
 * profile for no benefit.
 */
export function dataRoot() {
  const override = process.env.CCCN_DATA_DIR
  if (override && override.trim()) return override.trim()

  if (process.platform === 'win32') {
    const local = process.env.LOCALAPPDATA
    if (local && local.trim()) return join(local.trim(), 'ChinaClaude')
    return join(homedir(), 'AppData', 'Local', 'ChinaClaude')
  }

  const xdg = process.env.XDG_DATA_HOME
  if (xdg && xdg.trim()) return join(xdg.trim(), 'ChinaClaude')
  return join(homedir(), '.local', 'share', 'ChinaClaude')
}

const ROOT = dataRoot()

/** Create `dir` (and its parents) if needed, then return it. Never throws for an existing path. */
export function ensureDir(dir) {
  mkdirSync(dir, { recursive: true })
  return dir
}

/** The data root itself, created on first use. */
export function ensureRoot() {
  return ensureDir(ROOT)
}

/** Absolute path of `name` inside the data root; the parent directory is created. */
export function dataFile(name) {
  ensureRoot()
  return join(ROOT, name)
}

/** Absolute path of `name` inside `sub`, creating both directories. */
export function dataSubFile(sub, name) {
  return join(ensureDir(join(ROOT, sub)), name)
}

/** Directory for one feature, created on demand. */
export function dataSubDir(sub) {
  return ensureDir(join(ROOT, sub))
}

/** Where the bridge writes its own rolling log file. */
export function logsDir() {
  return dataSubDir('logs')
}

export { ROOT as DATA_ROOT }
