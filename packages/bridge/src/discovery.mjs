/**
 * Environment discovery: find the claude.exe binary and read the CLI's own config files.
 *
 * The desktop app must work on first launch without the user hand-editing paths, so
 * discovery is a first-class capability rather than a hardcoded constant.
 */
import { existsSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const HOME = homedir()

/** Candidate locations, most specific first. */
export function candidateBinaryPaths(bundledDir) {
  const list = []
  // Shipped with the app, so an installed build needs no separate Claude Code installation.
  if (bundledDir) list.push(join(bundledDir, 'claude.exe'), join(bundledDir, 'claude'))
  // npm global wrapper installed from the mirror
  list.push(join(process.env.APPDATA ?? '', 'npm', 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe'))
  // native package hoisted inside a pnpm store
  list.push(join(HOME, '.claude', 'local', 'claude.exe'))
  list.push(join(process.env.LOCALAPPDATA ?? '', 'claude-code', 'claude.exe'))
  return list.filter(Boolean)
}

/** Locate a usable claude.exe. Returns { path, source } or null. */
export function findBinary(bundledDir) {
  for (const path of candidateBinaryPaths(bundledDir)) {
    try {
      if (existsSync(path) && statSync(path).size > 4096) return { path, source: 'filesystem' }
    } catch {
      /* unreadable candidate */
    }
  }
  const onPath = which('claude.exe') ?? which('claude')
  if (onPath) return { path: onPath, source: 'PATH' }
  return null
}

/** Minimal `which` that also understands PATHEXT. */
export function which(name) {
  const pathValue = process.env.PATH ?? ''
  const exts = name.endsWith('.exe') ? [''] : (process.env.PATHEXT ?? '.EXE').split(';')
  for (const dir of pathValue.split(';')) {
    if (!dir) continue
    for (const ext of exts) {
      const candidate = join(dir, name + ext)
      try {
        if (existsSync(candidate)) return candidate
      } catch {
        /* skip */
      }
    }
  }
  return null
}

function readJsonSafe(path) {
  try {
    if (!existsSync(path)) return null
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return null
  }
}

/** Read the CLI's own state, tolerating every file being absent. */
export function readClaudeState() {
  const configPath = join(HOME, '.claude.json')
  const config = readJsonSafe(configPath)
  const settingsPath = join(HOME, '.claude', 'settings.json')
  const settings = readJsonSafe(settingsPath)

  let projectCount = 0
  if (config && typeof config.projects === 'object' && config.projects !== null) {
    projectCount = Object.keys(config.projects).length
  }

  return {
    home: HOME,
    configPath: existsSync(configPath) ? configPath : null,
    settingsPath: existsSync(settingsPath) ? settingsPath : null,
    installMethod: config?.installMethod ?? null,
    firstStartTime: config?.firstStartTime ?? null,
    userId: config?.userID ? String(config.userID).slice(0, 12) + '…' : null,
    projectCount,
    hasSettings: settings !== null,
    mcpServers: config?.mcpServers ? Object.keys(config.mcpServers) : [],
  }
}

/** A cheap, bounded workspace listing for the "recent folders" affordance. */
export function listUserProjects(limit = 12) {
  const config = readJsonSafe(join(HOME, '.claude.json'))
  const projects = config?.projects
  if (!projects || typeof projects !== 'object') return []
  return Object.entries(projects)
    .map(([path, value]) => ({
      path,
      lastUsed: value?.lastCost ? null : (value?.history?.[0]?.timestamp ?? null),
      turns: Array.isArray(value?.history) ? value.history.length : 0,
    }))
    .filter((entry) => {
      try {
        return existsSync(entry.path) && statSync(entry.path).isDirectory()
      } catch {
        return false
      }
    })
    .sort((a, b) => b.turns - a.turns)
    .slice(0, limit)
}

/** Node runtime identity, useful for diagnosing a broken sidecar. */
export function runtimeInfo() {
  return {
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    execPath: process.execPath,
    isPackaged: Boolean(process.env.CCCN_PACKAGED),
  }
}

export function createScanner(options = {}) {
  const bundledDir = options.bundledDir
  /**
   * The binary the entry point already resolved, reported verbatim rather than re-derived.
   *
   * Carries its own `source` ('flag' | 'filesystem' | 'PATH') so the UI can say WHERE the CLI came
   * from — labelling everything 'flag' would tell a user who never passed a flag that they did.
   */
  const resolved = options.resolvedBinary ?? null
  let cache = null
  let cacheAt = 0
  const TTL = 10_000

  return {
    scan(force = false) {
      const now = Date.now()
      if (!force && cache && now - cacheAt < TTL) return cache

      const binary = resolved ?? findBinary(bundledDir)
      cache = {
        binary,
        baseUrl: process.env.CCCN_BASE_URL ?? null,
        hasCredential: Boolean(process.env.CCCN_AUTH_TOKEN),
        claude: readClaudeState(),
        runtime: runtimeInfo(),
        projects: listUserProjects(),
      }
      cacheAt = now
      return cache
    },
  }
}
