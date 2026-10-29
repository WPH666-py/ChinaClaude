import { readFileSync, writeFileSync } from 'node:fs'

function patch(file, pairs) {
  let text = readFileSync(file, 'utf8').replace(/\r\n/g, '\n')
  for (const [before, after] of pairs) {
    if (!text.includes(before)) throw new Error(file + ' missing: ' + before.slice(0, 80))
    text = text.replace(before, after)
  }
  writeFileSync(file, text, 'utf8')
}

/* 1) 撤回事件是从 Transcript 发出来的，必须绑在 Transcript 上（之前绑到了 Composer，所以点了没反应） */
patch('packages/web/src/App.vue', [
  [
    '          @answer="onDialogAnswer"',
    '          @answer="onDialogAnswer"\n          @recall="onRecall"',
  ],
])

/* 2) 按钮样式：淡橙、小、贴在气泡左侧 */
patch('packages/web/src/components/Transcript.vue', [
  [
    '.userBubble {',
    [
      '.userRow {',
      '  align-items: center;',
      '  gap: 8px;',
      '}',
      '',
      '.userRecall {',
      '  padding: 1px 9px;',
      '  border: 1px solid rgba(246, 165, 92, 0.5);',
      '  border-radius: 999px;',
      '  background: rgba(246, 165, 92, 0.14);',
      '  color: #ffc38a;',
      '  font-size: 11px;',
      '  line-height: 18px;',
      '  opacity: 0;',
      '  transition: opacity 0.15s ease;',
      '}',
      '',
      '.userRow:hover .userRecall,',
      '.userRecall:focus-visible {',
      '  opacity: 1;',
      '}',
      '',
      '.userBubble {',
    ].join('\n'),
  ],
])

console.log('recall wired + styled')
