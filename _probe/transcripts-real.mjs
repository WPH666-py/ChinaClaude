/**
 * Run the transcript listing against the REAL Claude Code history on this machine.
 *
 * A synthetic fixture proves the parsing rules; it cannot prove the feature is useful or that it
 * finishes. This measures both, and prints what the import panel would actually show.
 *
 * Read-only. Run: node _probe/transcripts-real.mjs
 */
import { listTranscripts, groupTranscripts, transcriptsRoot } from '../packages/bridge/src/transcripts.mjs'

console.log(`root: ${transcriptsRoot()}`)
const started = Date.now()
const listing = await listTranscripts()
const elapsed = Date.now() - started

console.log(`listed ${listing.total} transcripts in ${elapsed}ms`)
console.log(`truncated by count: ${listing.truncatedByCount}`)

const withTurns = listing.transcripts.filter((item) => item.turns > 0)
const empty = listing.transcripts.filter((item) => item.turns === 0)
console.log(`with conversation: ${withTurns.length}   no turns: ${empty.length}`)
console.log(`oversized (metadata only): ${listing.transcripts.filter((i) => i.oversized).length}`)

const groups = groupTranscripts(listing.transcripts)
console.log(`\ngroups: ${groups.length}`)
for (const group of groups) {
  const turns = group.items.reduce((sum, item) => sum + item.turns, 0)
  console.log(`  ${String(group.items.length).padStart(4)} sessions  ${String(turns).padStart(5)} turns  ${group.cwd}`)
}

console.log('\n=== the 12 most substantial conversations (what the panel leads with) ===')
for (const item of [...withTurns].sort((a, b) => b.turns - a.turns).slice(0, 12)) {
  const when = item.endedAt ? item.endedAt.slice(0, 16).replace('T', ' ') : new Date(item.mtime).toISOString().slice(0, 16)
  console.log(`  ${String(item.turns).padStart(3)} turns  ${when}  ${(item.bytes / 1024).toFixed(0).padStart(5)}KB  ${item.title?.slice(0, 60)}`)
}

// A title that is empty or a placeholder would make the list unusable, so check what fraction are.
const placeholder = listing.transcripts.filter((item) => item.title === '(无可显示的起始提问)')
console.log(`\ntitles needing a placeholder: ${placeholder.length}`)
const noCwd = listing.transcripts.filter((item) => item.cwd === null)
console.log(`transcripts with no cwd:      ${noCwd.length}`)

// The grouping key is the cwd; a null key would collapse unrelated sessions into one group.
if (noCwd.length > 0) {
  console.log('WARNING: some transcripts have no cwd, so grouping is imprecise for them')
}

// Search must be usable against real Chinese and English prompts.
for (const query of ['claude', '桌面', 'say hi']) {
  const hit = await listTranscripts({ query })
  console.log(`search "${query}" -> ${hit.matched} matches`)
}

console.log(`\ntotal elapsed: ${Date.now() - started}ms`)
