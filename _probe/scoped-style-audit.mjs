/**
 * List the `st__*` classes the child settings panels use, and whether the rules for them live in
 * SettingsPanel's SCOPED style block.
 *
 * Why this exists: Vue's `scoped` CSS does not reach a child component's descendants, so any `st__*`
 * class defined only in SettingsPanel's scoped block renders UNSTYLED inside AuditPanel /
 * BundledPanel / ImportPanel. Measured symptom: `.st__h` came out at the browser's default 16.38px
 * and `.st__sub` / `.st__label` as undifferentiated 14px body text, which is exactly the "text
 * looks cramped/wrong on other pages" report.
 *
 * Run: node _probe/scoped-style-audit.mjs
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const components = join(here, '..', 'packages', 'web', 'src', 'components')

const read = (name) => readFileSync(join(components, name), 'utf8')

/** Every selector defined in a component's <style scoped> block. */
function scopedSelectors(source) {
  const start = source.indexOf('<style scoped>')
  if (start < 0) return []
  const style = source.slice(start)
  return [...style.matchAll(/^([^{}\n]+?)\s*\{/gm)]
    .map((match) => match[1].trim())
    .filter((selector) => selector.length > 0)
}

/**
 * Class names used in a component's template, including single-quoted names inside `:class` objects.
 * Scanning the raw source rather than parsing the template is deliberate: it over-collects slightly,
 * which is the safe direction for "is this class styled anywhere".
 */
function usedClasses(source) {
  const names = new Set()
  for (const match of source.matchAll(/class="([^"]*)"/g)) {
    for (const token of match[1].split(/\s+/)) if (token) names.add(token)
  }
  for (const match of source.matchAll(/'([A-Za-z][\w-]*(?:__|--)[\w-]+)'/g)) names.add(match[1])
  return names
}

const settings = read('SettingsPanel.vue')
const settingsScoped = new Set(scopedSelectors(settings))

// Which of those selectors are actually emitted with a scope attribute, i.e. could ever match a
// SettingsPanel element. Everything else is a promise the child components cannot keep.
const globalCss = readFileSync(join(here, '..', 'packages', 'web', 'src', 'styles.css'), 'utf8')
const globalSelectors = new Set(
  [...globalCss.matchAll(/^([^{}\n]+?)\s*\{/gm)].map((m) => m[1].trim()),
)

const children = ['AuditPanel.vue', 'BundledPanel.vue', 'ImportPanel.vue']
const needed = new Set()
for (const name of children) {
  for (const cls of usedClasses(read(name))) {
    if (cls.startsWith('st__')) needed.add(cls)
  }
}

console.log('class                     scoped-in-SettingsPanel  global  verdict')
const missing = []
for (const cls of [...needed].sort()) {
  const inScoped = [...settingsScoped].some((selector) => selector.includes(`.${cls}`))
  const inGlobal = [...globalSelectors].some((selector) => selector.includes(`.${cls}`))
  const ok = inGlobal || !inScoped
  if (inScoped && !inGlobal) missing.push(cls)
  console.log(
    `${('.' + cls).padEnd(24)} ${(inScoped ? 'yes' : 'no').padEnd(24)} ${(inGlobal ? 'yes' : 'no').padEnd(7)} ${
      inScoped && !inGlobal ? 'UNSTYLED IN CHILDREN' : 'ok'
    }`,
  )
}

console.log('')
if (missing.length === 0) {
  console.log('no class is defined only in the scoped block')
} else {
  console.log(`${missing.length} class(es) are styled ONLY inside SettingsPanel's scoped block,`)
  console.log('so they render with browser defaults inside the child panels:')
  for (const cls of missing) console.log('  .' + cls)
}
