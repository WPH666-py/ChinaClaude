import { readFileSync, writeFileSync } from 'node:fs'

function patch(file, pairs) {
  let text = readFileSync(file, 'utf8').replace(/\r\n/g, '\n')
  for (const [before, after] of pairs) {
    if (!text.includes(before)) throw new Error(file + ' missing: ' + before.slice(0, 80))
    text = text.replace(before, after)
  }
  writeFileSync(file, text, 'utf8')
}

/* 1) 重启不再清空事件历史（上下文在 UI 里消失的真正原因） */
patch('packages/bridge/src/session.mjs', [
  [
    '    this.seq = 0\n    this.history.length = 0',
    [
      '    /**',
      '     * 历史必须跨重启保留。',
      '     *',
      '     * WHY: 重启只是换了子进程（--resume 会把上下文带回来），但 UI 的对话是从事件历史重放的。',
      '     * 之前这里把 seq 和 history 清零，于是「切模型」在界面上看起来像开了一个新会话 —— 上下文其实还在，',
      '     * 只是没有任何一条消息可以重放。',
      '     */',
    ].join('\n'),
  ],
])

/* 2) 客户端重启分支不再清空本地事件 */
patch('packages/web/src/composables/useBridge.ts', [
  [
    '    if (result.mode === \'restarted\') {\n      events.value = []\n      attach(sessionId)\n    }',
    [
      "    if (result.mode === 'restarted') {",
      '      // 不清空：桥保留了事件历史，attach 会带 last-event-id 只补增量；清空会让切模型看起来像新会话。',
      '      attach(sessionId)',
      '    }',
    ].join('\n'),
  ],
])

/* 3) 撤回：消息气泡上的按钮 */
patch('packages/web/src/components/Transcript.vue', [
  [
    '        <div v-if="event.kind === \'user\'" class="userRow">\n          <div class="userBubble">{{ event.text }}</div>\n        </div>',
    [
      '        <div v-if="event.kind === \'user\'" class="userRow">',
      '          <button',
      '            v-if="!busy"',
      "            class=\"userRecall\"",
      '            type="button"',
      '            title="撤回这条消息并回滚到这里"',
      '            @click="emit(\'recall\', event.text ?? \'\')"',
      '          >',
      '            撤回',
      '          </button>',
      '          <div class="userBubble">{{ event.text }}</div>',
      '        </div>',
    ].join('\n'),
  ],
  [
    "  (e: 'answer', payload: { requestId: string; behavior: 'completed' | 'cancelled'; result?: unknown }): void",
    "  (e: 'answer', payload: { requestId: string; behavior: 'completed' | 'cancelled'; result?: unknown }): void\n  /** 撤回这条用户消息：回滚会话到它之前，并把原文放回输入框。 */\n  (e: 'recall', text: string): void",
  ],
])

/* 4) App：撤回处理 */
patch('packages/web/src/App.vue', [
  [
    'async function onModelsChanged() {',
    [
      '/**',
      ' * 撤回一条消息：让桥把会话记录截断到这条之前，重启子进程（--resume），并把原文放回输入框。',
      ' *',
      ' * WHY IT RESTARTS: 会话记录是 CLI 的权威历史，只有重新加载它，下一轮才真的看不到被撤回的部分。',
      ' */',
      'async function onRecall(text: string) {',
      '  const id = bridge.activeSessionId.value',
      '  if (!id) return',
      '  const confirmed = window.confirm(\'撤回这条消息？它之后的问答会一起回滚。\')',
      '  if (!confirmed) return',
      '  try {',
      "    const response = await fetch(`${bridge.baseUrl.value}/api/rollback`, {",
      "      method: 'POST',",
      "      headers: { 'content-type': 'application/json' },",
      '      body: JSON.stringify({ sessionId: id, text }),',
      '    })',
      '    const answer = (await response.json()) as { ok: boolean; error?: string; removedText?: string; restarted?: boolean }',
      '    if (!answer.ok) {',
      '      startError.value = `撤回失败：${answer.error ?? \'未知原因\'}`',
      '      return',
      '    }',
      '    composerDraft.value = answer.removedText ?? text',
      '    startError.value = null',
      '  } catch (problem) {',
      '    startError.value = `撤回失败：${problem instanceof Error ? problem.message : String(problem)}`',
      '  }',
      '}',
      '',
      'async function onModelsChanged() {',
    ].join('\n'),
  ],
  [
    '          @change-model="onChangeModel"',
    '          @change-model="onChangeModel"\n          @recall="onRecall"',
  ],
])

/* 5) 顶部菜单去掉回滚 */
{
  const file = 'packages/web/src/components/TopMenu.vue'
  let text = readFileSync(file, 'utf8').replace(/\r\n/g, '\n')
  text = text.replace(/\n    <button class="tm__item" type="button" :disabled="busy \|\| !sessionId"[^\n]*回滚上一轮<\/button>/, '')
  const start = text.indexOf('/**\n * 回滚上一轮：截断会话记录')
  if (start >= 0) {
    const end = text.indexOf('async function devtools() {', start)
    text = text.slice(0, start) + text.slice(end)
  }
  writeFileSync(file, text, 'utf8')
}

/* 6) 费用核算：把费用统计原样搬进来 */
patch('packages/web/src/components/CostPanel.vue', [
  ['const props = defineProps<{', 'const props = defineProps<{\n  /** 由设置页内嵌时不给遮罩。 */\n  inline?: boolean'],
  ['  <ShellDialog title="费用统计"', '  <ShellDialog :inline="inline" title="费用统计"'],
])

patch('packages/web/src/components/SettingsPanel.vue', [
  ["import PluginManagerPanel from './PluginManagerPanel.vue'", "import PluginManagerPanel from './PluginManagerPanel.vue'\nimport CostPanel from './CostPanel.vue'"],
  [
    '          <template v-else-if="section === \'pricing\'">\n            <h3 class="st__h">费用核算</h3>',
    [
      '          <template v-else-if="section === \'pricing\'">',
      '            <!-- 费用统计整页搬进来：会话数 / 合计 / 计价模型数 / 计价依据，和独立窗口一模一样。 -->',
      '            <CostPanel',
      '              inline',
      '              :sessions="bridge.sessions.value"',
      '              :active-id="bridge.activeSessionId.value"',
      '              @close="() => {}"',
      '            />',
      '            <h3 class="st__h">单价与价目表</h3>',
    ].join('\n'),
  ],
])

console.log('round7 patched')
