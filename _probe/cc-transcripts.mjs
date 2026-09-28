/**
 * Survey Claude Code's on-disk transcript format.
 *
 * The import panel has to list pre-existing conversations, so it needs to know which record types
 * carry a session id, a working directory, the opening user prompt and a timestamp — and how often
 * each is actually present. Designing that from a single sample would be guesswork: the newest
 * files in the tree turned out to be short internal logs with no conversation at all.
 *
 * Read-only. Run: node _probe/cc-transcripts.mjs [projectsRoot]
 */
import { readdirSync, statSync, createReadStream } from 'node:fs'
import { createInterface } from 'node:readline'
import { join } from 'node:path'
import { homedir } from 'node:os'

const root = process.argv[2] ?? join(homedir(), '.claude', 'projects')

/** Every .jsonl under the projects root, with its project directory name. */
function findTranscripts(dir, depth = 0, out = []) {
  if (depth > 2) return out
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const entry of entries) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) findTranscripts(full, depth + 1, out)
    else if (entry.isFile() && entry.name.endsWith('.jsonl')) out.push({ path: full, project: dir.split(/[\\/]/).pop() })
  }
  return out
}

const files = findTranscripts(root)
console.log(`projects root: ${root}`)
console.log(`transcripts:   ${files.length}`)

const typeCounts = new Map()
const keyCounts = new Map()
const sampleByType = new Map()
let parsed = 0
let parseFailures = 0
let totalLines = 0

/** Per-file shape, so "has a conversation" can be defined from evidence. */
const perFile = []

for (const file of files) {
  const stream = createReadStream(file.path, { encoding: 'utf8' })
  const lines = createInterface({ input: stream, crlfDelay: Infinity })
  const shape = {
    path: file.path,
    project: file.project,
    lines: 0,
    typeCounts: new Map(),
    sessionIds: new Set(),
    cwds: new Set(),
    firstUserText: null,
    firstTimestamp: null,
    lastTimestamp: null,
    versions: new Set(),
    bytes: statSync(file.path).size,
  }
  for await (const line of lines) {
    if (!line.trim()) continue
    shape.lines++
    totalLines++
    let record
    try {
      record = JSON.parse(line)
      parsed++
    } catch {
      parseFailures++
      continue
    }
    const type = String(record.type ?? '(none)')
    shape.typeCounts.set(type, (shape.typeCounts.get(type) ?? 0) + 1)
    typeCounts.set(type, (typeCounts.get(type) ?? 0) + 1)
    if (!sampleByType.has(type)) sampleByType.set(type, Object.keys(record))

    for (const key of Object.keys(record)) keyCounts.set(key, (keyCounts.get(key) ?? 0) + 1)

    if (typeof record.sessionId === 'string') shape.sessionIds.add(record.sessionId)
    if (typeof record.cwd === 'string') shape.cwds.add(record.cwd)
    if (typeof record.version === 'string') shape.versions.add(record.version)
    if (typeof record.timestamp === 'string') {
      if (!shape.firstTimestamp) shape.firstTimestamp = record.timestamp
      shape.lastTimestamp = record.timestamp
    }
    if (shape.firstUserText === null && type === 'user') {
      const content = record.message?.content
      const text =
        typeof content === 'string'
          ? content
          : Array.isArray(content)
            ? content.filter((b) => b?.type === 'text').map((b) => b.text).join(' ')
            : ''
      if (text.trim()) shape.firstUserText = text.trim().slice(0, 120)
    }
  }
  perFile.push(shape)
}

console.log(`lines: ${totalLines}  parsed: ${parsed}  parse failures: ${parseFailures}`)

console.log('\n=== record types (frequency) ===')
for (const [type, count] of [...typeCounts].sort((a, b) => b[1] - a[1]).slice(0, 20)) {
  console.log(`  ${String(count).padStart(6)}  ${type}`)
}

console.log('\n=== top-level keys (frequency) ===')
for (const [key, count] of [...keyCounts].sort((a, b) => b[1] - a[1]).slice(0, 22)) {
  console.log(`  ${String(count).padStart(6)}  ${key}`)
}

console.log('\n=== keys present per record type (first sample) ===')
for (const [type, keys] of sampleByType) {
  console.log(`  ${type}: ${keys.join(', ')}`)
}

const withConversation = perFile.filter((f) => (f.typeCounts.get('user') ?? 0) + (f.typeCounts.get('assistant') ?? 0) > 0)
console.log(`\n=== usefulness for a listing ===`)
console.log(`  files with user/assistant records: ${withConversation.length}/${perFile.length}`)
console.log(`  files exposing sessionId:          ${perFile.filter((f) => f.sessionIds.size > 0).length}`)
console.log(`  files exposing cwd:                ${perFile.filter((f) => f.cwds.size > 0).length}`)
console.log(`  files exposing a first user text:  ${perFile.filter((f) => f.firstUserText).length}`)
console.log(`  files exposing a timestamp:        ${perFile.filter((f) => f.firstTimestamp).length}`)
console.log(`  files exposing a version:          ${perFile.filter((f) => f.versions.size > 0).length}`)

// Does the directory name actually encode the cwd? That decides whether a listing can show a
// workspace for files that lack a cwd field.
console.log('\n=== directory name vs cwd field ===')
let agree = 0
let disagree = 0
for (const file of perFile.filter((f) => f.cwds.size > 0).slice(0, 40)) {
  const cwd = [...file.cwds][0]
  const encoded = cwd.replace(/[^a-zA-Z0-9]/g, '-')
  if (encoded === file.project) agree++
  else {
    disagree++
    if (disagree <= 5) console.log(`  project=${file.project}  cwd=${cwd}  encoded=${encoded}`)
  }
}
console.log(`  agree: ${agree}  disagree: ${disagree}`)

console.log('\n=== largest transcripts ===')
for (const file of [...perFile].sort((a, b) => b.bytes - a.bytes).slice(0, 6)) {
  const users = file.typeCounts.get('user') ?? 0
  const assistants = file.typeCounts.get('assistant') ?? 0
  console.log(
    `  ${(file.bytes / 1024).toFixed(0).padStart(6)} KB  ${String(file.lines).padStart(5)} lines  u=${users} a=${assistants}  ${file.path.split(/[\\/]/).pop()}`,
  )
  if (file.firstUserText) console.log(`           first: ${file.firstUserText}`)
  if (file.cwds.size > 0) console.log(`           cwd:   ${[...file.cwds][0]}`)
}

console.log('\n=== one conversation-bearing sample, first 2 records ===')
const sample = withConversation.sort((a, b) => b.bytes - a.bytes)[0]
if (sample) {
  const stream = createReadStream(sample.path, { encoding: 'utf8' })
  const lines = createInterface({ input: stream, crlfDelay: Infinity })
  let shown = 0
  for await (const line of lines) {
    if (!line.trim()) continue
    console.log('  ' + line.slice(0, 600))
    if (++shown >= 2) break
  }
  stream.destroy()
}
