// Summarize a decoded DSH session JSONL: print the last N conversational entries.
// Usage: node session-tail.cjs <decoded.jsonl> [count]
const fs = require('fs')
const lines = fs.readFileSync(process.argv[2], 'utf8').split('\n').filter(Boolean)
const want = Number(process.argv[3] || 40)
const out = []
for (const l of lines) {
  let o
  try { o = JSON.parse(l) } catch { continue }
  const t = o.type
  const d = o.data || {}
  if (t === 'user/message') {
    const txt = (d.content || []).map((c) => (c.type === 'text' ? c.text : c.type === 'image' ? '[image]' : `[${c.type}]`)).join(' ')
    out.push({ t, seq: o.seq, txt })
  } else if (t === 'assistant/message') {
    const c = (d.message && d.message.content) || []
    const parts = c.map((x) => {
      if (x.type === 'text') return x.text
      if (x.type === 'tool_use' || x.type === 'tool-call') return `\n<tool ${x.name || x.toolName}> ${JSON.stringify(x.arguments || x.input || {}).slice(0, 900)}`
      return ''
    })
    out.push({ t, seq: o.seq, turn: d.turn, step: d.step, txt: parts.join('\n') })
  }
}
for (const e of out.slice(-want)) {
  console.log(`\n===== #${e.seq} ${e.t} turn=${e.turn ?? ''} step=${e.step ?? ''} =====`)
  console.log(e.txt.slice(0, 2400))
}
