// Tail of a decompressed DSH v3 session: last assistant text blocks + last tool calls.
import fs from 'node:fs'

const src = process.argv[2]
const nText = Number(process.argv[3] ?? 5)
const nCall = Number(process.argv[4] ?? 15)
const lines = fs.readFileSync(src, 'utf8').split('\n').filter(Boolean)

const texts = []
const calls = []
for (const line of lines) {
  let rec
  try { rec = JSON.parse(line) } catch { continue }
  if (rec.type === 'assistant/message') {
    const content = rec.data?.message?.content ?? []
    for (const c of content) {
      if (c?.type === 'text' && c.text?.trim()) texts.push({ seq: rec.seq, text: c.text })
    }
  }
  if (rec.type === 'tool/call') {
    calls.push({ seq: rec.seq, name: rec.data?.name ?? rec.data?.tool, input: rec.data?.input ?? rec.data?.arguments })
  }
}

console.log(`### LAST ${nText} ASSISTANT TEXT BLOCKS`)
for (const t of texts.slice(-nText)) {
  console.log(`--- text seq=${t.seq} ---`)
  console.log(t.text)
}
console.log(`\n### LAST ${nCall} TOOL CALLS`)
for (const c of calls.slice(-nCall)) {
  console.log(`--- call seq=${c.seq} ${c.name} ---`)
  console.log(JSON.stringify(c.input).slice(0, 900))
}
