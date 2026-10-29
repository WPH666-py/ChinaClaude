import { readFileSync, writeFileSync } from 'node:fs'

const app = 'packages/web/src/App.vue'
let text = readFileSync(app, 'utf8').replace(/\r\n/g, '\n')
text = text.replace(
  "import ServerManage from './components/ServerManage.vue'",
  "import ServerManage from './components/ServerManage.vue'\nimport MobileAccess from './components/MobileAccess.vue'",
)
text = text.replace("ref<'chat' | 'server'>('chat')", "ref<'chat' | 'server' | 'mobile'>('chat')")
text = text.replace(
  '@open-server="mainView = \'server\'"',
  '@open-server="mainView = \'server\'"\n      @open-mobile="mainView = \'mobile\'"',
)
text = text.replace(
  '    <ServerManage\n      v-if="mainView === \'server\'"',
  '    <MobileAccess v-if="mainView === \'mobile\'" @close="mainView = \'chat\'" />\n\n    <ServerManage\n      v-if="mainView === \'server\'"',
)
writeFileSync(app, text, 'utf8')

const menu = 'packages/web/src/components/TopMenu.vue'
let top = readFileSync(menu, 'utf8').replace(/\r\n/g, '\n')
top = top.replace("(e: 'open-server'): void", "(e: 'open-server'): void\n  (e: 'open-mobile'): void")
top = top.replace(
  '<button class="tm__item" type="button" @click="emit(\'open-server\')">服务器管理</button>',
  '<button class="tm__item" type="button" @click="emit(\'open-mobile\')">移动访问</button>\n        <button class="tm__item" type="button" @click="emit(\'open-server\')">服务器管理</button>',
)
writeFileSync(menu, top, 'utf8')
console.log('wired')
