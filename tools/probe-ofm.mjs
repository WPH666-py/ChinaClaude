/**
 * Prints the head of the standalone service files with credential-looking assignments redacted,
 * so the output can be inspected without ever echoing a token.
 *
 * Usage: node tools/probe-ofm.mjs <file> <from> <to>
 */
import fs from 'node:fs'

const [file, from = '1', to = '60'] = process.argv.slice(2)
if (!file) {
  console.error('usage: node tools/probe-ofm.mjs <file> [from] [to]')
  process.exit(2)
}
const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/)
const start = Math.max(0, Number(from) - 1)
const end = Math.min(lines.length, Number(to))
console.log(`lines=${lines.length}`)
for (let i = start; i < end; i++) {
  const redacted = lines[i].replace(
    /((?:key|token|secret|password|auth)\w*\s*[:=]\s*)(['"`][^'"`]{8,}['"`])/gi,
    '$1<redacted>'
  )
  console.log(String(i + 1).padStart(4), redacted)
}
