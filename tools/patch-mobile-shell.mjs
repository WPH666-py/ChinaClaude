import { readFileSync, writeFileSync } from 'node:fs'

const file = 'packages/web/src/App.vue'
let text = readFileSync(file, 'utf8').replace(/\r\n/g, '\n')

// 1) import + refs
text = text.replace(
  "import TopMenu from './components/TopMenu.vue'",
  "import TopMenu from './components/TopMenu.vue'\nimport MobileFab from './components/MobileFab.vue'",
)

// 2) 响应式断点 + 顶部菜单句柄
text = text.replace(
  "const workbenchOpen = ref(true)",
  [
    'const workbenchOpen = ref(true)',
    '',
    '/** 小屏（手机/平板竖屏）：顶部菜单换成悬浮球，工作台变成整屏抽屉。 */',
    "const isCompact = ref(false)",
    'const topMenu = ref<InstanceType<typeof TopMenu> | null>(null)',
    'let compactQuery: MediaQueryList | null = null',
    '',
    'function syncCompact(event: MediaQueryList | MediaQueryListEvent) {',
    '  isCompact.value = event.matches',
    '}',
    '',
    '/** 悬浮球的动作：能自己处理的自己处理，弹窗类的转给 TopMenu。 */',
    'function onFabAction(name: string) {',
    '  if (name === \'restart\') void topMenu.value?.restart()',
    '  else if (name === \'logs\') topMenu.value?.showLogs()',
    '  else if (name === \'author\') topMenu.value?.showAuthor()',
    '  else if (name === \'shop\') topMenu.value?.showShop()',
    '  else if (name === \'plugins\') openSettings(\'plugins\')',
    '  else if (name === \'server\') mainView.value = \'server\'',
    '}',
  ].join('\n'),
)

// 3) 挂载/卸载监听（放在已有的 onMounted 里最稳：这里改用 onBeforeUnmount 旁边插入）
const lifecycleAnchor = 'onMounted(async () => {'
if (!text.includes(lifecycleAnchor)) throw new Error('onMounted anchor missing')
text = text.replace(
  lifecycleAnchor,
  [
    'onMounted(() => {',
    "  compactQuery = window.matchMedia('(max-width: 820px)')",
    '  syncCompact(compactQuery)',
    "  compactQuery.addEventListener('change', syncCompact)",
    '})',
    '',
    'onBeforeUnmount(() => {',
    "  compactQuery?.removeEventListener('change', syncCompact)",
    '})',
    '',
    lifecycleAnchor,
  ].join('\n'),
)

// 4) 顶部菜单绑定 ref/compact，悬浮球 + 工作台左侧标签
text = text.replace(
  '    <TopMenu\n      :version=',
  '    <TopMenu\n      ref="topMenu"\n      :compact="isCompact"\n      :version=',
)
text = text.replace(
  '    <!-- 右栏只放文件树；点文件才在中间弹预览，关掉就回到对话。 -->',
  [
    '    <MobileFab v-if="isCompact" @action="onFabAction" />',
    '',
    '    <!-- 工作台拉手：淡橙色竖标签常驻屏幕左边，点它收起/展开（收起后不会再也拉不回来）。 -->',
    '    <button',
    '      class="dockTab"',
    '      type="button"',
    '      :title="workbenchOpen ? \'收起工作台\' : \'打开工作台\'"',
    '      @click="workbenchOpen = !workbenchOpen"',
    '    >',
    '      {{ workbenchOpen ? \'收起工作台\' : \'工作台\' }}',
    '    </button>',
    '',
    '    <!-- 右栏只放文件树；点文件才在中间弹预览，关掉就回到对话。 -->',
  ].join('\n'),
)

writeFileSync(file, text, 'utf8')
console.log('App patched')
