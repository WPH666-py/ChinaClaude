/**
 * Time machine: workspace checkpoints kept as file copies, not as git commits.
 *
 * WHY THIS DOES NOT USE GIT: the machines this client ships to are not assumed to have git at all,
 * and a checkpoint that only works inside a repository is useless for the rest of a workspace. A copy
 * store has no external dependency, no index to corrupt, and no repository to be "inside" of.
 *
 * WHY A COPY PER SNAPSHOT INSTEAD OF A PATCH CHAIN: patches are smaller, but restoring through them
 * needs every link intact and a byte-exact application, so one corrupt object makes the entire
 * history unreadable. Copies are bounded by the caps below, deletable one directory at a time, and
 * restore with a single rename. Disk is cheap; a rollback that fails is not.
 *
 * WHY EVERYTHING IS ASYNC: this module runs inside the bridge process, which is simultaneously
 * streaming CLI output to the UI over SSE. A blocking 200 MB copy would freeze every open session's
 * UI, so the walk and the writes are awaited and the event loop can interleave between files.
 *
 * WHY NOTHING THROWS: the only caller is an HTTP route that must answer with something the panel can
 * display. Every exported function resolves to `{ ok: false, error }` carrying a Chinese message
 * instead of rejecting.
 *
 * Store layout — every path comes from ./paths.mjs; nothing here invents one:
 *   <DATA_ROOT>/checkpoints/<slug>+<shorthash-of-cwd>/<id>/manifest.json
 *   <DATA_ROOT>/checkpoints/<slug>+<shorthash-of-cwd>/<id>/files/<workspace-relative path>
 * The `+<hash>` half of the workspace key is what stops two projects that happen to share a folder
 * name — the usual `project`, `src`, `app` — from writing into one store.
 *
 * Result shapes (the panel and the route depend on these):
 *   listCheckpoints  -> { ok, cwd, store, items:[{id,label,at,fileCount,bytes,note}] } newest first
 *   createCheckpoint -> { ok, item, skipped:string[], pruned?:string[] }
 *   diffCheckpoint   -> { ok, entries:[{path,status,added,removed,binary}] }
 *   restoreCheckpoint-> { ok, restored:string[], deleted:string[], kept:string[], keptTotal, skipped }
 *   deleteCheckpoint -> { ok, deleted:true }
 *   checkpointUsage  -> { ok, root, count, bytes }
 * `createCheckpoint.skipped` is a list of ready-to-display Chinese lines, because "this snapshot left
 * out half the project" is exactly the thing the user has to be told. `restoreCheckpoint.skipped`
 * stays structured ({path, reason}) since each entry answers "why was THIS file not restored".
 *
 * `restoreCheckpoint.files` is a subset of workspace-relative paths. Omitting it (undefined or null)
 * restores the whole snapshot. An EMPTY array is rejected rather than read as "everything": the one
 * caller that can produce an empty selection is the panel, and turning an empty checkbox set into a
 * full rollback is the most destructive possible misreading.
 */
import { createHash, randomBytes } from 'node:crypto'
import { existsSync, statSync } from 'node:fs'
import {
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { dataSubDir } from './paths.mjs'

/**
 * Directories a snapshot never enters.
 *
 * These are the folders that are either regenerable (build output, caches, byte-compiled trees) or
 * enormous (installed dependencies). Copying them would multiply snapshot size by an order of
 * magnitude and would restore hundreds of thousands of files that the package manager owns — the
 * user's own edits are not in there. Matched case-insensitively because Windows folder names are.
 */
const SKIP_DIRS = new Set([
  '.git',
  'node_modules',
  '.venv',
  'venv',
  '__pycache__',
  'dist',
  'build',
  '.next',
  'target',
  '.cache',
])

/** Per-file ceiling. Past this, "a checkpoint" would start meaning "a backup of my media folder". */
const MAX_FILE_BYTES = 5 * 1024 * 1024

/**
 * Per-snapshot ceiling.
 *
 * The walk STOPS at this point instead of silently including whatever comes next: a snapshot that
 * covers an arbitrary prefix of a huge workspace must say so through `skipped`, which is why hitting
 * this cap records a line the UI shows rather than quietly finishing the scan.
 */
const MAX_SNAPSHOT_BYTES = 200 * 1024 * 1024

/**
 * Bounds for the +/- line counts.
 *
 * The panel shows two numbers, not a diff, so this is a reporting budget rather than a correctness
 * one: over ~1 MB or ~20k lines the file is reported as `binary` (counts unavailable) instead of
 * spending seconds in a comparison nobody asked to see. MAX_LCS_CELLS bounds the exact LCS table, so
 * the worst case stays O(n) through the line-multiset fallback rather than O(n*m) at 20k lines.
 */
const MAX_COUNT_BYTES = 1024 * 1024
const MAX_COUNT_LINES = 20_000
const MAX_LCS_CELLS = 4_000_000

/**
 * How many skip lines are reported verbatim.
 *
 * A workspace can contain thousands of oversized files; the point of `skipped` is to explain the
 * shape of the snapshot, and 60 lines do that. The remainder is summarised as a count so the total
 * is never understated.
 */
const MAX_SKIPPED_REPORTED = 60

/** How many "extra" workspace paths a restore reports. Same reasoning as the skip cap. */
const MAX_KEPT_REPORTED = 200

/** Newest-N retention per workspace. Overridable for tests and for a portable install. */
const DEFAULT_MAX_SNAPSHOTS = 20

/** Byte sample inspected for NUL when guessing whether a file is text. Enough for every real one. */
const NUL_SAMPLE_BYTES = 8000

/**
 * Snapshot ids are our own generated names, but they arrive back from the page on diff/restore/delete
 * and get joined onto a directory. Anchoring them to a charset with no separators, no colon and no
 * leading dot is what makes `id = '../..'` a rejected value instead of a deleted data root.
 */
const ID_PATTERN = /^[0-9A-Za-z][0-9A-Za-z._-]{0,63}$/

/** The checkpoints root, created on first use (the parent is created by paths.mjs). */
function storeRoot() {
  return dataSubDir('checkpoints')
}

/** `String(error)` on an Error gives "Error: ..."; the message alone is what a Chinese line wants. */
function message(error) {
  return String(error?.message ?? error)
}

function errorCode(error) {
  return String(error?.code ?? '')
}

function megabytes(bytes) {
  return `${(bytes / 1024 / 1024).toFixed(bytes >= 10 * 1024 * 1024 ? 0 : 1)} MB`
}

/** Windows compares paths case-insensitively, so every comparison here goes through this. */
function canonicalPath(path) {
  const resolved = resolve(path)
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved
}

/**
 * True when `child` is `parent` itself or lives underneath it.
 *
 * `relative` is the only correct primitive here: a plain `startsWith` would accept `D:\work2` as
 * inside `D:\work`, and on Windows `relative` also returns an absolute path when the two inputs are
 * on different drives, which the isAbsolute branch catches.
 */
function isInsideOrEqual(child, parent) {
  const from = canonicalPath(parent)
  const to = canonicalPath(child)
  if (from === to) return true
  const rel = relative(from, to)
  if (rel === '') return true
  if (isAbsolute(rel)) return false
  return rel !== '..' && !rel.startsWith(`..${sep}`)
}

/** Readable half of a store key: lowercase, ASCII letters/digits plus CJK, dashes between runs. */
function slugify(name) {
  const text = String(name ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fff]+/g, '-')
    .replace(/^-+/, '')
  return text.slice(0, 32).replace(/-+$/, '')
}

/**
 * One directory name per workspace: `<slug>+<shorthash-of-cwd>`.
 *
 * The hash is over the CANONICAL path, so `D:\Work\App` and `d:\work\app` share one store (they are
 * one directory on Windows) while `D:\a\app` and `E:\b\app` never do. The slug is only for the human
 * reading the data directory — nothing is keyed by it.
 */
function workspaceKey(cwd) {
  const resolved = resolve(cwd)
  const hash = createHash('sha256').update(canonicalPath(resolved)).digest('hex').slice(0, 12)
  return `${slugify(basename(resolved)) || 'workspace'}+${hash}`
}

function storeFor(cwd) {
  return join(storeRoot(), workspaceKey(cwd))
}

/**
 * Validate a working directory before anything else touches the filesystem.
 *
 * Sync on purpose: it is one stat against a path that is about to be walked, and doing it here keeps
 * "is there even a workspace" out of every downstream try/catch.
 */
function checkCwd(cwd) {
  const text = String(cwd ?? '').trim()
  if (!text) return { ok: false, error: '缺少工作目录' }
  const resolved = resolve(text)
  if (!existsSync(resolved)) return { ok: false, error: '工作目录不存在' }
  try {
    if (!statSync(resolved).isDirectory()) return { ok: false, error: '工作目录不是一个文件夹' }
  } catch (error) {
    return { ok: false, error: `无法访问工作目录：${message(error)}` }
  }
  return { ok: true, path: resolved }
}

/** A snapshot id from the page, or null when it could escape the store directory. */
function safeId(id) {
  const text = String(id ?? '')
  if (!ID_PATTERN.test(text)) return null
  if (text.includes('..')) return null
  return text
}

/** Sortable id: compact UTC stamp first so a plain directory listing is already in time order. */
function newSnapshotId() {
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z')
  return `${stamp}-${randomBytes(3).toString('hex')}`
}

/** Local-time label for an unnamed snapshot; built by hand so it cannot depend on ICU data. */
function localStamp(date) {
  const pad = (value) => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

function defaultMaxSnapshots() {
  const raw = Number(process.env.CCCN_MAX_SNAPSHOTS)
  return Number.isFinite(raw) && raw >= 1 ? Math.floor(raw) : DEFAULT_MAX_SNAPSHOTS
}

/**
 * Structural validation of a workspace-relative path sent by the page.
 *
 * Rejected here, before any filesystem work: empty strings, NUL, absolute paths in either separator
 * style, UNC prefixes, any `..` segment, and drive-relative Windows forms (`C:foo`) — the last one
 * matters because `resolve('C:foo')` silently means "foo under the current directory of drive C",
 * which no containment check downstream would flag as suspicious.
 */
function relativePathIssue(raw) {
  const text = String(raw ?? '')
  if (!text.trim()) return '路径为空'
  if (text.includes('\0')) return '路径包含非法字符'
  const unified = text.replace(/\\/g, '/')
  if (unified.startsWith('/')) return '不接受绝对路径'
  if (unified.startsWith('//')) return '不接受网络路径'
  if (/^[A-Za-z]:/.test(unified)) return '不接受盘符路径'
  const segments = unified.split('/')
  if (segments.some((segment) => segment === '..')) return '路径越出工作目录'
  if (segments.some((segment) => segment === '')) return '路径格式不正确'
  return null
}

/** Normalize a validated path to the `/`-separated form used in manifests and on disk. */
function normalizeRelative(raw) {
  return String(raw ?? '')
    .replace(/\\/g, '/')
    .replace(/^\.\//, '')
}

/**
 * Resolve where a restored file may actually be written, following no symlink out of the workspace.
 *
 * The check happens on the REAL path of the deepest existing ancestor rather than on the assembled
 * string, because `join(cwd, 'a/b.txt')` is inside `cwd` as a string even when `a` is a junction
 * pointing at `C:\Windows`. Anything under a symlinked directory that resolves elsewhere is refused
 * instead of being written through, and a target that is itself a symlink is refused outright — a
 * rename over a link would replace the link, which is not what "restore this file" means.
 */
async function safeWriteTarget(realCwd, relPath) {
  const assembled = join(realCwd, ...relPath.split('/'))
  if (!isInsideOrEqual(assembled, realCwd)) return { ok: false, error: '路径越出工作目录，已拒绝' }

  let existing = assembled
  const tail = []
  for (;;) {
    try {
      const info = await lstat(existing)
      if (tail.length === 0 && info.isSymbolicLink()) {
        return { ok: false, error: '目标是符号链接，拒绝覆盖' }
      }
      break
    } catch (error) {
      if (errorCode(error) !== 'ENOENT') return { ok: false, error: `无法检查路径：${message(error)}` }
    }
    const parent = dirname(existing)
    if (parent === existing) return { ok: false, error: '路径无法解析' }
    tail.unshift(basename(existing))
    existing = parent
  }

  let realExisting
  try {
    realExisting = await realpath(existing)
  } catch (error) {
    return { ok: false, error: `无法解析路径：${message(error)}` }
  }
  if (!isInsideOrEqual(realExisting, realCwd)) {
    return { ok: false, error: '路径经由符号链接离开工作目录，已拒绝' }
  }

  const target = tail.length > 0 ? join(realExisting, ...tail) : realExisting
  if (!isInsideOrEqual(target, realCwd)) return { ok: false, error: '路径越出工作目录，已拒绝' }
  return { ok: true, path: target }
}

/** Parse one snapshot's manifest, or null when the directory is not a complete snapshot. */
async function readManifest(dir) {
  try {
    const text = await readFile(join(dir, 'manifest.json'), 'utf8')
    const manifest = JSON.parse(text)
    if (!manifest || typeof manifest !== 'object' || !Array.isArray(manifest.files)) return null
    return manifest
  } catch {
    // A missing or half-written manifest means "not a snapshot": the temp directory of a create that
    // died, or a directory a user poked at. Either way it is not offered as restorable.
    return null
  }
}

function itemOf(manifest) {
  const files = Array.isArray(manifest.files) ? manifest.files : []
  return {
    id: String(manifest.id ?? ''),
    label: String(manifest.label ?? ''),
    at: String(manifest.at ?? ''),
    fileCount: files.length,
    bytes: files.reduce((sum, file) => sum + (Number(file.size) || 0), 0),
    note: String(manifest.note ?? ''),
  }
}

/** Newest first, by manifest timestamp with the (time-ordered) id as the tie-breaker. */
async function readIndex(store) {
  const items = []
  let dirents
  try {
    dirents = await readdir(store, { withFileTypes: true })
  } catch {
    return items
  }
  for (const dirent of dirents) {
    if (!dirent.isDirectory() || dirent.name.startsWith('.')) continue
    const manifest = await readManifest(join(store, dirent.name))
    if (!manifest) continue
    items.push(itemOf(manifest))
  }
  items.sort(
    (left, right) =>
      String(right.at).localeCompare(String(left.at)) || String(right.id).localeCompare(String(left.id)),
  )
  return items
}

async function statOrNull(path) {
  try {
    return await stat(path)
  } catch {
    return null
  }
}

/**
 * Walk the workspace once, handing every in-scope file to `handler`.
 *
 * Scope is defined here and only here, so create, diff and the "what did I leave alone" report of a
 * restore all agree on which files exist as far as the snapshot is concerned: `node_modules` is not a
 * change, a 40 MB video is not a change, and neither is a symlink (following one could copy a file
 * from outside the workspace — or loop forever).
 *
 * `seen` is the record of decisions rather than of copies, and it is what keeps a truncated scan from
 * reporting files past the cut as "deleted".
 *
 * `hash:false` skips reading the bytes entirely, which is the cheap mode used to answer "which paths
 * exist now" during a restore.
 */
async function scanWorkspace(root, handler, { hash = true } = {}) {
  const skipped = []
  const files = []
  const seen = new Set()
  let bytes = 0
  let truncated = false

  const storeDir = canonicalPath(storeRoot())
  const skipStore = isInsideOrEqual(storeDir, root) ? storeDir : null

  const pending = ['']
  while (pending.length > 0) {
    const relDir = pending.pop()
    const absDir = relDir ? join(root, ...relDir.split('/')) : root
    let entries
    try {
      entries = await readdir(absDir, { withFileTypes: true })
    } catch (error) {
      skipped.push({ path: relDir ? `${relDir}/` : '.', reason: `目录无法读取（${message(error)}）` })
      continue
    }
    // Sorted so two runs over an unchanged workspace visit files in the same order — which is what
    // makes the truncation point (and therefore the snapshot's scope) reproducible.
    entries.sort((left, right) => left.name.localeCompare(right.name))

    for (const entry of entries) {
      const rel = relDir ? `${relDir}/${entry.name}` : entry.name
      const abs = join(absDir, entry.name)
      seen.add(rel)

      if (entry.isSymbolicLink()) {
        skipped.push({ path: rel, reason: '符号链接，不跟随' })
        continue
      }
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name.toLowerCase())) {
          skipped.push({ path: `${rel}/`, reason: '依赖或构建目录，已跳过' })
          continue
        }
        if (skipStore && canonicalPath(abs) === skipStore) {
          // A portable install can put its data directory inside the workspace; snapshotting the
          // snapshot store would grow without bound.
          skipped.push({ path: `${rel}/`, reason: '应用数据目录，已跳过' })
          continue
        }
        pending.push(rel)
        continue
      }
      if (!entry.isFile()) {
        skipped.push({ path: rel, reason: '不是普通文件' })
        continue
      }

      const info = await statOrNull(abs)
      if (!info) {
        skipped.push({ path: rel, reason: '无法读取文件信息' })
        continue
      }
      if (info.size > MAX_FILE_BYTES) {
        skipped.push({ path: rel, reason: `超过单文件上限 ${megabytes(MAX_FILE_BYTES)}（该文件 ${megabytes(info.size)}）` })
        continue
      }
      if (bytes + info.size > MAX_SNAPSHOT_BYTES) {
        skipped.push({ path: rel, reason: `已达单次快照上限 ${megabytes(MAX_SNAPSHOT_BYTES)}，其余文件未纳入` })
        truncated = true
        return { files, skipped, bytes, truncated, seen }
      }

      if (!hash) {
        files.push({ path: rel, size: info.size, sha256: null })
        bytes += info.size
        continue
      }

      let buffer
      try {
        buffer = await readFile(abs)
      } catch (error) {
        skipped.push({ path: rel, reason: `读取失败（${message(error)}）` })
        continue
      }
      const sha256 = createHash('sha256').update(buffer).digest('hex')
      try {
        await handler({ path: rel, abs, size: buffer.length, sha256, buffer })
      } catch (error) {
        skipped.push({ path: rel, reason: `写入快照失败（${message(error)}）` })
        continue
      }
      files.push({ path: rel, size: buffer.length, sha256 })
      bytes += buffer.length
    }
  }
  return { files, skipped, bytes, truncated, seen }
}

/** Turn internal skip records into the display lines the panel shows, capped but never understated. */
function publicSkips(skipped) {
  const labels = skipped.map((entry) => `${entry.path} — ${entry.reason}`)
  if (labels.length <= MAX_SKIPPED_REPORTED) return labels
  return [
    ...labels.slice(0, MAX_SKIPPED_REPORTED),
    `另有 ${labels.length - MAX_SKIPPED_REPORTED} 项未列出`,
  ]
}

/** Delete the oldest snapshots beyond the retention limit; returns what was removed. */
async function pruneSnapshots(store, limit) {
  const items = await readIndex(store)
  const pruned = []
  for (const item of items.slice(limit)) {
    try {
      await rm(join(store, item.id), { recursive: true, force: true })
      pruned.push(item.id)
    } catch {
      // A snapshot that cannot be removed (locked file, permissions) stays listed; the create itself
      // already succeeded, so failing it now would be a lie about what happened.
    }
  }
  return pruned
}

/**
 * Take a snapshot of the workspace.
 *
 * Built into `.tmp-<id>` inside the store and renamed into place only once the manifest is written,
 * so an interrupted create leaves a hidden directory that no listing offers and no diff can pick,
 * rather than a registered snapshot that is missing half its files.
 */
export async function createCheckpoint({ cwd, label, note } = {}) {
  try {
    const root = checkCwd(cwd)
    if (!root.ok) return { ok: false, error: root.error }

    const store = storeFor(root.path)
    const id = newSnapshotId()
    const tempDir = join(store, `.tmp-${id}`)
    const finalDir = join(store, id)
    const filesDir = join(tempDir, 'files')

    try {
      await mkdir(filesDir, { recursive: true })
      const scan = await scanWorkspace(root.path, async (file) => {
        const destination = join(filesDir, ...file.path.split('/'))
        await mkdir(dirname(destination), { recursive: true })
        await writeFile(destination, file.buffer)
      })

      const at = new Date()
      const skipped = publicSkips(scan.skipped)
      const record = {
        id,
        label: String(label ?? '').trim().slice(0, 80) || `快照 ${localStamp(at)}`,
        at: at.toISOString(),
        cwd: root.path,
        note: String(note ?? '').slice(0, 500),
        fileCount: scan.files.length,
        bytes: scan.bytes,
        truncated: scan.truncated,
        skipped,
        files: scan.files,
      }
      await writeFile(join(tempDir, 'manifest.json'), JSON.stringify(record, null, 2), 'utf8')
      await rename(tempDir, finalDir)
    } catch (error) {
      await rm(tempDir, { recursive: true, force: true }).catch(() => {})
      return { ok: false, error: `创建快照失败：${message(error)}` }
    }

    const pruned = await pruneSnapshots(store, defaultMaxSnapshots())
    const manifest = await readManifest(finalDir)
    return {
      ok: true,
      item: itemOf(manifest ?? { id, label: String(label ?? ''), at: new Date().toISOString(), files: [] }),
      skipped: manifest?.skipped ?? [],
      pruned,
    }
  } catch (error) {
    return { ok: false, error: `创建快照失败：${message(error)}` }
  }
}

/** Every snapshot of one workspace, newest first. */
export async function listCheckpoints({ cwd } = {}) {
  const root = checkCwd(cwd)
  if (!root.ok) return { ok: false, error: root.error, cwd: null, store: null, items: [] }
  const store = storeFor(root.path)
  try {
    return { ok: true, cwd: root.path, store, items: await readIndex(store) }
  } catch (error) {
    return { ok: false, error: `读取快照列表失败：${message(error)}`, cwd: root.path, store, items: [] }
  }
}

/**
 * Load one snapshot's manifest, verifying it belongs to this workspace.
 *
 * The store key already separates workspaces, but a manifest records its own `cwd` — checking the two
 * against each other turns "someone copied a data directory around" into an error message instead of
 * a restore that writes another project's files into this one.
 */
async function loadSnapshot(cwd, id) {
  const root = checkCwd(cwd)
  if (!root.ok) return { ok: false, error: root.error }
  const safe = safeId(id)
  if (!safe) return { ok: false, error: '快照 ID 不合法' }
  const store = storeFor(root.path)
  const dir = join(store, safe)
  const manifest = await readManifest(dir)
  if (!manifest) return { ok: false, error: '快照不存在或已损坏' }
  if (manifest.cwd && canonicalPath(String(manifest.cwd)) !== canonicalPath(root.path)) {
    return { ok: false, error: '快照不属于当前工作目录' }
  }
  return { ok: true, cwd: root.path, store, dir, manifest }
}

/** A snapshot copy's absolute path, or null when the manifest entry tries to leave its own store. */
function snapshotFilePath(dir, relPath) {
  const filesRoot = join(dir, 'files')
  const abs = join(filesRoot, ...relPath.split('/'))
  if (!isInsideOrEqual(abs, filesRoot)) return null
  return abs
}

function looksBinary(buffer) {
  return buffer.subarray(0, NUL_SAMPLE_BYTES).includes(0)
}

function splitLines(text) {
  const lines = text.split(/\r\n|\r|\n/)
  // A trailing newline terminates the last line instead of starting an empty one.
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
  return lines
}

/** Exact LCS length over two bounded line arrays, using two rolling rows instead of a full table. */
function lcsLength(left, right) {
  const width = right.length + 1
  let previous = new Uint32Array(width)
  let current = new Uint32Array(width)
  for (let i = 1; i <= left.length; i++) {
    for (let j = 1; j <= right.length; j++) {
      current[j] =
        left[i - 1] === right[j - 1]
          ? previous[j - 1] + 1
          : Math.max(previous[j], current[j - 1])
    }
    const swap = previous
    previous = current
    current = swap
    current.fill(0)
  }
  return previous[right.length]
}

/** Fallback for the (rare) pairs too large for an exact table: how many lines have no counterpart. */
function multisetDelta(left, right) {
  const counts = new Map()
  for (const line of left) counts.set(line, (counts.get(line) ?? 0) + 1)
  let added = 0
  for (const line of right) {
    const left0 = counts.get(line) ?? 0
    if (left0 > 0) counts.set(line, left0 - 1)
    else added++
  }
  let removed = 0
  for (const left0 of counts.values()) removed += left0
  return { added, removed }
}

/**
 * `added`/`removed` describe the workspace AGAINST the snapshot, matching the status next to them: a
 * file the snapshot does not have shows `+lines`, a file it has and the workspace lost shows
 * `-lines`, and a modified file shows both.
 *
 * Trimming the common prefix and suffix first is what keeps an exact comparison affordable — the
 * usual edit leaves a handful of lines in the middle even in a 5,000-line file, so the cell budget is
 * only ever spent on genuinely different regions.
 */
function countLines(beforeLines, afterLines) {
  let start = 0
  const shortest = Math.min(beforeLines.length, afterLines.length)
  while (start < shortest && beforeLines[start] === afterLines[start]) start++

  let endBefore = beforeLines.length
  let endAfter = afterLines.length
  while (endBefore > start && endAfter > start && beforeLines[endBefore - 1] === afterLines[endAfter - 1]) {
    endBefore--
    endAfter--
  }

  const before = beforeLines.slice(start, endBefore)
  const after = afterLines.slice(start, endAfter)
  if (before.length === 0) return { added: after.length, removed: 0 }
  if (after.length === 0) return { added: 0, removed: before.length }
  if (before.length * after.length <= MAX_LCS_CELLS) {
    const common = lcsLength(before, after)
    return { added: after.length - common, removed: before.length - common }
  }
  return multisetDelta(before, after)
}

/**
 * Read one file's lines for counting, or report why it cannot be counted.
 *
 * `binary: true` here means "counts unavailable", not strictly "not text": oversized files land in
 * the same bucket so the panel can render `—` without a second flag for the same outcome.
 */
async function readLinesForCount(absolute, size) {
  if (!Number.isFinite(size) || size > MAX_COUNT_BYTES) return { binary: true, lines: null }
  let buffer
  try {
    buffer = await readFile(absolute)
  } catch {
    return { binary: true, lines: null }
  }
  if (looksBinary(buffer)) return { binary: true, lines: null }
  const lines = splitLines(buffer.toString('utf8'))
  if (lines.length > MAX_COUNT_LINES) return { binary: true, lines: null }
  return { binary: false, lines }
}

/** How the workspace differs from one snapshot, file by file. */
export async function diffCheckpoint({ cwd, id } = {}) {
  const loaded = await loadSnapshot(cwd, id)
  if (!loaded.ok) return { ok: false, error: loaded.error, entries: [] }

  try {
    const root = loaded.cwd
    const manifest = loaded.manifest
    const records = manifest.files.filter((file) => file && typeof file.path === 'string')

    // One scan of the workspace answers both "which known files changed" and "which files are new".
    const scan = await scanWorkspace(root, async () => {})
    const current = new Map(scan.files.map((file) => [file.path, file]))

    const entries = []
    for (const record of records) {
      const path = normalizeRelative(record.path)
      const now = current.get(path)
      current.delete(path)

      if (now && now.sha256 === String(record.sha256 ?? '')) {
        entries.push({ path, status: 'unchanged', added: 0, removed: 0, binary: false })
        continue
      }

      if (now) {
        entries.push({ path, status: 'modified', ...(await deltaFor(loaded.dir, record, root)) })
        continue
      }

      if (!scan.seen.has(path)) {
        // Truncated scans stop at the snapshot budget, so a file past the cut was never looked at.
        // Reporting it as deleted would be the one wrong answer the user would act on.
        if (scan.truncated) continue
        const lines = await readLinesForCount(snapshotFilePath(loaded.dir, path) ?? '', Number(record.size))
        entries.push({
          path,
          status: 'removed',
          added: 0,
          removed: lines.lines ? lines.lines.length : 0,
          binary: lines.binary,
        })
        continue
      }

      // Seen but not hashed: the file exists and is now out of scope (usually grown past the per-file
      // cap), so the snapshot cannot describe its content any more.
      entries.push({ path, status: 'modified', added: 0, removed: 0, binary: true })
    }

    for (const [path, info] of current) {
      const lines = await readLinesForCount(join(root, ...path.split('/')), info.size)
      entries.push({
        path,
        status: 'added',
        added: lines.lines ? lines.lines.length : 0,
        removed: 0,
        binary: lines.binary,
      })
    }

    // Changed first, then by path: the panel's job is to show what moved, and an unchanged file is
    // only there so the row count matches the snapshot.
    const rank = { added: 0, modified: 1, removed: 2, unchanged: 3 }
    entries.sort((left, right) => rank[left.status] - rank[right.status] || left.path.localeCompare(right.path))

    return {
      ok: true,
      entries,
      changed: entries.filter((entry) => entry.status !== 'unchanged').length,
      truncated: scan.truncated,
      warning: scan.truncated ? `工作区超过单次快照上限，仅比对了已纳入快照范围的文件` : '',
    }
  } catch (error) {
    return { ok: false, error: `比对失败：${message(error)}`, entries: [] }
  }
}

/** Line delta between a snapshot copy and the workspace file it corresponds to. */
async function deltaFor(snapshotDir, record, root) {
  const path = normalizeRelative(record.path)
  const copy = snapshotFilePath(snapshotDir, path)
  const live = join(root, ...path.split('/'))
  const liveInfo = await statOrNull(live)
  const before = copy
    ? await readLinesForCount(copy, Number(record.size))
    : { binary: true, lines: null }
  const after = liveInfo
    ? await readLinesForCount(live, liveInfo.size)
    : { binary: true, lines: null }
  if (before.binary || after.binary || !before.lines || !after.lines) {
    return { added: 0, removed: 0, binary: true }
  }
  return { ...countLines(before.lines, after.lines), binary: false }
}

/** Total bytes actually on disk below `dir`, used for the usage line. */
async function directoryBytes(dir) {
  let total = 0
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return 0
  }
  for (const entry of entries) {
    const abs = join(dir, entry.name)
    if (entry.isDirectory()) {
      total += await directoryBytes(abs)
      continue
    }
    if (!entry.isFile()) continue
    const info = await statOrNull(abs)
    if (info) total += info.size
  }
  return total
}

/**
 * Put the snapshot's copies back.
 *
 * Writes are temp-file-plus-rename inside the destination directory, so a crash mid-write leaves the
 * previous content intact rather than a half-written file. Every copy is verified against the
 * manifest digest first: a restore is the moment the store's integrity matters, and a corrupted copy
 * must be reported as a skipped file rather than written over a good one.
 *
 * Files that exist in the workspace but not in the snapshot are NOT deleted — a copy snapshot has no
 * way to know whether they are new work or something that predates the snapshot, and guessing wrong
 * destroys the user's files. They come back in `kept` so the panel can say how many were left alone.
 * `deleted` therefore only ever carries paths the snapshot itself recorded as deleted, which a copy
 * snapshot cannot record: it stays empty by construction, and it is in the result because the panel
 * and the route contract name it.
 *
 * `ok` is false when NOTHING could be restored while something was refused — a request whose every
 * path was rejected (an escape attempt, a stale id) must not read as a successful rollback.
 */
export async function restoreCheckpoint({ cwd, id, files } = {}) {
  const loaded = await loadSnapshot(cwd, id)
  if (!loaded.ok) {
    return { ok: false, error: loaded.error, restored: [], deleted: [], kept: [], keptTotal: 0, skipped: [] }
  }

  try {
    const root = loaded.cwd
    const manifest = loaded.manifest
    const records = manifest.files.filter((file) => file && typeof file.path === 'string')
    const byPath = new Map(records.map((record) => [normalizeRelative(record.path), record]))

    let requested
    if (files === undefined || files === null) {
      requested = [...byPath.keys()]
    } else if (!Array.isArray(files)) {
      return {
        ok: false,
        error: '恢复的文件列表格式不正确',
        restored: [],
        deleted: [],
        kept: [],
        keptTotal: 0,
        skipped: [],
      }
    } else if (files.length === 0) {
      return {
        ok: false,
        error: '没有选择任何文件',
        restored: [],
        deleted: [],
        kept: [],
        keptTotal: 0,
        skipped: [],
      }
    } else {
      requested = []
      const dedupe = new Set()
      for (const raw of files) {
        const path = normalizeRelative(raw)
        if (dedupe.has(path)) continue
        dedupe.add(path)
        requested.push(path)
      }
    }

    const realCwd = await realpath(root)
    const restored = []
    const skipped = []

    for (const raw of requested) {
      const issue = relativePathIssue(raw)
      if (issue) {
        skipped.push({ path: String(raw ?? ''), reason: `${issue}，已拒绝` })
        continue
      }
      const path = normalizeRelative(raw)
      const record = byPath.get(path)
      if (!record) {
        skipped.push({ path, reason: '快照中没有这个文件' })
        continue
      }

      const source = snapshotFilePath(loaded.dir, path)
      if (!source) {
        skipped.push({ path, reason: '快照路径不合法' })
        continue
      }
      let buffer
      try {
        buffer = await readFile(source)
      } catch {
        skipped.push({ path, reason: '快照副本缺失' })
        continue
      }
      const digest = createHash('sha256').update(buffer).digest('hex')
      if (record.sha256 && digest !== String(record.sha256)) {
        skipped.push({ path, reason: '快照副本校验失败，未覆盖工作区文件' })
        continue
      }

      const target = await safeWriteTarget(realCwd, path)
      if (!target.ok) {
        skipped.push({ path, reason: target.error })
        continue
      }

      const temp = `${target.path}.cccn-${randomBytes(4).toString('hex')}.tmp`
      try {
        await mkdir(dirname(target.path), { recursive: true })
        await writeFile(temp, buffer)
        // Same directory, so this rename is a same-volume replace: the file is either the old content
        // or the new one, never a truncated mix.
        await rename(temp, target.path)
        restored.push(path)
      } catch (error) {
        // A file another program holds open makes rename fail on Windows; that is reported per file
        // instead of aborting the rollback of everything else.
        await rm(temp, { force: true }).catch(() => {})
        skipped.push({ path, reason: `写入失败（${message(error)}）` })
      }
    }

    const existing = await scanWorkspace(root, async () => {}, { hash: false })
    const extras = existing.files.map((file) => file.path).filter((path) => !byPath.has(path))

    if (restored.length === 0 && skipped.length > 0) {
      return {
        ok: false,
        error: `回滚被拒绝：${skipped[0].path} — ${skipped[0].reason}`,
        restored,
        deleted: [],
        kept: extras.slice(0, MAX_KEPT_REPORTED),
        keptTotal: extras.length,
        skipped,
      }
    }

    return {
      ok: true,
      restored,
      deleted: [],
      kept: extras.slice(0, MAX_KEPT_REPORTED),
      keptTotal: extras.length,
      skipped,
    }
  } catch (error) {
    return {
      ok: false,
      error: `回滚失败：${message(error)}`,
      restored: [],
      deleted: [],
      kept: [],
      keptTotal: 0,
      skipped: [],
    }
  }
}

/** Remove one snapshot. A directory that is already gone counts as deleted, not as an error. */
export async function deleteCheckpoint({ cwd, id } = {}) {
  const root = checkCwd(cwd)
  if (!root.ok) return { ok: false, error: root.error }
  const safe = safeId(id)
  if (!safe) return { ok: false, error: '快照 ID 不合法' }
  try {
    await rm(join(storeFor(root.path), safe), { recursive: true, force: true })
    return { ok: true, deleted: true }
  } catch (error) {
    return { ok: false, error: `删除快照失败：${message(error)}` }
  }
}

/**
 * How much the store occupies across every workspace.
 *
 * Scans the whole tree rather than trusting the manifests, because the question this answers is "what
 * would deleting this give me back" — and that includes the manifest files, anything a partial
 * create left behind, and any directory a user dropped in there.
 */
export async function checkpointUsage() {
  const root = storeRoot()
  try {
    let count = 0
    let bytes = 0
    let workspaces = 0
    const dirents = await readdir(root, { withFileTypes: true })
    for (const dirent of dirents) {
      if (!dirent.isDirectory() || dirent.name.startsWith('.')) continue
      workspaces++
      const workspaceDir = join(root, dirent.name)
      const snapshots = await readdir(workspaceDir, { withFileTypes: true })
      for (const snapshot of snapshots) {
        if (!snapshot.isDirectory() || snapshot.name.startsWith('.')) continue
        const dir = join(workspaceDir, snapshot.name)
        // A directory with no readable manifest is a leftover, not a snapshot: counting it would
        // make the UI promise space that deleting snapshots cannot free.
        if (!(await readManifest(dir))) continue
        count++
        bytes += await directoryBytes(dir)
      }
    }
    return { ok: true, root, count, bytes, workspaces }
  } catch (error) {
    return { ok: false, error: `读取快照占用失败：${message(error)}`, root, count: 0, bytes: 0, workspaces: 0 }
  }
}
