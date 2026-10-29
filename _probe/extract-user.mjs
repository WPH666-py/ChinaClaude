// Print the text of user-role messages from a decompressed DSH session JSONL.
import fs from 'node:fs'

const src = process.argv[2]
const lines = fs.readFileSync(src, 'utf8').split('\n')
let n = 0
for (const line of lines) {
  if (!line.trim()) continue
  let rec
  try { rec = JSON.parse(line) } catch { continue }
  const role = rec.role ?? rec.message?.role ?? rec.kind
  if (role !== 'user' && role !== 'human') continue
  const content = rec.content ?? rec.message?.content ?? rec.text
  let text = ''
  if (typeof content === 'string') text = content
  else if (Array.isArray(content)) {
    text = content.map((c) => (typeof c === 'string' ? c : c?.text ?? c?.content ?? `[${c?.type ?? '?'}]`)).join('\n')
  } else if (content) text = JSON.stringify(content)
  if (!text.trim()) continue
  n += 1
  console.log(`--- USER#${n} (${new Date(rec.timestamp ?? rec.time ?? 0).toISOString?.() ?? '?'}) ---`)
  console.log(text.slice(0, 1200))
}
console.error(`total user messages: ${n}`)
