/**
 * Prove CJK search and export work, using the ONE transcript on this machine that still holds real
 * Chinese text.
 *
 * This matters more than it looks: the app is Chinese-facing, and most CJK prompts on disk were
 * flattened to `?` by an earlier PowerShell ASCII-body bug, so a naive "search returned 0" reading
 * would wrongly blame the parser. Fixtures in test/transcripts.mjs cover CJK synthetically; this
 * confirms it against real bytes.
 *
 * Read-only. Run: node _probe/transcripts-cjk-search.mjs
 */
import { writeFileSync } from 'node:fs'
import { listTranscripts, transcriptToMarkdown } from '../packages/bridge/src/transcripts.mjs'

const hasCjk = (text) => /[\u4e00-\u9fff]/.test(String(text ?? ''))

const all = await listTranscripts()
const cjk = all.transcripts.filter((item) => hasCjk(item.title) || hasCjk(item.preview))
console.log(`transcripts with real CJK text: ${cjk.length}`)

const report = { found: cjk.length, cases: [] }

for (const item of cjk.slice(0, 5)) {
  const source = hasCjk(item.title) ? item.title : item.preview
  // Two-character needle keeps the match a real substring search rather than a whole-string equal.
  const needle = String(source).slice(0, 2)
  const hit = await listTranscripts({ query: needle })
  const included = hit.transcripts.some((row) => row.sessionId === item.sessionId)

  const exported = await transcriptToMarkdown(item.sessionId)
  const markdown = exported.ok ? exported.markdown : ''

  report.cases.push({
    sessionId: item.sessionId,
    title: item.title,
    needle,
    matched: hit.matched,
    selfIncluded: included,
    exportOk: exported.ok === true,
    exportHasCjk: hasCjk(markdown),
    exportBytes: markdown.length,
  })

  console.log(`\nsession ${item.sessionId}`)
  console.log(`  title:    ${item.title}`)
  console.log(`  needle:   ${needle}`)
  console.log(`  matched:  ${hit.matched}  self-included: ${included}`)
  console.log(`  export:   ok=${exported.ok} cjk=${hasCjk(markdown)} bytes=${markdown.length}`)
}

// A negative control: a CJK string that cannot be present must return nothing, proving the search
// is not simply matching everything when the query contains CJK.
const control = await listTranscripts({ query: '这个字符串不可能出现在任何会话里' })
report.negativeControl = control.matched
console.log(`\nnegative control (CJK nonsense query) -> ${control.matched} matches`)

writeFileSync('_probe/transcripts-cjk-search.json', JSON.stringify(report, null, 2), 'utf8')
console.log('wrote _probe/transcripts-cjk-search.json')
