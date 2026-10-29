/**
 * 按轮差异：记录一次工具写入之前的文件内容，之后用它算这一轮改了什么。
 *
 * WHY A BEFORE-IMAGE RATHER THAN A GIT DIFF: the conversation's own tool calls are the unit a user
 * reviews ("这一轮它改了什么"), and they touch files that are neither committed nor necessarily in a
 * repository. Git cannot answer that question for an uncommitted edit inside a non-repo folder.
 *
 * WHY THE SNAPSHOT IS TAKEN AT `tool_use` TIME: by the time the `tool_result` arrives the file is already
 * written; reading it then would compare the new content against itself. The bridge sees the tool call
 * before the CLI executes it, which is the only moment the old bytes still exist.
 *
 * SIZE: a write to a 200 MB file must not be copied into the data directory on every turn. Files above
 * `MAX_SNAPSHOT_BYTES` are recorded as "too big to snapshot" and reported as such, never silently
 * omitted from the diff.
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { basename, join } from 'node:path'

import { dataSubDir } from './paths.mjs'

const MAX_SNAPSHOT_BYTES = 4 * 1024 * 1024
const MAX_DIFF_LINES = 4000

function turnDir(sessionId, turn) {
  const safeSession = String(sessionId).replace(/[^A-Za-z0-9-]/g, '')
  return dataSubDir(join('turns', safeSession, String(Number(turn) || 0)))
}

function indexPath(sessionId, turn) {
  return join(turnDir(sessionId, turn), 'index.json')
}

function readIndex(sessionId, turn) {
  try {
    const parsed = JSON.parse(readFileSync(indexPath(sessionId, turn), 'utf8'))
    return Array.isArray(parsed.files) ? parsed : { files: [] }
  } catch {
    return { files: [] }
  }
}

function writeIndex(sessionId, turn, index) {
  writeFileSync(indexPath(sessionId, turn), `${JSON.stringify(index, null, 2)}\n`, 'utf8')
}

/**
 * Capture one file before a tool edits it. Idempotent per turn: the FIRST pre-image wins, because a
 * second edit in the same turn must be diffed against the state the turn started from.
 */
export function recordBefore({ sessionId, turn, cwd, path } = {}) {
  if (!sessionId || !cwd || !path) return { ok: false, error: '缺少会话、工作区或路径' }
  const absolute = join(cwd, path)
  const index = readIndex(sessionId, turn)
  if (index.files.some((entry) => entry.path === path)) return { ok: true, skipped: true }

  let exists = true
  let content = ''
  try {
    const stats = statSync(absolute)
    if (!stats.isFile()) return { ok: false, error: '不是文件' }
    if (stats.size > MAX_SNAPSHOT_BYTES) {
      index.files.push({ path, absolute, before: null, tooBig: true, at: Date.now() })
      writeIndex(sessionId, turn, index)
      return { ok: true, tooBig: true }
    }
    content = readFileSync(absolute, 'utf8')
  } catch {
    // A file the tool is about to CREATE has no before-image; that is "新增", not an error.
    exists = false
  }

  const digest = createHash('sha1').update(`${path}:${Date.now()}:${Math.random()}`).digest('hex').slice(0, 12)
  const file = join(turnDir(sessionId, turn), `${digest}.before`)
  if (exists) writeFileSync(file, content, 'utf8')
  index.files.push({ path, absolute, before: exists ? file : null, created: !exists, at: Date.now() })
  writeIndex(sessionId, turn, index)
  return { ok: true, created: !exists }
}

/**
 * Line diff (LCS), returned as one unified hunk.
 *
 * WHY NOT A FULL MYERS IMPLEMENTATION: the review view needs "which lines changed", not a patch that
 * applies — one hunk is readable, and the O(n·m) table is capped so a pathological file cannot freeze the
 * bridge. The cap is reported rather than silently truncating the middle of a change.
 */
function lineDiff(beforeText, afterText) {
  const before = beforeText.split(/\r?\n/)
  const after = afterText.split(/\r?\n/)
  const capped = before.length > MAX_DIFF_LINES || after.length > MAX_DIFF_LINES
  const a = before.slice(0, MAX_DIFF_LINES)
  const b = after.slice(0, MAX_DIFF_LINES)

  const table = Array.from({ length: a.length + 1 }, () => new Uint16Array(b.length + 1))
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      table[i][j] = a[i] === b[j] ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1])
    }
  }

  const lines = []
  let added = 0
  let removed = 0
  let i = 0
  let j = 0
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      lines.push(` ${a[i]}`)
      i++
      j++
    } else if (table[i + 1][j] >= table[i][j + 1]) {
      lines.push(`-${a[i]}`)
      removed++
      i++
    } else {
      lines.push(`+${b[j]}`)
      added++
      j++
    }
  }
  while (i < a.length) {
    lines.push(`-${a[i++]}`)
    removed++
  }
  while (j < b.length) {
    lines.push(`+${b[j++]}`)
    added++
  }

  return { diff: lines.join('\n'), added, removed, capped }
}

/** All turns recorded for one session, newest first. */
export function listTurns({ sessionId } = {}) {
  const safeSession = String(sessionId ?? '').replace(/[^A-Za-z0-9-]/g, '')
  if (safeSession === '') return { ok: true, turns: [] }
  try {
    const root = dataSubDir(join('turns', safeSession))
    const turns = readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && /^\d+$/.test(entry.name))
      .map((entry) => {
        const number = Number(entry.name)
        const index = readIndex(safeSession, number)
        return { turn: number, files: index.files.length }
      })
      .filter((entry) => entry.files > 0)
      .sort((left, right) => right.turn - left.turn)
    return { ok: true, turns }
  } catch {
    return { ok: true, turns: [] }
  }
}

/**
 * Per-file diffs for one turn, computed against what is on disk NOW.
 *
 * A file the turn created has no pre-image: its diff is every current line as `+`. A file that no longer
 * exists is reported as deleted rather than dropped.
 */
export function turnDiff({ sessionId, turn } = {}) {
  const index = readIndex(sessionId, turn)
  if (index.files.length === 0) return { ok: true, turn: Number(turn) || 0, files: [] }

  const files = index.files.map((entry) => {
    if (entry.tooBig) {
      return { path: entry.path, status: 'skipped', reason: `文件超过 ${Math.round(MAX_SNAPSHOT_BYTES / 1024 / 1024)} MB，未快照` }
    }
    const before = entry.before && existsSync(entry.before) ? readFileSync(entry.before, 'utf8') : ''
    const absolute = entry.absolute ?? null
    let after = null
    let deleted = false
    try {
      after = readFileSync(absolute ?? '', 'utf8')
    } catch {
      deleted = Boolean(absolute)
    }
    if (after === null && !deleted) {
      // No absolute path recorded (older entries): cannot diff, say so instead of guessing.
      return { path: entry.path, status: 'unknown', reason: '缺少绝对路径，无法比较' }
    }
    if (entry.created) {
      const lines = String(after ?? '').split(/\r?\n/)
      return { path: entry.path, status: 'added', added: lines.length, removed: 0, diff: lines.map((line) => `+${line}`).join('\n') }
    }
    if (deleted) {
      const lines = before.split(/\r?\n/)
      return { path: entry.path, status: 'deleted', added: 0, removed: lines.length, diff: lines.map((line) => `-${line}`).join('\n') }
    }
    const result = lineDiff(before, after ?? '')
    return { path: entry.path, status: result.added > 0 || result.removed > 0 ? 'modified' : 'unchanged', ...result }
  })

  return { ok: true, turn: Number(turn) || 0, files }
}


/**
 * 撤回时用：列出这段会话里「某条消息之后」被工具改过的文件。
 *
 * WHY BY TIMESTAMP AND NOT BY TURN NUMBER: 会话记录（CLI 写的）和快照目录（桥写的）在重启后各自独立编号，
 * 而事件里的时间戳是两边都有的、且不会重排的东西。用 since 圈定「这条消息之后」既覆盖同一轮的多处写入，
 * 也覆盖被拆成多轮追加的情况。
 *
 * later = 之后有多轮改过同一个文件：还原到最早的快照会连带丢掉那些改动，所以必须让用户看见并自己选。
 */
export function previewTurnFiles({ sessionId, since = 0 } = {}) {
  const safeSession = String(sessionId ?? '').replace(/[^A-Za-z0-9-]/g, '')
  const root = dataSubDir(join('turns', safeSession))
  if (!existsSync(root)) return { ok: true, files: [] }

  const turns = readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && /^\d+$/.test(entry.name))
    .map((entry) => Number(entry.name))
    .sort((a, b) => a - b)

  /** absolute → 最早的一条记录（同一次消息之后的第一份前像才是「原本的样子」）。 */
  const byFile = new Map()
  for (const turn of turns) {
    const index = readIndex(sessionId, turn)
    for (const entry of index.files) {
      if (!entry?.absolute) continue
      if (since > 0 && Number(entry.at ?? 0) < since) continue
      const previous = byFile.get(entry.absolute)
      if (!previous) {
        byFile.set(entry.absolute, {
          path: entry.path,
          absolute: entry.absolute,
          created: entry.created === true,
          tooBig: entry.tooBig === true,
          before: entry.before ?? null,
          touches: 1,
        })
      } else {
        previous.touches += 1
      }
    }
  }

  const files = [...byFile.values()].map((file) => ({
    ...file,
    later: file.touches > 1,
  }))
  return { ok: true, files }
}

/**
 * 把选中的文件写回撤回之前的样子。
 *
 * 顺序是「先备份、再覆盖」：任何一步失败都必须留下当前内容，否则一次还原失败会同时丢掉新旧两份。
 * created 的文件在撤回后应当不存在 —— 还原即删除，删除前同样先备份成 .rollback-bak。
 */
export function restoreTurnFiles({ sessionId, since = 0, paths = [] } = {}) {
  const wanted = new Set((Array.isArray(paths) ? paths : []).map(String))
  if (wanted.size === 0) return { ok: true, restored: [], skipped: [] }

  const preview = previewTurnFiles({ sessionId, since })
  if (!preview.ok) return preview

  const restored = []
  const skipped = []
  for (const file of preview.files) {
    if (!wanted.has(file.absolute)) continue
    if (file.tooBig || (!file.created && !file.before)) {
      skipped.push({ path: file.path, reason: '没有可用快照（文件过大或未记录）' })
      continue
    }
    const backup = `${file.absolute}.rollback-bak`
    try {
      if (file.created) {
        if (existsSync(file.absolute)) {
          copyFileSync(file.absolute, backup)
          unlinkSync(file.absolute)
        }
        restored.push({ path: file.path, action: 'deleted', backup })
        continue
      }
      if (existsSync(file.absolute)) copyFileSync(file.absolute, backup)
      mkdirSync(join(file.absolute, '..'), { recursive: true })
      copyFileSync(file.before, file.absolute)
      restored.push({ path: file.path, action: 'restored', backup: existsSync(backup) ? backup : null })
    } catch (error) {
      skipped.push({ path: file.path, reason: error instanceof Error ? error.message : String(error) })
    }
  }
  return { ok: true, restored, skipped }
}
