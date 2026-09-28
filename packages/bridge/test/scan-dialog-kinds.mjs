/**
 * Extract the code context around named dialog kinds from the CLI binary.
 *
 * WHY: `request_user_dialog`'s `dialog_kind` is an OPEN string union, so the SDK types cannot
 * enumerate it and a generic renderer has to be built from observed shapes. The binary is the
 * only place the literals exist.
 *
 * Strings in this image sit next to NUL bytes (binary tables), so the neighbourhood matcher
 * must tolerate any non-NUL byte rather than only printable ASCII — an earlier printable-only
 * scan reported 0 hits on literals that a looser scan had already found.
 *
 * Run: node packages/bridge/test/scan-dialog-kinds.mjs [--seconds 200]
 */
import { createReadStream, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const EXE = process.env.CCCN_CLAUDE_BINARY ?? 'D:\\Claudecode-CN\\_probe\\package\\claude.exe'
const OUT = join(here, 'dialog-kinds.txt')

/** Kinds worth building UI for: the ones the CLI can route to a host renderer. */
const KINDS = [
  'refusal_fallback_prompt',
  'get_sandbox_dialog',
  'get_memory_dialog',
  'get_skills_dialog',
  'elicitation_url_dialog',
  'request_user_dialog',
  'chrome_permission_prompt',
  'mcp_project_approval_dialog',
]

const secondsArg = process.argv.indexOf('--seconds')
const LIMIT_MS = (secondsArg >= 0 ? Number(process.argv[secondsArg + 1]) : 200) * 1000

const counts = Object.fromEntries(KINDS.map((k) => [k, 0]))
const samples = new Map(KINDS.map((k) => [k, []]))

const started = Date.now()
let carry = ''
const stream = createReadStream(EXE, { highWaterMark: 8 * 1024 * 1024 })

await new Promise((resolve) => {
  stream.on('data', (chunk) => {
    if (Date.now() - started > LIMIT_MS) {
      stream.destroy()
      resolve()
      return
    }
    // latin1 keeps every byte 1:1 so offsets and neighbours are accurate.
    const text = carry + chunk.toString('latin1')

    for (const kind of KINDS) {
      // Neighbourhood of up to 200 bytes on either side, stopping at NUL.
      const rx = new RegExp(`[^\\x00\\r\\n]{0,200}${kind}[^\\x00\\r\\n]{0,240}`, 'g')
      let match
      while ((match = rx.exec(text)) !== null) {
        counts[kind]++
        if (samples.get(kind).length < 6) {
          samples.get(kind).push(match[0].replace(/\s+/g, ' '))
        }
      }
    }

    carry = text.slice(-512)
  })
  stream.on('end', resolve)
  stream.on('close', resolve)
  stream.on('error', resolve)
})

const lines = []
lines.push(`binary: ${EXE}`)
lines.push(`scanned for ${((Date.now() - started) / 1000).toFixed(1)}s`)
lines.push('')
lines.push('=== hit counts ===')
for (const kind of KINDS) lines.push(`  ${kind.padEnd(30)} ${counts[kind]}`)
lines.push('')
for (const kind of KINDS) {
  const list = samples.get(kind)
  if (list.length === 0) continue
  lines.push(`=== ${kind} ===`)
  for (const sample of list) {
    lines.push('  ' + sample)
    lines.push('')
  }
}

writeFileSync(OUT, lines.join('\n'), 'utf8')
console.log(lines.slice(0, 40).join('\n'))
console.log(`\nfull report -> ${OUT}`)
