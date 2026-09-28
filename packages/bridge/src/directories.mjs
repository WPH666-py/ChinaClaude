/**
 * Directory browser support for the workspace picker.
 *
 * The UI must let the user pick a folder, not type one. This module answers "what is in this
 * directory" and "where can the user reasonably start from" for the bridge.
 *
 * Only directories are listed: the picker chooses a workspace root, so files are noise. The
 * listing is deliberately shallow (one level per request) so browsing a huge tree stays cheap
 * and the response stays small enough to render instantly.
 */
import { existsSync, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, normalize, parse, resolve, sep } from 'node:path'

const HOME = homedir()

/**
 * Entries that are never useful as a workspace root and only add noise.
 *
 * The legacy shell folders (Cookies, NetHood, PrintHood, Recent, SendTo, Templates, ...) are
 * compatibility junctions inside a user profile. Explorer hides them by default and every one
 * of them triggers a UAC prompt when opened, so listing them would make the picker look
 * broken. `includeHidden` reveals them for the rare case they are wanted.
 */
const NOISE = new Set([
  '$RECYCLE.BIN',
  'System Volume Information',
  'node_modules',
  '.git',
  'AppData',
  'Application Data',
  'Cookies',
  'Local Settings',
  'My Documents',
  'NetHood',
  'PrintHood',
  'Recent',
  'SendTo',
  'Start Menu',
  'Templates',
  'History',
  'Temporary Internet Files',
  '「开始」菜单',
  '[开始] 菜单',
])

/**
 * Starting points for the picker.
 *
 * Drives are enumerated on Windows because "which drive is my project on" is the first real
 * question; the well-known user folders cover the common case.
 */
export function listRoots() {
  const roots = []

  const push = (label, path) => {
    try {
      if (existsSync(path) && statSync(path).isDirectory()) roots.push({ label, path })
    } catch {
      /* unreadable candidate */
    }
  }

  push('主目录', HOME)
  push('桌面', join(HOME, 'Desktop'))
  push('文档', join(HOME, 'Documents'))
  push('下载', join(HOME, 'Downloads'))

  if (process.platform === 'win32') {
    for (let code = 65; code <= 90; code++) {
      const letter = String.fromCharCode(code)
      const drive = `${letter}:\\`
      try {
        if (existsSync(drive)) roots.push({ label: `${letter}: 盘`, path: drive })
      } catch {
        /* absent drive */
      }
    }
  } else {
    push('根目录', '/')
  }

  return roots
}

/** Resolve user input into an absolute path, tolerating `~` and relative fragments. */
export function resolveInputPath(input) {
  if (!input || typeof input !== 'string') return HOME
  let text = input.trim()
  if (!text) return HOME
  if (text === '~') return HOME
  if (text.startsWith('~' + sep) || text.startsWith('~/')) {
    text = join(HOME, text.slice(2))
  }
  return isAbsolute(text) ? normalize(text) : resolve(text)
}

/**
 * List the child directories of `path`.
 *
 * @returns {{ path: string, parent: string|null, entries: Array<{name:string,path:string}> }}
 */
export function listDirectories(path, options = {}) {
  const includeHidden = options.includeHidden === true
  const target = resolveInputPath(path)

  if (!existsSync(target)) {
    const error = new Error(`目录不存在: ${target}`)
    error.code = 'ENOENT'
    throw error
  }
  const stats = statSync(target)
  if (!stats.isDirectory()) {
    const error = new Error(`不是目录: ${target}`)
    error.code = 'ENOTDIR'
    throw error
  }

  const entries = []
  for (const dirent of readdirSync(target, { withFileTypes: true })) {
    // Symlinked directories report isSymbolicLink(); resolve before trusting them.
    let isDirectory = dirent.isDirectory()
    if (!isDirectory && dirent.isSymbolicLink()) {
      try {
        isDirectory = statSync(join(target, dirent.name)).isDirectory()
      } catch {
        isDirectory = false
      }
    }
    if (!isDirectory) continue
    if (!includeHidden && NOISE.has(dirent.name)) continue
    if (!includeHidden && dirent.name.startsWith('.')) continue

    entries.push({ name: dirent.name, path: join(target, dirent.name) })
  }

  entries.sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'))

  const root = parse(target).root
  const parent = target === root ? null : dirname(target)

  return {
    path: target,
    name: basename(target) || target,
    parent,
    isRoot: target === root,
    entries,
  }
}
