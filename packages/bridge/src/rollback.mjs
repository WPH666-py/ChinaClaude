/**
 * 消息回滚（dsh-message-ops）：把会话退回到上一条用户消息之前。
 *
 * HOW IT ACTUALLY WORKS: Claude Code keeps the authoritative transcript as JSONL under
 * `~/.claude/projects/<slugified cwd>/<sessionId>.jsonl`, and `--resume` replays that file. So a real
 * rollback is "drop the trailing lines, then resume" — not a UI-only illusion that the model would
 * immediately contradict on the next turn.
 *
 * WHAT IT REFUSES: a session that is currently streaming (the child would append after truncation and
 * the file would end up with two different histories), and a transcript that does not parse as JSONL
 * (a half-written line means the file is being written right now).
 */
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

function projectsRoot() {
  return join(homedir(), '.claude', 'projects')
}

/** Find `<sessionId>.jsonl` under any project directory; ids are unique, so the slug does not matter. */
function findTranscript(sessionId) {
  const root = projectsRoot()
  const file = `${sessionId}.jsonl`
  if (!existsSync(root)) return null
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const candidate = join(root, entry.name, file)
    if (existsSync(candidate)) return candidate
  }
  return null
}

/**
 * @param {{ sessionId: string, cwd?: string }} input
 * @returns {{ ok: boolean, path?: string, kept?: number, removed?: number, removedText?: string, error?: string }}
 */
export function rollbackLastTurn({ sessionId, text } = {}) {
  const id = String(sessionId ?? '').trim()
  if (id === '') return { ok: false, error: '没有活动会话' }
  const path = findTranscript(id)
  if (!path) return { ok: false, error: '找不到这个会话的记录文件（可能还没落到磁盘）' }

  const raw = readFileSync(path, 'utf8')
  const lines = raw.split(/\r?\n/).filter((line) => line.trim() !== '')
  if (lines.length === 0) return { ok: false, error: '记录文件是空的' }

  const parsed = []
  for (const line of lines) {
    try {
      parsed.push(JSON.parse(line))
    } catch {
      return { ok: false, error: '记录文件里有一行不完整：会话可能正在写入，等它结束后再回滚' }
    }
  }

  /** 取一条记录的纯文本，用来和界面上的气泡对齐。 */
  const textOf = (entry) => {
    const content = entry?.message?.content ?? entry?.content
    if (typeof content === 'string') return content
    if (Array.isArray(content)) {
      return content.filter((part) => part?.type === 'text').map((part) => part.text ?? '').join('\n')
    }
    return ''
  }

  // 最后一条「真正的用户输入」——工具结果也是 user 角色，必须排除，否则只会退掉一次工具调用。
  let cut = -1
  for (let index = parsed.length - 1; index >= 0; index -= 1) {
    const entry = parsed[index]
    const role = entry?.type ?? entry?.role
    const content = entry?.message?.content ?? entry?.content
    const isToolResult = Array.isArray(content) && content.some((part) => part?.type === 'tool_result')
    if (role === 'user' && !isToolResult) {
      cut = index
      break
    }
  }
  /**
   * 指定了原文时，退到「这条消息」之前；否则退到「最后一条用户消息」之前。
   *
   * WHY COMPARE TEXT AND NOT AN INDEX: 界面上的气泡来自事件历史，而记录文件是 CLI 写的另一份；
   * 两者没有共享 id，能稳定对齐的只有内容本身。取最后一次匹配，避免同一条消息被重复发送时退错位置。
   */
  const wanted = String(text ?? '').trim()
  if (wanted !== '') {
    // 指定了原文就不该再沿用「最后一条」的结果：否则点错的消息会退掉整轮。
    cut = -1
    for (let index = parsed.length - 1; index >= 0; index -= 1) {
      const entry = parsed[index]
      const role = entry?.type ?? entry?.role
      const isToolResult =
        Array.isArray(entry?.message?.content) && entry.message.content.some((part) => part?.type === 'tool_result')
      if (role === 'user' && !isToolResult && textOf(entry).trim() === wanted) {
        cut = index
        break
      }
    }
  }

  if (wanted !== '' && cut < 0) {
    return { ok: false, error: '没找到这条消息：它可能已经被回滚过，或记录还没落盘' }
  }
  if (cut < 0) return { ok: false, error: '这个会话里没有可回滚的用户消息' }
  /**
   * 截到第一条之前 = 空文件。空的 .jsonl 不是「没有上下文」，而是 CLI 眼里的「会话不存在」：
   * --resume 会直接 exit 1。所以第一条消息不能撤回，到边界就如实拒绝。
   */
  // 记录文件开头可能还有 queue-operation / attachment 这类非对话行，所以「cut 是不是第一条用户消息」
  // 必须按第一条 user 条目判断，而不是按 cut 是否等于 0。
  const firstUser = parsed.findIndex((entry) => {
    const role = entry?.type ?? entry?.role
    const content = entry?.message?.content ?? entry?.content
    const isToolResult = Array.isArray(content) && content.some((part) => part?.type === 'tool_result')
    return role === 'user' && !isToolResult
  })
  if (cut <= firstUser) {
    return { ok: false, error: '这是会话里的第一条消息，撤回它会清空整份记录，会话将无法恢复' }
  }

  const removedLines = lines.length - cut
  if (removedLines <= 0) return { ok: false, error: '已经在第一条消息之前，没有可回滚的内容' }

  const removedText = textOf(parsed[cut]).slice(0, 4000)

  // 备份：回滚是删除操作，点错了必须能捞回来。只留最近一份，避免目录里堆满历史。
  // 每次回滚都留一份带时间戳的备份：只有一份 `.before-rollback` 时，第二次回滚会把第一次的退路覆盖掉，
  // 表现就是「只能回滚有限次数」。
  const backup = `${path}.before-rollback-${Date.now()}`
  writeFileSync(backup, lines.join('\n') + '\n', 'utf8')

  writeFileSync(path, lines.slice(0, cut).join('\n') + (cut > 0 ? '\n' : ''), 'utf8')
  return { ok: true, path, backup, kept: cut, removed: removedLines, removedText }
}
