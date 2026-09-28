/**
 * Move the shared `st__*` typography rules out of SettingsPanel's scoped block into styles.css.
 *
 * Vue's `scoped` CSS does not apply to a child component's descendants, so rules that live only in
 * SettingsPanel's block are invisible to AuditPanel / BundledPanel / ImportPanel — which use the
 * same `st__*` vocabulary. Measured before the move: `.st__h` rendered at the browser default
 * 16.38px and `.st__sub` / `.st__label` as undifferentiated 14px body text inside those panels.
 *
 * These five are shared primitives, so the global sheet is their correct home; SettingsPanel keeps
 * its own modal shell (`st`, `st__scrim`, `st__panel`, `st__rail` …) scoped, because nothing else
 * uses it.
 *
 * Run: node _probe/move-shared-styles.mjs [--apply]
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const apply = process.argv.includes('--apply')
const here = dirname(fileURLToPath(import.meta.url))
const webSrc = join(here, '..', 'packages', 'web', 'src')
const panelPath = join(webSrc, 'components', 'SettingsPanel.vue')
const stylesPath = join(webSrc, 'styles.css')

/** Extract a top-level rule block by exact selector, brace-matched. */
function extractRule(css, selector) {
  const start = css.indexOf(`\n${selector} {`)
  if (start < 0) return null
  const open = css.indexOf('{', start)
  let depth = 0
  for (let i = open; i < css.length; i++) {
    if (css[i] === '{') depth++
    else if (css[i] === '}') {
      depth--
      if (depth === 0) return { text: css.slice(start + 1, i + 1), from: start + 1, to: i + 1 }
    }
  }
  return null
}

const SHARED = ['.st__field', '.st__field--boxed', '.st__h', '.st__sub', '.st__label', '.st__hint']

const panel = readFileSync(panelPath, 'utf8')
const styles = readFileSync(stylesPath, 'utf8')

const moved = []
let nextPanel = panel
for (const selector of SHARED) {
  const rule = extractRule(nextPanel, selector)
  if (!rule) {
    console.log(`  skip (not found): ${selector}`)
    continue
  }
  moved.push(rule.text.trimEnd())
  // Remove the rule AND the blank line that followed it.
  const tail = nextPanel.slice(rule.to)
  const trimmedTail = tail.startsWith('\n\n') ? tail.slice(1) : tail
  nextPanel = nextPanel.slice(0, rule.from) + trimmedTail
  console.log(`  move: ${selector}`)
}

const banner = `
/* ---------------------------------------------------------------------------
 * Shared settings-panel primitives.
 *
 * These live GLOBALLY, not in SettingsPanel's scoped block, because four components share them:
 * SettingsPanel and the AuditPanel / BundledPanel / ImportPanel children. Scoped CSS does not reach
 * a child component's descendants, so while these rules were scoped the child panels silently fell
 * back to browser defaults — headings at 16.38px and body text at an undifferentiated 14px.
 * --------------------------------------------------------------------------- */
`

const withBanner = `${styles.trimEnd()}\n${banner}\n${moved.join('\n\n')}\n`

console.log('')
console.log(`rules to move: ${moved.length}`)
console.log(`styles.css: ${styles.length} -> ${withBanner.length} chars`)

if (apply) {
  writeFileSync(stylesPath, withBanner, 'utf8')
  writeFileSync(panelPath, nextPanel, 'utf8')
  console.log('applied')
} else {
  console.log('dry run — pass --apply to write')
  console.log('')
  console.log('--- preview ---')
  console.log(moved.join('\n\n'))
}
