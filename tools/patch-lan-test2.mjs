import { readFileSync, writeFileSync } from 'node:fs'

const file = 'packages/bridge/test/lan-access.mjs'
let text = readFileSync(file, 'utf8')

text = text.replace(
  "check('已配对手机可以读到共享模型（loopback:false）', lanModels.status === 200 && lanModels.json().loopback === false && lanModels.json().providers?.length === 1)",
  "const lanShared = (lanModels.json().providers ?? []).find((p) => p.name === 'DeepSeek')\ncheck('已配对手机可以读到共享模型（loopback:false）', lanModels.status === 200 && lanModels.json().loopback === false && lanShared !== undefined)",
)

writeFileSync(file, text, 'utf8')
console.log('patched lan models check')
