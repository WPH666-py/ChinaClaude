/**
 * Workspace workbench: file tree, file preview, content search, and change review.
 *
 * WHY THIS LIVES IN THE BRIDGE AND NOT IN THE WEBVIEW: the webview has no filesystem access (the CSP
 * forbids it), and a phone on the LAN must see the same tree. Every path here is therefore resolved
 * and confined server-side — the page names a workspace and a relative path, never an absolute one it
 * invented.
 *
 * WHY IT IS SEPARATE FROM `checkpoints.mjs` AND `gitpanel.mjs`: those own SNAPSHOTS and GIT. This module
 * answers "what is in the workspace right now", so the review view can show a change next to the file
 * it changed instead of only inside a diff tab.
 */
import { readdirSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { extname, isAbsolute, join, normalize, relative, resolve, sep } from 'node:path'

import { gitDiff, gitStatus } from './gitpanel.mjs'

/** A text preview is a preview: past this the user should open the file in an editor. */
const MAX_TEXT_BYTES = 1024 * 1024
/** Images are inlined as data URLs, so they get a tighter cap than text. */
const MAX_IMAGE_BYTES = 8 * 1024 * 1024
const MAX_TREE_ENTRIES = 400
const MAX_SEARCH_FILES = 4000
const MAX_SEARCH_HITS = 100
const MAX_SEARCH_FILE_BYTES = 512 * 1024
/** Directories that make a tree unreadable and are never what the user is looking for. */
const HEAVY_DIRS = new Set(['node_modules', '.git', 'target', 'dist', '.pnpm-store', '__pycache__'])
const IMAGE_TYPES = new Map([
  ['.png', 'image/png'],
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.gif', 'image/gif'],
  ['.webp', 'image/webp'],
  ['.bmp', 'image/bmp'],
  ['.ico', 'image/x-icon'],
  ['.svg', 'image/svg+xml'],
])
/** Extensions the highlighter knows; anything else renders as plain text. */
const LANGUAGES = new Map(
  Object.entries({
    '.js': 'javascript',
    '.mjs': 'javascript',
    '.cjs': 'javascript',
    '.ts': 'typescript',
    '.mts': 'typescript',
    '.tsx': 'tsx',
    '.jsx': 'jsx',
    '.vue': 'vue',
    '.json': 'json',
    '.md': 'markdown',
    '.py': 'python',
    '.rs': 'rust',
    '.toml': 'toml',
    '.yml': 'yaml',
    '.yaml': 'yaml',
    '.css': 'css',
    '.html': 'html',
    '.sh': 'bash',
    '.ps1': 'powershell',
    '.sql': 'sql',
    '.go': 'go',
    '.java': 'java',
    '.c': 'c',
    '.h': 'c',
    '.cpp': 'cpp',
    '.cs': 'csharp',
    '.rb': 'ruby',
    '.php': 'php',
    '.m': 'matlab',
    '.r': 'r',
    '.jl': 'julia',
    '.lua': 'lua',
    '.kt': 'kotlin',
    '.swift': 'swift',
    '.dart': 'dart',
    '.xml': 'xml',
    '.ini': 'ini',
    '.txt': 'text',
  })
)
/** Extensions that are never searched: binary content would only produce mojibake hits. */
const BINARY_EXTENSIONS = new Set([
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.webp',
  '.bmp',
  '.ico',
  '.pdf',
  '.zip',
  '.gz',
  '.7z',
  '.rar',
  '.exe',
  '.dll',
  '.node',
  '.wasm',
  '.mp4',
  '.mp3',
  '.wav',
  '.ttf',
  '.woff',
  '.woff2',
  '.docx',
  '.xlsx',
  '.pptx',
  '.pyc',
  '.class',
  '.jar',
])

/**
 * Resolve a workspace-relative path and prove it stays inside the workspace.
 *
 * WHY `realpath` ON BOTH SIDES: comparing resolved strings is not enough on Windows or with symlinks —
 * `cwd\link\..\..\secret` normalises to something inside while the link points outside. The real path
 * of the target (when it exists) is the only form that answers "where does this actually land".
 */
function confine(cwd, requested) {
  const rawCwd = String(cwd ?? '').trim()
  if (rawCwd === '') return { ok: false, error: '请先选择一个工作目录' }
  if (!isAbsolute(rawCwd)) return { ok: false, error: `需要一个绝对路径，收到的是：${rawCwd}` }

  let root
  try {
    root = realpathSync(normalize(rawCwd))
  } catch {
    return { ok: false, error: `目录不存在：${rawCwd}` }
  }
  try {
    if (!statSync(root).isDirectory()) return { ok: false, error: `这不是一个目录：${rawCwd}` }
  } catch {
    return { ok: false, error: `目录不可访问：${rawCwd}` }
  }

  const relativePath = String(requested ?? '').trim().replace(/^[\\/]+/, '')
  if (isAbsolute(relativePath)) {
    // A page sending an absolute path is guessing; refuse rather than silently re-root it.
    return { ok: false, error: `路径必须是工作区内的相对路径，收到的是：${relativePath}` }
  }

  const candidate = resolve(root, relativePath)
  let real = candidate
  let exists = true
  try {
    real = realpathSync(candidate)
  } catch {
    exists = false
  }

  const inside = real === root || real.startsWith(root.endsWith(sep) ? root : root + sep)
  if (!inside) return { ok: false, error: '路径越出了工作区，已拒绝' }

  return {
    ok: true,
    root,
    absolute: real,
    relative: relative(root, candidate).split(sep).join('/'),
    exists,
  }
}

function kindFor(extension) {
  if (extension === '.md' || extension === '.markdown') return 'markdown'
  if (IMAGE_TYPES.has(extension)) return 'image'
  if (BINARY_EXTENSIONS.has(extension)) return 'binary'
  return 'text'
}

function entryFor(absolute, root, name) {
  let stats
  try {
    stats = statSync(absolute)
  } catch {
    return null
  }
  const isDirectory = stats.isDirectory()
  return {
    name,
    path: relative(root, absolute).split(sep).join('/'),
    type: isDirectory ? 'dir' : 'file',
    size: isDirectory ? 0 : stats.size,
    mtime: Math.round(stats.mtimeMs),
    heavy: isDirectory && HEAVY_DIRS.has(name),
  }
}

/**
 * One directory level. Lazy by design: a tree that walks the whole workspace up front takes seconds on
 * a checkout with `node_modules`, and the user is looking at one folder.
 */
export function workbenchTree({ cwd, path = '' } = {}) {
  const at = confine(cwd, path)
  if (!at.ok) return at
  if (!at.exists) return { ok: false, error: `目录不存在：${at.relative || '.'}` }

  let stats
  try {
    stats = statSync(at.absolute)
  } catch {
    return { ok: false, error: `无法读取：${at.relative || '.'}` }
  }
  if (!stats.isDirectory()) return { ok: false, error: `不是目录：${at.relative || '.'}` }

  let dirents
  try {
    dirents = readdirSync(at.absolute, { withFileTypes: true })
  } catch (problem) {
    return { ok: false, error: `无法列出目录：${problem?.message ?? problem}` }
  }

  const entries = []
  let hidden = 0
  for (const dirent of dirents) {
    // Hidden files are shown: `.gitignore`, `.env.example` and `.claude/` are exactly what a developer
    // opens a workspace to look at. Only the heavy directories are collapsed.
    const entry = entryFor(join(at.absolute, dirent.name), at.root, dirent.name)
    if (!entry) continue
    if (entries.length >= MAX_TREE_ENTRIES) {
      hidden += 1
      continue
    }
    entries.push(entry)
  }

  entries.sort((a, b) => {
    if (a.type !== b.type) return a.type === 'dir' ? -1 : 1
    return a.name.localeCompare(b.name, 'zh-Hans-CN')
  })

  return {
    ok: true,
    cwd: at.root,
    path: at.relative,
    parent: at.relative === '' ? null : at.relative.split('/').slice(0, -1).join('/'),
    entries,
    hidden,
  }
}

/** Preview one file. Text is decoded as UTF-8; images become data URLs so no second route is needed. */
export function workbenchFile({ cwd, path } = {}) {
  const at = confine(cwd, path)
  if (!at.ok) return at
  if (!at.exists) return { ok: false, error: `文件不存在：${at.relative}` }

  let stats
  try {
    stats = statSync(at.absolute)
  } catch {
    return { ok: false, error: `无法读取：${at.relative}` }
  }
  if (stats.isDirectory()) return { ok: false, error: `${at.relative} 是目录，不是文件`, kind: 'dir' }

  const extension = extname(at.absolute).toLowerCase()
  const kind = kindFor(extension)
  const base = {
    ok: true,
    path: at.relative,
    name: at.relative.split('/').pop() ?? at.relative,
    size: stats.size,
    mtime: Math.round(stats.mtimeMs),
    language: LANGUAGES.get(extension) ?? (kind === 'text' ? 'text' : undefined),
    kind,
  }

  if (kind === 'image') {
    if (stats.size > MAX_IMAGE_BYTES) {
      return { ...base, kind: 'binary', error: null, tooBig: true, hint: `图片超过 ${Math.round(MAX_IMAGE_BYTES / 1024 / 1024)} MB，未内联预览` }
    }
    try {
      const data = readFileSync(at.absolute)
      return { ...base, dataUrl: `data:${IMAGE_TYPES.get(extension)};base64,${data.toString('base64')}` }
    } catch (problem) {
      return { ...base, ok: false, error: `无法读取：${problem?.message ?? problem}` }
    }
  }

  if (kind === 'binary') {
    return { ...base, tooBig: false, hint: '二进制文件不提供内容预览' }
  }

  const truncated = stats.size > MAX_TEXT_BYTES
  try {
    const buffer = readFileSync(at.absolute)
    /**
     * Sniff before promising text. The extension list cannot know every binary format (`.bin`,
     * `.dat`, object files, custom models), and rendering NUL bytes as a "text" preview is worse
     * than saying "binary": it looks like a decoding bug in the panel.
     */
    const sniff = buffer.subarray(0, 8192)
    if (sniff.includes(0)) {
      return { ...base, kind: 'binary', hint: '内容看起来是二进制，未提供预览' }
    }
    const slice = truncated ? buffer.subarray(0, MAX_TEXT_BYTES) : buffer
    return {
      ...base,
      text: slice.toString('utf8'),
      truncated,
      ...(truncated ? { hint: `只显示前 ${Math.round(MAX_TEXT_BYTES / 1024)} KB` } : {}),
    }
  } catch (problem) {
    return { ...base, ok: false, error: `无法读取：${problem?.message ?? problem}` }
  }
}

/**
 * Content search inside the workspace.
 *
 * A plain substring scan, bounded by file count and size: the workbench is for "where is this string",
 * not for regex features, and a bound is what keeps a search from freezing the bridge for a minute on
 * a large checkout.
 */
export function workbenchSearch({ cwd, query, limit } = {}) {
  const needle = String(query ?? '')
  if (needle.trim() === '') return { ok: false, error: '请输入要搜索的内容' }
  const at = confine(cwd, '')
  if (!at.ok) return at

  const maxHits = Math.min(Number(limit) > 0 ? Number(limit) : MAX_SEARCH_HITS, MAX_SEARCH_HITS)
  const lowered = needle.toLowerCase()
  const hits = []
  let scanned = 0
  let skipped = 0
  let capped = false

  const walk = (dir) => {
    if (capped) return
    let dirents
    try {
      dirents = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const dirent of dirents) {
      if (capped) return
      const absolute = join(dir, dirent.name)
      if (dirent.isDirectory()) {
        if (HEAVY_DIRS.has(dirent.name)) {
          skipped += 1
          continue
        }
        walk(absolute)
        continue
      }
      if (!dirent.isFile()) continue
      const extension = extname(dirent.name).toLowerCase()
      if (BINARY_EXTENSIONS.has(extension)) continue
      if (scanned >= MAX_SEARCH_FILES) {
        capped = true
        return
      }
      scanned += 1

      let stats
      try {
        stats = statSync(absolute)
      } catch {
        continue
      }
      if (stats.size > MAX_SEARCH_FILE_BYTES) continue

      let text
      try {
        text = readFileSync(absolute, 'utf8')
      } catch {
        continue
      }
      if (text.includes('\u0000')) continue

      const relativePath = relative(at.root, absolute).split(sep).join('/')
      const lines = text.split(/\r?\n/)
      for (let index = 0; index < lines.length; index++) {
        const line = lines[index]
        if (!line.toLowerCase().includes(lowered)) continue
        hits.push({
          path: relativePath,
          line: index + 1,
          text: line.length > 240 ? `${line.slice(0, 240)}…` : line,
        })
        if (hits.length >= maxHits) {
          capped = true
          return
        }
      }
    }
  }

  walk(at.root)
  return { ok: true, cwd: at.root, query: needle, hits, scanned, skipped, capped }
}

/**
 * What changed in the workspace, for the review tab.
 *
 * Two sources, deliberately kept apart: git knows about tracked edits (staged and unstaged), and the
 * untracked list is the only place a brand-new file shows up. A repository that is absent or broken
 * degrades to `git.ok === false` with a sentence — the tree and preview must keep working.
 */
export async function workbenchChanges({ cwd } = {}) {
  const at = confine(cwd, '')
  if (!at.ok) return at

  const status = await gitStatus({ cwd: at.root })
  if (!status?.ok) {
    return {
      ok: true,
      cwd: at.root,
      git: {
        ok: false,
        available: status?.available !== false,
        error: status?.error ?? '无法读取 git 状态',
        hint: status?.hint ?? null,
      },
      files: [],
      diff: '',
    }
  }

  const files = Array.isArray(status.files) ? status.files : []
  const diff = await gitDiff({ cwd: at.root })
  return {
    ok: true,
    cwd: at.root,
    git: { ok: true, branch: status.branch ?? null, ahead: status.ahead ?? null, behind: status.behind ?? null },
    files,
    diff: typeof diff?.diff === 'string' ? diff.diff : '',
  }
}
