/**
 * 项目记忆 — the durable notes one workspace keeps for itself.
 *
 * WHY THE STORE IS PER WORKSPACE AND OUTSIDE THE PROJECT: a note records a decision the user already
 * paid for ("网关只认 HTTPS，内网代理会改包体"), so it is only meaningful next to that project — but a
 * file inside the repo would show up in every `git status`, ship to whoever clones, and be wiped by a
 * `git clean`, which is the wrong blast radius for scratch notes. The app's data root keeps them
 * private and out of the working tree. `exportMemory` bridges the two on demand: it writes a
 * delimited block into a Markdown file the agent already reads, which is also how a note reaches a
 * session this app did not start.
 *
 * WHY THE FILE NAME CARRIES A HASH: the readable half comes from the folder name, which is what a
 * human needs when staring at the data directory, but two projects called `app` exist on any machine
 * that has ever cloned a monorepo. A slug alone would silently merge their notes into one file; the
 * full absolute path is hashed into the name as well, so the name is readable AND collision-free.
 *
 * Nothing here throws: every export returns `{ ok: false, error }` with a Chinese sentence, because
 * the caller is an HTTP route that has to render the reason rather than a stack trace.
 */
import { existsSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createHash, randomUUID } from 'node:crypto'
import { basename, isAbsolute, join, normalize } from 'node:path'
import { dataSubDir } from './paths.mjs'

/** The kinds a note can be, in the order the export groups them. */
const KINDS = ['fact', 'decision', 'pitfall', 'todo']

/** Section headings for the exported Markdown; kept beside the kinds so the two cannot drift. */
const KIND_TITLE = {
  fact: '事实',
  decision: '决定',
  pitfall: '踩过的坑',
  todo: '待办',
}

/**
 * Longest note accepted.
 *
 * Notes are meant to be injected into a prompt, so an unbounded entry is a context-window hazard
 * rather than a storage one: 4 000 characters is several screens of prose, far past any note that is
 * still readable to the next session.
 */
const MAX_TEXT = 4000

/** A tag is a chip in the UI, not a sentence: capped so one paste cannot turn a row into a paragraph. */
const MAX_TAGS = 20
const MAX_TAG_LENGTH = 40

/** Markers that delimit the block this module owns inside an exported Markdown file. */
const BLOCK_BEGIN = '<!-- ChinaClaude:memory:begin -->'
const BLOCK_END = '<!-- ChinaClaude:memory:end -->'

/** The file `exportMemory` writes, relative to the workspace root. */
const EXPORT_NAME = 'CLAUDE.memory.md'

/**
 * Validate a workspace path that came from the page.
 *
 * This is the trust boundary: the value arrives in a query parameter, and every operation below
 * joins it to a file name. Absolute is required because a relative path would resolve against the
 * bridge's own working directory (the install folder), and existing + directory because a typo must
 * fail loudly here rather than produce a store nobody will ever read again.
 */
function resolveWorkspace(cwd) {
  const text = typeof cwd === 'string' ? cwd.trim() : ''
  if (!text) return { ok: false, error: '缺少工作目录' }
  if (!isAbsolute(text)) return { ok: false, error: `工作目录必须是绝对路径：${text}` }
  const target = normalize(text)
  try {
    if (!existsSync(target)) return { ok: false, error: `工作目录不存在：${target}` }
    if (!statSync(target).isDirectory()) return { ok: false, error: `不是目录：${target}` }
  } catch (error) {
    return { ok: false, error: `无法读取工作目录：${String(error?.message ?? error)}` }
  }
  return { ok: true, cwd: target }
}

/**
 * Store file name for one workspace.
 *
 * Windows paths are case-insensitive, so `d:\proj` and `D:\Proj` are one workspace and must not grow
 * two note files; elsewhere case is meaning and is preserved.
 */
function workspaceKey(cwd) {
  const digest = createHash('sha256')
    .update(process.platform === 'win32' ? cwd.toLowerCase() : cwd)
    .digest('hex')
    .slice(0, 10)
  const readable = basename(cwd)
    .replace(/[^a-zA-Z0-9\u4e00-\u9fff._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
  return `${readable || 'workspace'}-${digest}`
}

/** Absolute path of the store file for `cwd`; the directory is created on the way. */
function workspaceFile(cwd) {
  return join(dataSubDir('memory'), `${workspaceKey(cwd)}.json`)
}

/** A tag list as the UI expects it: trimmed, non-empty, unique, capped. */
function normalizeTags(value) {
  if (!Array.isArray(value)) return []
  const seen = new Set()
  const tags = []
  for (const raw of value) {
    if (typeof raw !== 'string') continue
    const tag = raw.trim().slice(0, MAX_TAG_LENGTH)
    if (!tag) continue
    // Case-insensitive dedupe: 「Bug」and「bug」are one tag to a reader, and two chips in a row read as
    // a mistake. The first spelling wins, so the user's capitalisation survives.
    const key = tag.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    tags.push(tag)
    if (tags.length >= MAX_TAGS) break
  }
  return tags
}

/** A kind the UI has a badge for; anything else is reported as the default rather than dropped. */
function normalizeKind(value) {
  return KINDS.includes(value) ? value : 'fact'
}

/**
 * One stored entry, repaired into the shape the panel renders.
 *
 * An entry with no usable `id` is a problem either way: dropping it loses a note silently, keeping it
 * puts a row in the panel that 删除 can never remove. So the id is derived from the entry's position
 * and content instead — stable across reads, which a fresh `randomUUID()` per read would not be (the
 * id the panel holds would stop existing a moment later).
 */
function normalizeEntry(raw, index) {
  if (!raw || typeof raw !== 'object') return null
  const text = typeof raw.text === 'string' ? raw.text : ''
  if (!text.trim()) return null
  const at = Number.isFinite(raw.at) ? raw.at : 0
  const id =
    typeof raw.id === 'string' && raw.id.trim()
      ? raw.id
      : `salvaged-${createHash('sha1').update(`${index}\u0000${at}\u0000${text}`).digest('hex').slice(0, 12)}`
  return { id, at, kind: normalizeKind(raw.kind), text, tags: normalizeTags(raw.tags) }
}

/**
 * Read one workspace's store.
 *
 * A missing file is a workspace with no notes yet; an unreadable or unparseable one degrades to the
 * same empty list. Corrupt data must never be fatal here — the panel is the only way to see these
 * notes, so refusing to open it would hide the very file the user needs to repair by hand.
 */
function readStore(file) {
  let raw
  try {
    if (!existsSync(file)) return []
    raw = readFileSync(file, 'utf8')
  } catch {
    return []
  }
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch {
    return []
  }
  const list = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.entries) ? parsed.entries : []
  return list.map(normalizeEntry).filter(Boolean)
}

/**
 * Write a file atomically: temp file first, then rename.
 *
 * The failure this prevents is silent and permanent: a crash or a full disk halfway through a plain
 * `writeFileSync` leaves a truncated file, `readStore` then reports zero notes, and the user's memory
 * appears to have never existed. Rename is atomic on both NTFS and POSIX, so a reader sees either the
 * old file or the new one, never a half-written one.
 */
function writeFileAtomic(file, text) {
  const temp = `${file}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`
  try {
    writeFileSync(temp, text, 'utf8')
    renameSync(temp, file)
  } catch (error) {
    // A failed rename can leave the temp file behind; it is never read, so remove it rather than let
    // the data directory accumulate one orphan per failed save.
    try {
      rmSync(temp, { force: true })
    } catch {
      /* best effort */
    }
    return { ok: false, error: `写入失败：${String(error?.message ?? error)}` }
  }
  return { ok: true }
}

/** Persist one workspace's entries. `cwd` is recorded so a human opening the file knows whose it is. */
function writeStore(file, cwd, entries) {
  return writeFileAtomic(file, `${JSON.stringify({ cwd, entries }, null, 2)}\n`)
}

/**
 * Local wall-clock stamp.
 *
 * Hand-rolled rather than `toLocaleString`: that depends on ICU data the shipped `node.exe` may not
 * carry, and a date that renders as "Invalid Date" in the one file a human reads is worse than a
 * plainly formatted one.
 */
function stamp(at) {
  const date = new Date(at)
  // `at <= 0` covers a repaired entry whose timestamp was missing: 1970 is a date, but it is not this
  // note's date, and a plausible-looking wrong date is worse than an honest blank.
  if (!Number.isFinite(at) || at <= 0 || Number.isNaN(date.getTime())) return '（时间未知）'
  const pad = (n) => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

/**
 * Neutralise a marker that appears inside note text.
 *
 * A note is free text hand-written by a user who may well be pasting this module's own source, and a
 * marker quoted in a note would end the exported block early: the trailing lines would fall outside
 * the replaced range, and every later export would leave another stale copy behind. A zero-width
 * space keeps the sentence readable while making the sequence no longer a marker.
 */
function escapeMarkers(text) {
  return String(text).replaceAll('<!--', '<!--\u200b')
}

/**
 * The Markdown block this module owns.
 *
 * Grouped by kind under Chinese headings because this file is read by a person (and by the agent) far
 * more often than by the panel, and 「决定」separated from「踩过的坑」is the difference between a usable
 * handover and a pile of lines.
 */
function renderBlock(cwd, entries) {
  const lines = []
  lines.push(BLOCK_BEGIN)
  lines.push('# 项目记忆')
  lines.push('')
  lines.push('> 这一段由 ChinaClaude 维护：每次导出都会整体替换，标记之外的内容不会被改动。')
  lines.push(`> 工作目录：\`${escapeMarkers(cwd)}\``)
  lines.push(`> 最后导出：${stamp(Date.now())} · 共 ${entries.length} 条`)
  lines.push('')

  if (entries.length === 0) {
    lines.push('（还没有记录）')
  } else {
    for (const kind of KINDS) {
      const group = entries.filter((entry) => entry.kind === kind)
      if (group.length === 0) continue
      lines.push(`## ${KIND_TITLE[kind]}（${group.length}）`)
      lines.push('')
      for (const entry of group) {
        const tags = entry.tags.map((tag) => `\`${escapeMarkers(tag)}\``).join(' ')
        lines.push(`- **${stamp(entry.at)}**${tags ? ` ${tags}` : ''}`)
        // Two-space indent keeps every line inside the list item, so a multi-line note stays one note.
        for (const line of escapeMarkers(entry.text).split('\n')) lines.push(`  ${line}`)
      }
      lines.push('')
    }
  }

  lines.push(BLOCK_END)
  return lines.join('\n')
}

/**
 * Replace the block this module owns, or append one when the file has none.
 *
 * The LAST `begin` marker owns the block; pairing from the FIRST one is what this originally did, and
 * that was measured destructive. A hand edit that deletes an end marker (or an interrupted editor save)
 * leaves `begin` near the top with no `end` after it, and the first `begin` then pairs with the end
 * marker of the block appended BELOW it — so the next export replaced the entire span from the dangling
 * marker down, taking the user's text between them with it. Anchoring on the last `begin` cannot do
 * that: a dangling marker with no `end` after it is not a block at all, so a fresh block is appended
 * and the orphaned text is left exactly as written.
 */
function mergeBlock(existing, block) {
  if (!existing.trim()) return `${block}\n`

  const begin = existing.lastIndexOf(BLOCK_BEGIN)
  const end = begin < 0 ? -1 : existing.indexOf(BLOCK_END, begin + BLOCK_BEGIN.length)

  if (begin < 0 || end < 0) {
    // Everything the file already says is preserved byte for byte; only a separator is added.
    const separator = existing.endsWith('\n\n') ? '' : existing.endsWith('\n') ? '\n' : '\n\n'
    return `${existing}${separator}${block}\n`
  }
  return existing.slice(0, begin) + block + existing.slice(end + BLOCK_END.length)
}

/**
 * Every note recorded for one workspace, newest first.
 *
 * Newest first because the note that matters is almost always the one just written; the panel is read
 * top-down.
 *
 * @returns {{ok:true, cwd:string, file:string, entries:Array<object>}|{ok:false, error:string}}
 */
export function listMemory({ cwd } = {}) {
  const workspace = resolveWorkspace(cwd)
  if (!workspace.ok) return workspace
  const file = workspaceFile(workspace.cwd)
  const entries = readStore(file).sort((a, b) => b.at - a.at)
  return { ok: true, cwd: workspace.cwd, file, entries }
}

/**
 * Record one note.
 *
 * @returns {{ok:true, entry:object}|{ok:false, error:string}}
 */
export function addMemory({ cwd, text, kind, tags } = {}) {
  const workspace = resolveWorkspace(cwd)
  if (!workspace.ok) return workspace

  const body = typeof text === 'string' ? text.trim() : ''
  if (!body) return { ok: false, error: '内容不能为空' }
  if (body.length > MAX_TEXT) return { ok: false, error: `内容过长（上限 ${MAX_TEXT} 字）` }

  const requested = typeof kind === 'string' ? kind.trim() : ''
  if (requested && !KINDS.includes(requested)) {
    return { ok: false, error: `未知的分类：${requested}（可用：${KINDS.join(' / ')}）` }
  }

  const file = workspaceFile(workspace.cwd)
  const entries = readStore(file)
  const entry = {
    id: randomUUID(),
    at: Date.now(),
    kind: requested || 'fact',
    text: body,
    tags: normalizeTags(tags),
  }
  // Prepended, so the file itself is in the order the panel shows (newest first) and a human reading
  // it top-down sees the same thing the UI does.
  entries.unshift(entry)

  const written = writeStore(file, workspace.cwd, entries)
  if (!written.ok) return written
  return { ok: true, entry }
}

/**
 * Drop one note.
 *
 * `removed` is a count, matching `clearAttachments`, and an id that is already gone is `ok` with 0
 * rather than an error: two windows (or a double click) racing on the same row must both end up with
 * the note deleted instead of one of them reporting a failure for reaching the desired state.
 *
 * @returns {{ok:true, removed:number}|{ok:false, error:string}}
 */
export function removeMemory({ cwd, id } = {}) {
  const workspace = resolveWorkspace(cwd)
  if (!workspace.ok) return workspace

  const target = typeof id === 'string' ? id.trim() : ''
  if (!target) return { ok: false, error: '缺少要删除的记录 id' }

  const file = workspaceFile(workspace.cwd)
  const entries = readStore(file)
  const kept = entries.filter((entry) => entry.id !== target)
  const removed = entries.length - kept.length
  // Nothing matched, so nothing is rewritten: if the store failed to parse, a no-op delete must not
  // be the operation that turns "unreadable" into "definitively empty" and destroy what was there.
  if (removed === 0) return { ok: true, removed: 0 }

  const written = writeStore(file, workspace.cwd, kept)
  if (!written.ok) return written
  return { ok: true, removed }
}

/**
 * Refresh this workspace's Markdown export and return the file as it now reads.
 *
 * WHY A MARKER-DELIMITED BLOCK RATHER THAN A WHOLE FILE: `CLAUDE.memory.md` is an ordinary file the
 * user may already have written in, or that another tool appends to, so rewriting it wholesale would
 * destroy text this module never wrote. Only the span between the two markers is replaced; everything
 * else is copied through unchanged. The returned text is the whole FILE rather than just the block,
 * which is what makes that promise checkable from the caller.
 *
 * @returns {{ok:true, markdown:string, path:string}|{ok:false, error:string}}
 */
export function exportMemory({ cwd } = {}) {
  const workspace = resolveWorkspace(cwd)
  if (!workspace.ok) return workspace

  const file = join(workspace.cwd, EXPORT_NAME)
  const entries = readStore(workspaceFile(workspace.cwd)).sort((a, b) => b.at - a.at)
  const block = renderBlock(workspace.cwd, entries)

  let existing = ''
  try {
    if (existsSync(file)) existing = readFileSync(file, 'utf8')
  } catch (error) {
    // Refusing beats overwriting: a file we cannot read is one whose contents we cannot preserve.
    return { ok: false, error: `无法读取 ${EXPORT_NAME}：${String(error?.message ?? error)}` }
  }

  const merged = mergeBlock(existing, block)
  const written = writeFileAtomic(file, merged)
  if (!written.ok) return written
  return { ok: true, markdown: merged, path: file }
}
