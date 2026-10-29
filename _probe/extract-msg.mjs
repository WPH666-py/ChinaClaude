// Print user/assistant text from a decompressed DSH v3 session JSONL.
import fs from 'node:fs'

const src = process.argv[2]
const what = process.argv[3] ?? 'user'
const limit = Number(process.argv[4] ?? 1500)
const lines = fs.readFileSync(src, 'utf8').split('\n')
let n = 0
for (const line of lines) {
  if (!line.trim()) continue
  let rec
  try { rec = JSON.parse(line) } catch { continue }
  if (rec.type !== `${what}/message`) continue
  const d = rec.data ?? {}
  let text = d.text ?? d.content ?? ''
  if (Array.isArray(text)) {
    text = text.map((c) => (typeof c === 'string' ? c : c?.text ?? `[${c?.type ?? '?'}]`)).join('\n')
  } else if (typeof text !== 'string') {
    text = JSON.stringify(text)
  }
  if (!text.trim()) continue
  n += 1
  const when = rec.time ? new Date(rec.time).toISOString() : '?'
  console.log(`--- ${what}#${n} seq=${rec.seq} ${when} ---`)
  console.log(text.slice(0, limit))
}
console.error(`total ${what} messages: ${n}`)
