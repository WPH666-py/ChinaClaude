import { readFileSync, writeFileSync } from 'node:fs'

function patch(file, pairs) {
  let text = readFileSync(file, 'utf8').replace(/\r\n/g, '\n')
  for (const [before, after] of pairs) {
    if (!text.includes(before)) throw new Error(file + ' missing: ' + before.slice(0, 80))
    text = text.replace(before, after)
  }
  writeFileSync(file, text, 'utf8')
}

patch('packages/web/src/components/CostPanel.vue', [
  ['const props = defineProps<{', 'const props = defineProps<{\n  /** 由设置页内嵌时不给遮罩。 */\n  inline?: boolean'],
  ['  <ShellDialog\n    title="费用统计"', '  <ShellDialog\n    :inline="inline"\n    title="费用统计"'],
])

patch('packages/web/src/components/SettingsPanel.vue', [
  ["import PluginManagerPanel from './PluginManagerPanel.vue'", "import PluginManagerPanel from './PluginManagerPanel.vue'\nimport CostPanel from './CostPanel.vue'"],
  [
    "          <template v-else-if=\"section === 'pricing'\">\n            <h3 class=\"st__h\">费用核算</h3>",
    [
      "          <template v-else-if=\"section === 'pricing'\">",
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

console.log('cost embedded')
