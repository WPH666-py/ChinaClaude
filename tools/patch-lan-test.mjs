import { readFileSync, writeFileSync } from 'node:fs'

const file = 'packages/bridge/test/lan-access.mjs'
let text = readFileSync(file, 'utf8')

const before = "check('电脑端可以发布模型配置', publish.status === 200 && publish.json().providers?.length === 1)"
const after = [
  '// 发布是合并语义（桌面端每次启动都会 POST 一次，整份覆盖会把导入行抹掉），所以断言「包含」而不是「唯一」。',
  "check('电脑端可以发布模型配置', publish.status === 200 && (publish.json().providers ?? []).some((p) => p.name === 'DeepSeek'))",
].join('\n')
text = text.replace(before, after)

text = text.replace(
  "check('回环读到已发布的模型并标记 loopback:true', loopModels.loopback === true && loopModels.providers[0]?.name === 'DeepSeek')",
  [
    "const shared = (loopModels.providers ?? []).find((p) => p.name === 'DeepSeek')",
    "check('回环读到已发布的模型并标记 loopback:true', loopModels.loopback === true && shared?.baseUrl === 'https://api.deepseek.com/anthropic')",
  ].join('\n'),
)

text = text.replace(
  "check('回环读取的共享模型也不含 API-KEY', loopModels.providers[0]?.apiKey === '' && !JSON.stringify(loopModels).includes('sk-shared-123'))",
  "check('回环读取的共享模型也不含 API-KEY', shared?.apiKey === '' && !JSON.stringify(loopModels).includes('sk-shared-123'))",
)

writeFileSync(file, text, 'utf8')
console.log('patched lan-access')
