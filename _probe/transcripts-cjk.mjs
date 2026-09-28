/**
 * Verify the transcript listing handles Chinese text correctly, writing results as UTF-8 JSON.
 *
 * The console codepage mangles CJK, and some transcripts on this machine genuinely contain `?`
 * characters from an earlier PowerShell ASCII-body bug — so stdout cannot distinguish "the parser
 * lost the text" from "the text was never there". A UTF-8 file read back by the editor can.
 *
 * Read-only. Run: node _probe/transcripts-cjk.mjs
 */
import { writeFileSync } from 'node:fs'
import { listTranscripts } from '../packages/bridge/src/transcripts.mjs'

const listing = await listTranscripts()
const picks = [...listing.transcripts].sort((a, b) => b.turns - a.turns).slice(0, 15)

/** Whether a title carries real CJK rather than the `?` filler an ASCII round-trip leaves behind. */
const hasCjk = (text) => /[\u4e00-\u9fff]/.test(String(text ?? ''))
const isQuestionFiller = (text) => /^\?+$/.test(String(text ?? '').trim())

const report = {
  total: listing.total,
  cjkTitles: listing.transcripts.filter((item) => hasCjk(item.title)).length,
  questionFillerTitles: listing.transcripts.filter((item) => isQuestionFiller(item.title)).length,
  samples: picks.map((item) => ({
    turns: item.turns,
    bytes: item.bytes,
    cwd: item.cwd,
    title: item.title,
    titleHasCjk: hasCjk(item.title),
    previewHasCjk: hasCjk(item.preview),
    sessionId: item.sessionId,
  })),
}

// Search with a query taken from a title that is known to contain CJK, so a zero result means the
// search is broken rather than the corpus lacking the term.
const cjkSample = picks.find((item) => hasCjk(item.title))
if (cjkSample) {
  const needle = String(cjkSample.title).slice(0, 2)
  const hit = await listTranscripts({ query: needle })
  report.search = { needle, matched: hit.matched }
}

writeFileSync('_probe/transcripts-cjk.json', JSON.stringify(report, null, 2), 'utf8')
console.log('wrote _probe/transcripts-cjk.json')
console.log(`total=${report.total} cjkTitles=${report.cjkTitles} questionFillerTitles=${report.questionFillerTitles}`)
if (report.search) console.log(`search "${report.search.needle}" -> ${report.search.matched}`)
