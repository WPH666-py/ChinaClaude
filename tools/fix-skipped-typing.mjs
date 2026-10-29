import { readFileSync, writeFileSync } from 'node:fs'

const file = 'packages/web/src/App.vue'
let text = readFileSync(file, 'utf8')
text = text.replace(
  'startError.value = `有 ${restored.skipped.length} 个文件没还原：${restored.skipped.map(',
  'startError.value = `有 ${(restored.skipped ?? []).length} 个文件没还原：${(restored.skipped ?? []).map(',
)
writeFileSync(file, text, 'utf8')
console.log('typing fixed')
