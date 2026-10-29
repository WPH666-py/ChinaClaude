import { readFileSync, writeFileSync } from 'node:fs'

function patch(file, pairs) {
  let text = readFileSync(file, 'utf8').replace(/\r\n/g, '\n')
  for (const [before, after] of pairs) {
    if (!text.includes(before)) throw new Error(file + ' missing: ' + before.slice(0, 80))
    text = text.replace(before, after)
  }
  writeFileSync(file, text, 'utf8')
}

/* 1) App: composerDraft 是 { text, nonce } */
patch('packages/web/src/App.vue', [
  [
    '    composerDraft.value = answer.removedText ?? text',
    '    composerDraft.value = { text: answer.removedText ?? text, nonce: Date.now() }',
  ],
])

/* 2) rollback: 支持按文本定位 + 返回原文 */
patch('packages/bridge/src/rollback.mjs', [
  [
    'export function rollbackLastTurn({ sessionId } = {}) {',
    'export function rollbackLastTurn({ sessionId, text } = {}) {',
  ],
  [
    "  // 最后一条「真正的用户输入」——工具结果也是 user 角色，必须排除，否则只会退掉一次工具调用。",
    [
      '  /** 取一条记录的纯文本，用来和界面上的气泡对齐。 */',
      '  const textOf = (entry) => {',
      '    const content = entry?.message?.content ?? entry?.content',
      "    if (typeof content === 'string') return content",
      '    if (Array.isArray(content)) {',
      "      return content.filter((part) => part?.type === 'text').map((part) => part.text ?? '').join('\\n')",
      '    }',
      "    return ''",
      '  }',
      '',
      '  // 最后一条「真正的用户输入」——工具结果也是 user 角色，必须排除，否则只会退掉一次工具调用。',
    ].join('\n'),
  ],
  [
    '  if (cut < 0) return { ok: false, error: \'这个会话里没有可回滚的用户消息\' }',
    [
      '  /**',
      '   * 指定了原文时，退到「这条消息」之前；否则退到「最后一条用户消息」之前。',
      '   *',
      '   * WHY COMPARE TEXT AND NOT AN INDEX: 界面上的气泡来自事件历史，而记录文件是 CLI 写的另一份；',
      '   * 两者没有共享 id，能稳定对齐的只有内容本身。取最后一次匹配，避免同一条消息被重复发送时退错位置。',
      '   */',
      "  const wanted = String(text ?? '').trim()",
      '  if (wanted !== \'\') {',
      '    for (let index = parsed.length - 1; index >= 0; index -= 1) {',
      '      const entry = parsed[index]',
      "      const role = entry?.type ?? entry?.role",
      '      const isToolResult =',
      "        Array.isArray(entry?.message?.content) && entry.message.content.some((part) => part?.type === 'tool_result')",
      "      if (role === 'user' && !isToolResult && textOf(entry).trim() === wanted) {",
      '        cut = index',
      '        break',
      '      }',
      '    }',
      '  }',
      '',
      "  if (cut < 0) return { ok: false, error: '这个会话里没有可回滚的用户消息' }",
    ].join('\n'),
  ],
  [
    '  const removedText =\n    typeof parsed[cut]?.message?.content === \'string\'\n      ? parsed[cut].message.content.slice(0, 200)\n      : Array.isArray(parsed[cut]?.message?.content)\n        ? parsed[cut].message.content.find((part) => part?.type === \'text\')?.text?.slice(0, 200) ?? \'\'\n        : \'\'',
    '  const removedText = textOf(parsed[cut]).slice(0, 4000)',
  ],
])

/* 3) server: 用 CLI 的会话 id 找文件，并在截断后原地重启 */
{
  const file = 'packages/bridge/src/server.mjs'
  let text = readFileSync(file, 'utf8').replace(/\r\n/g, '\n')
  const before = [
    "      if (url.pathname === '/api/rollback') {",
    '        if (!gate.loopback) {',
    "          sendJson(res, 403, { ok: false, error: '只有电脑端可以回滚会话' })",
    '          return',
    '        }',
    '        const body = await readJsonBody(req)',
    '        sendJson(res, 200, rollbackLastTurn({ sessionId: body.sessionId }))',
    '        return',
    '      }',
  ].join('\n')
  if (!text.includes(before)) throw new Error('rollback route anchor missing')
  const after = [
    "      if (url.pathname === '/api/rollback') {",
    '        if (!gate.loopback) {',
    "          sendJson(res, 403, { ok: false, error: '只有电脑端可以回滚会话' })",
    '          return',
    '        }',
    '        const body = await readJsonBody(req)',
    '        const session = sessions.get(String(body.sessionId ?? \'\'))',
    '        if (!session) {',
    "          sendJson(res, 404, { ok: false, error: 'session not found' })",
    '          return',
    '        }',
    '        // 记录文件用的是 CLI 自己的会话 id，不是桥的 id —— 用错了就会「找不到记录文件」。',
    '        const result = rollbackLastTurn({ sessionId: session.claudeSessionId, text: body.text })',
    '        if (result.ok) {',
    '          // 重启后 --resume 重新读那份被截断的记录：这是让回滚真正生效的唯一方式。',
    '          try {',
    '            await session.restartWith()',
    '            result.restarted = true',
    '          } catch (error) {',
    '            result.restarted = false',
    "            result.error = `已截断记录，但重启会话失败：${error instanceof Error ? error.message : String(error)}`",
    '          }',
    '        }',
    '        sendJson(res, 200, result)',
    '        return',
    '      }',
  ].join('\n')
  text = text.replace(before, after)
  writeFileSync(file, text, 'utf8')
}

console.log('rollback wired')
