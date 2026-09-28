/**
 * Existing Claude Code conversation history, read from disk.
 *
 * WHY THIS IS NOT A PORT OF dsh-chat-import
 *
 * chat-import converts OTHER tools' transcripts into DSH session records, and its portable CLI
 * surface is only `export-md`/`doctor` — the real import path needs the DSH host's session
 * persistence, which this app does not have. Vendoring its 95 lib files would ship a dependency
 * whose portable half (DSH session -> Markdown) cannot address anything this app stores.
 *
 * What this app actually needs is the inverse and it already has the hard part: Claude Code writes
 * every conversation to `<config>/projects/<encoded-cwd>/<sessionId>.jsonl`, and the bridge already
 * launches the CLI with `--resume <sessionId>`. So "importing" a past conversation means LISTING
 * what is already on disk and reopening it — the transcript stays in its native format, and tool
 * calls and reasoning survive because nothing is converted at all.
 *
 * FORMAT FACTS, MEASURED over the 158 transcripts on this machine rather than assumed:
 *   - every top-level record carries `sessionId`;
 *   - `user` / `assistant` records carry `cwd`, `version`, `timestamp`, `message` and `isSidechain`;
 *   - a directory name is the cwd with every non-alphanumeric character replaced by `-`
 *     (`D:\Claudecode-CN` -> `D--Claudecode-CN`), which agreed with the `cwd` field in 40/40 samples;
 *   - the same file also holds non-conversation records (`attachment`, `queue-operation`,
 *     `atis-latch`, `last-prompt`, `system`, `cost-state`) that must NOT be counted as turns.
 */

import { readdirSync, statSync, createReadStream, existsSync } from 'node:fs'
import { createInterface } from 'node:readline'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** Record types that represent something the user or the model actually said. */
const CONVERSATION_TYPES = new Set(['user', 'assistant'])

/** Ceiling on files inspected, newest first, so a huge history degrades instead of hanging. */
const MAX_FILES = 1500

/** A single transcript larger than this is listed by metadata only, without a full read. */
const MAX_SCAN_BYTES = 24 * 1024 * 1024

/**
 * Root of Claude Code's project transcripts.
 *
 * `CLAUDE_CONFIG_DIR` is honoured first because a user who relocated their config would otherwise
 * see an empty panel and conclude the feature is broken.
 */
export function transcriptsRoot() {
  const configDir = process.env.CLAUDE_CONFIG_DIR
  if (typeof configDir === 'string' && configDir.trim()) return join(configDir, 'projects')
  return join(homedir(), '.claude', 'projects')
}

/** Claude Code's own encoding of a working directory into a project folder name. */
export function encodeProjectDir(cwd) {
  return String(cwd ?? '').replace(/[^a-zA-Z0-9]/g, '-')
}

/**
 * The text a user record contributes, or '' when the record is not something the user said.
 *
 * Tool results arrive as `user` records, so this is the single predicate that decides both what may
 * become a title and what counts as a user turn. Keeping them on one rule is deliberate: treating a
 * tool result as a title but not as a turn (or the reverse) would make the panel contradict itself.
 */
function userPromptText(record) {
  const content = record?.message?.content
  if (typeof content === 'string') return content.trim()
  if (!Array.isArray(content)) return ''
  const parts = []
  for (const block of content) {
    if (block?.type === 'text' && typeof block.text === 'string' && block.text.trim()) parts.push(block.text.trim())
  }
  return parts.join(' ').trim()
}

/** Flatten a user/assistant `message.content` into plain text. */
function messageText(record) {
  const content = record?.message?.content
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  const parts = []
  for (const block of content) {
    if (block?.type === 'text' && typeof block.text === 'string') parts.push(block.text)
    // Tool calls are summarised rather than dumped: a listing wants a title, not a payload.
    else if (block?.type === 'tool_use') parts.push(`[${block.name ?? 'tool'}]`)
    else if (block?.type === 'tool_result') parts.push('[tool result]')
    else if (block?.type === 'thinking') parts.push('[thinking]')
  }
  return parts.join(' ')
}

/** Files under the projects root, newest first, capped. */
function findTranscriptFiles(root) {
  if (!existsSync(root)) return { files: [], truncatedByCount: false }
  const found = []
  let projectDirs
  try {
    projectDirs = readdirSync(root, { withFileTypes: true })
  } catch {
    return { files: [], truncatedByCount: false }
  }
  for (const projectDir of projectDirs) {
    if (!projectDir.isDirectory()) continue
    const projectPath = join(root, projectDir.name)
    let entries
    try {
      entries = readdirSync(projectPath, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue
      const full = join(projectPath, entry.name)
      let stats
      try {
        stats = statSync(full)
      } catch {
        continue
      }
      found.push({
        path: full,
        project: projectDir.name,
        // The filename is the session id; the records repeat it, which is cross-checked below.
        sessionIdFromName: entry.name.replace(/\.jsonl$/, ''),
        bytes: stats.size,
        mtime: stats.mtimeMs,
      })
    }
  }
  found.sort((a, b) => b.mtime - a.mtime)
  const truncatedByCount = found.length > MAX_FILES
  return { files: found.slice(0, MAX_FILES), truncatedByCount }
}

/**
 * Read one transcript's metadata.
 *
 * Streams rather than `readFile` because a transcript can be hundreds of megabytes and only a few
 * fields are wanted. Sidechain records (subagent traffic) are excluded from the turn count: they
 * are real messages, but counting them would describe a conversation as several times longer than
 * the user experienced.
 */
export async function describeTranscript(file) {
  const meta = {
    path: file.path,
    project: file.project,
    sessionId: file.sessionIdFromName,
    bytes: file.bytes,
    mtime: file.mtime,
    cwd: null,
    version: null,
    title: null,
    preview: null,
    turns: 0,
    userTurns: 0,
    assistantTurns: 0,
    /** User-shaped records that were only tool results, so the two counts explain each other. */
    toolResultRecords: 0,
    sidechainRecords: 0,
    startedAt: null,
    endedAt: null,
    gitBranch: null,
  }

  if (file.bytes > MAX_SCAN_BYTES) {
    meta.oversized = true
    return meta
  }

  const stream = createReadStream(file.path, { encoding: 'utf8' })
  const lines = createInterface({ input: stream, crlfDelay: Infinity })
  try {
    for await (const line of lines) {
      if (!line.trim()) continue
      let record
      try {
        record = JSON.parse(line)
      } catch {
        // A torn final line is normal for a session that is being written right now.
        continue
      }
      const type = record?.type
      if (!CONVERSATION_TYPES.has(type)) continue

      if (record.isSidechain === true) {
        meta.sidechainRecords++
        continue
      }

      if (meta.cwd === null && typeof record.cwd === 'string') meta.cwd = record.cwd
      if (meta.version === null && typeof record.version === 'string') meta.version = record.version
      if (meta.gitBranch === null && typeof record.gitBranch === 'string') meta.gitBranch = record.gitBranch
      if (typeof record.timestamp === 'string') {
        if (meta.startedAt === null) meta.startedAt = record.timestamp
        meta.endedAt = record.timestamp
      }

      meta.turns++
      if (type === 'user') {
        // A user record that carries no text is a tool result coming back, not something the user
        // said. Counting it would report "用户 2" for a conversation the user opened with one
        // prompt, so it is tracked separately instead.
        const text = userPromptText(record)
        if (!text) {
          meta.turns--
          meta.toolResultRecords++
          continue
        }
        meta.userTurns++
        if (meta.title === null) meta.title = text.slice(0, 160)
      } else {
        meta.assistantTurns++
        if (meta.preview === null) {
          const text = messageText(record).trim()
          if (text) meta.preview = text.slice(0, 200)
        }
      }

      // A record with no timestamp and no message is not useful beyond the counts above.
    }
  } finally {
    stream.destroy()
  }

  // The session id appears in every record, so a mismatch with the filename would mean the file was
  // renamed or copied. Surfaced rather than silently trusted, because resuming uses the id.
  if (meta.title === null) meta.title = '(无可显示的起始提问)'
  return meta
}

/** List transcripts, newest first, optionally filtered by a case-insensitive query. */
export async function listTranscripts(options = {}) {
  const root = options.root ?? transcriptsRoot()
  const { files, truncatedByCount } = findTranscriptFiles(root)
  const described = []
  for (const file of files) {
    described.push(await describeTranscript(file))
  }

  const query = typeof options.query === 'string' ? options.query.trim().toLowerCase() : ''
  const filtered = query
    ? described.filter((item) =>
        [item.title, item.preview, item.cwd, item.sessionId, item.project]
          .filter(Boolean)
          .some((value) => String(value).toLowerCase().includes(query)),
      )
    : described

  return {
    root,
    total: described.length,
    matched: filtered.length,
    truncatedByCount,
    transcripts: filtered,
  }
}

/** Group a listing by working directory, the way the sidebar groups live sessions. */
export function groupTranscripts(transcripts) {
  const groups = new Map()
  for (const item of transcripts) {
    const key = item.cwd ?? '(未知目录)'
    const list = groups.get(key)
    if (list) list.push(item)
    else groups.set(key, [item])
  }
  return [...groups.entries()].map(([cwd, items]) => ({ cwd, items }))
}

/**
 * Render one transcript as Markdown.
 *
 * This is the half of chat-import's portable CLI that applies here (`export-md`), reimplemented
 * against Claude Code's format instead of DSH's. Read-only: it never rewrites the transcript.
 */
export async function transcriptToMarkdown(sessionId, options = {}) {
  const root = options.root ?? transcriptsRoot()
  const { files } = findTranscriptFiles(root)
  const match = files.find((file) => file.sessionIdFromName === sessionId)
  if (!match) return { ok: false, error: `未找到会话 ${sessionId}` }

  const meta = await describeTranscript(match)
  const out = []
  out.push(`# ${meta.title ?? sessionId}`)
  out.push('')
  out.push(`- 会话 ID：\`${meta.sessionId}\``)
  if (meta.cwd) out.push(`- 工作目录：\`${meta.cwd}\``)
  if (meta.startedAt) out.push(`- 开始：${meta.startedAt}`)
  if (meta.endedAt) out.push(`- 结束：${meta.endedAt}`)
  if (meta.version) out.push(`- Claude Code 版本：${meta.version}`)
  out.push(`- 轮次：${meta.turns}（用户 ${meta.userTurns} / 助手 ${meta.assistantTurns}）`)
  out.push('')

  const stream = createReadStream(match.path, { encoding: 'utf8' })
  const lines = createInterface({ input: stream, crlfDelay: Infinity })
  try {
    for await (const line of lines) {
      if (!line.trim()) continue
      let record
      try {
        record = JSON.parse(line)
      } catch {
        continue
      }
      const type = record?.type
      if (!CONVERSATION_TYPES.has(type)) continue
      const content = record?.message?.content
      const blocks = Array.isArray(content) ? content : [{ type: 'text', text: String(content ?? '') }]
      for (const block of blocks) {
        if (block?.type === 'text' && block.text?.trim()) {
          out.push(type === 'user' ? '## 用户' : '## 助手')
          out.push('')
          out.push(block.text.trim())
          out.push('')
        } else if (block?.type === 'thinking' && block.thinking?.trim()) {
          out.push('<details><summary>推理</summary>')
          out.push('')
          out.push(block.thinking.trim())
          out.push('')
          out.push('</details>')
          out.push('')
        } else if (block?.type === 'tool_use') {
          out.push(`**工具调用** \`${block.name ?? 'tool'}\``)
          out.push('')
          out.push('```json')
          out.push(JSON.stringify(block.input ?? {}, null, 2))
          out.push('```')
          out.push('')
        } else if (block?.type === 'tool_result') {
          const text = typeof block.content === 'string' ? block.content : JSON.stringify(block.content ?? '')
          if (text.trim()) {
            out.push('<details><summary>工具结果</summary>')
            out.push('')
            out.push('```')
            out.push(text.slice(0, 4000))
            out.push('```')
            out.push('')
            out.push('</details>')
            out.push('')
          }
        }
      }
    }
  } finally {
    stream.destroy()
  }

  return { ok: true, markdown: out.join('\n'), meta }
}
