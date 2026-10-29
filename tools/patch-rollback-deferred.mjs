import { readFileSync, writeFileSync } from 'node:fs'

function patch(file, pairs) {
  let text = readFileSync(file, 'utf8').replace(/\r\n/g, '\n')
  for (const [before, after] of pairs) {
    if (!text.includes(before)) throw new Error(file + ' missing: ' + before.slice(0, 80))
    text = text.replace(before, after)
  }
  writeFileSync(file, text, 'utf8')
}

/* 1) 会话：回滚不立刻重启，等下一次发送前再按截断后的记录重启 */
patch('packages/bridge/src/session.mjs', [
  [
    '  send(text) {\n    if (!this.child || !this.child.stdin.writable) return false',
    [
      '  send(text) {',
      '    /**',
      '     * 回滚后的第一次发送：先按被截断的记录重启，模型才真的看不到被撤回的内容。',
      '     *',
      '     * WHY NOT RESTART AT ROLLBACK TIME: 立刻重启会让会话当场「结束」——用户只是想撤掉一轮，',
      '     * 不是想关掉会话。延迟到下一次发送，界面保持可用，上下文在真正需要时才重载。',
      '     */',
      '    if (this.rollbackPending) {',
      '      this.rollbackPending = false',
      '      try {',
      '        this.restartWith()',
      '      } catch {',
      '        // 重启失败就让这一轮按旧进程继续，下一轮还会再试。',
      '      }',
      '    }',
      '    if (!this.child || !this.child.stdin.writable) return false',
    ].join('\n'),
  ],
])

/* 2) 服务端：只截断 + 打标记，不重启 */
{
  const file = 'packages/bridge/src/server.mjs'
  let text = readFileSync(file, 'utf8').replace(/\r\n/g, '\n')
  const before = [
    '        if (result.ok) {',
    '          // 重启后 --resume 重新读那份被截断的记录：这是让回滚真正生效的唯一方式。',
    '          try {',
    '            await session.restartWith()',
    '            result.restarted = true',
    '          } catch (error) {',
    '            result.restarted = false',
    '            result.error = `已截断记录，但重启会话失败：${error instanceof Error ? error.message : String(error)}`',
    '          }',
    '        }',
  ].join('\n')
  if (!text.includes(before)) throw new Error('restart block missing')
  const after = [
    '        if (result.ok) {',
    '          // 不在这里重启：会话会当场变成「已结束」，而用户只是想撤回一轮。',
    '          // 标记一下，下一次发送前再按截断后的记录重启。',
    '          session.rollbackPending = true',
    '          result.pending = true',
    '        }',
  ].join('\n')
  text = text.replace(before, after)
  writeFileSync(file, text, 'utf8')
}

/* 3) 前端：撤回成功后，把本地时间线里这条消息及其之后的事件一起移除 */
patch('packages/web/src/App.vue', [
  [
    '    composerDraft.value = { text: answer.removedText ?? text, nonce: Date.now() }',
    [
      '    composerDraft.value = { text: answer.removedText ?? text, nonce: Date.now() }',
      '    // 本地时间线同步回退：否则被撤回的问答还留在屏幕上，看起来像回滚没生效。',
      '    const target = text.trim()',
      '    for (let index = bridge.events.value.length - 1; index >= 0; index -= 1) {',
      '      const event = bridge.events.value[index]',
      '      if (event.kind === \'user\' && (event.text ?? \'\').trim() === target) {',
      '        bridge.events.value = bridge.events.value.slice(0, index)',
      '        break',
      '      }',
      '    }',
      '    startError.value = null',
    ].join('\n'),
  ],
])

console.log('rollback now deferred')
