import { readFileSync, writeFileSync } from 'node:fs'

const file = 'packages/bridge/src/rollback.mjs'
let text = readFileSync(file, 'utf8').replace(/\r\n/g, '\n')

const anchor = "  if (cut <= 0) return { ok: false, error: '这已经是会话里的第一条消息，撤回它会清空整份记录，无法继续' }"
if (!text.includes(anchor)) throw new Error('guard anchor missing')

text = text.replace(
  anchor,
  [
    "  // 记录文件开头可能还有 queue-operation / attachment 这类非对话行，所以「cut 是不是第一条用户消息」",
    '  // 必须按第一条 user 条目判断，而不是按 cut 是否等于 0。',
    '  const firstUser = parsed.findIndex((entry) => {',
    "    const role = entry?.type ?? entry?.role",
    '    const content = entry?.message?.content ?? entry?.content',
    "    const isToolResult = Array.isArray(content) && content.some((part) => part?.type === 'tool_result')",
    "    return role === 'user' && !isToolResult",
    '  })',
    '  if (cut <= firstUser) {',
    "    return { ok: false, error: '这是会话里的第一条消息，撤回它会清空整份记录，会话将无法恢复' }",
    '  }',
  ].join('\n'),
)

writeFileSync(file, text, 'utf8')
console.log('first-message guard')
