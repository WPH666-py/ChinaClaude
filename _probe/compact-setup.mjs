/**
 * Shrink the new-session panel so it FITS the window instead of overflowing it.
 *
 * Measured before this ran, at the real window size (1280x840 logical):
 *   panel 760x839, viewport 840, fitsWithoutScroll = false
 * So the panel was as tall as the entire window and had to be scrolled — the controls below the fold
 * (权限模式's descriptions, 开始会话) were the ones a first-run user needs most.
 *
 * Every change here is a spacing or size reduction; none removes information. The target is that the
 * whole form is visible at 1280x840 with margin to spare.
 *
 * Run: node _probe/compact-setup.mjs [--apply]
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const apply = process.argv.includes('--apply')
const here = dirname(fileURLToPath(import.meta.url))
const stylesPath = join(here, '..', 'packages', 'web', 'src', 'styles.css')

/** exact old text -> new text */
const EDITS = [
  // --- outer frame ---------------------------------------------------------
  ['.setup {\n  display: flex;\n  flex: 1;\n  align-items: center;\n  justify-content: center;\n  min-height: 0;\n  padding: 28px;',
   '.setup {\n  display: flex;\n  flex: 1;\n  align-items: center;\n  justify-content: center;\n  min-height: 0;\n  padding: 18px;'],

  ['.setup__panel {\n  display: grid;', '.setup__panel {\n  display: grid;'],
  ['  width: 100%;\n  max-width: 640px;', '  width: 100%;\n  max-width: 540px;'],
  ['  border-radius: 16px;\n  background: var(--dsw-alias-bg-layer-1);\n  box-shadow: var(--dsw-elevation-soft);',
   '  border-radius: 14px;\n  background: var(--dsw-alias-bg-layer-1);\n  box-shadow: var(--dsw-elevation-soft);'],

  ['@media (min-width: 1180px) {\n  .setup__panel {\n    grid-template-columns: minmax(0, 0.82fr) minmax(0, 1.18fr);\n    max-width: 760px;\n  }\n}',
   '@media (min-width: 1180px) {\n  .setup__panel {\n    grid-template-columns: minmax(0, 0.78fr) minmax(0, 1.22fr);\n    max-width: 620px;\n  }\n}'],

  ['  padding: 22px 24px;\n  background: var(--dsw-specific-sidebar-fill);', '  padding: 16px 18px;\n  background: var(--dsw-specific-sidebar-fill);'],
  ['.setup__form {\n  min-width: 0;\n  padding: 22px 24px 20px;\n}', '.setup__form {\n  min-width: 0;\n  padding: 16px 18px 14px;\n}'],
  ['  .setup__intro {\n    padding: 24px;', '  .setup__intro {\n    padding: 16px 18px;'],

  // --- header --------------------------------------------------------------
  ['  gap: 6px;\n  margin-bottom: 10px;\n  padding: 3px 9px;\n  border-radius: 6px;\n  background: var(--dsw-alias-state-business-tertiary);',
   '  gap: 5px;\n  margin-bottom: 6px;\n  padding: 2px 8px;\n  border-radius: 6px;\n  background: var(--dsw-alias-state-business-tertiary);'],
  ['  font-size: 11px;\n  font-weight: 600;\n}\n\n.setup__title {', '  font-size: 10.5px;\n  font-weight: 600;\n}\n\n.setup__title {'],
  ['.setup__title {\n  margin: 0 0 8px;\n  font-size: 19px;', '.setup__title {\n  margin: 0 0 6px;\n  font-size: 16px;'],
  ['.setup__sub {\n  margin: 0 0 18px;\n  color: var(--dsw-alias-label-secondary);\n  font-size: var(--dsh-content-font-size-secondary);\n  line-height: 20px;\n}',
   '.setup__sub {\n  margin: 0 0 11px;\n  color: var(--dsw-alias-label-secondary);\n  font-size: 12.5px;\n  line-height: 18px;\n}'],

  // --- diagnostic block (5 rows, was the tallest non-input element) ---------
  ['  grid-template-columns: 88px minmax(0, 1fr);\n  gap: 5px 10px;\n  margin-top: 16px;\n  padding-top: 14px;\n  border-top: 0.5px solid var(--dsw-alias-border-l1);\n  font-size: 11.5px;',
   '  grid-template-columns: 70px minmax(0, 1fr);\n  gap: 3px 8px;\n  margin-top: 10px;\n  padding-top: 9px;\n  border-top: 0.5px solid var(--dsw-alias-border-l1);\n  font-size: 10.5px;'],

  // --- fields --------------------------------------------------------------
  ['.field {\n  margin-bottom: 13px;\n}', '.field {\n  margin-bottom: 9px;\n}'],
  ['.field__label {\n  display: block;\n  margin-bottom: 7px;\n  color: var(--dsw-alias-label-secondary);\n  font-size: 13px;\n  font-weight: 500;\n}',
   '.field__label {\n  display: block;\n  margin-bottom: 4px;\n  color: var(--dsw-alias-label-secondary);\n  font-size: 12.5px;\n  font-weight: 500;\n}'],
  ['  padding: 8px 11px;\n  border: 0.5px solid var(--dsw-alias-border-l2);\n  border-radius: 8px;\n  background: var(--dsw-static-neutral-bluish-900);',
   '  padding: 6px 10px;\n  border: 0.5px solid var(--dsw-alias-border-l2);\n  border-radius: 7px;\n  background: var(--dsw-static-neutral-bluish-900);'],
  ['.field__hint {\n  margin-top: 7px;\n  color: var(--dsw-alias-label-caption);\n  font-size: 12px;\n  line-height: 19px;\n}',
   '.field__hint {\n  margin-top: 4px;\n  color: var(--dsw-alias-label-caption);\n  font-size: 11.5px;\n  line-height: 16px;\n}'],

  // --- permission cards ----------------------------------------------------
  ['.permGrid {\n  display: grid;\n  grid-template-columns: 1fr 1fr;\n  gap: 8px;\n}', '.permGrid {\n  display: grid;\n  grid-template-columns: 1fr 1fr;\n  gap: 6px;\n}'],
  ['.permCard {\n  display: flex;\n  flex-direction: column;\n  gap: 4px;\n  padding: 10px 12px;', '.permCard {\n  display: flex;\n  flex-direction: column;\n  gap: 2px;\n  padding: 6px 9px;'],
  ['.permCard__label {\n  font-size: 13px;\n  font-weight: 600;\n}', '.permCard__label {\n  font-size: 12px;\n  font-weight: 600;\n}'],
  ['.permCard__desc {\n  color: var(--dsw-alias-label-caption);\n  font-size: 11.5px;\n  line-height: 1.6;\n}',
   '.permCard__desc {\n  color: var(--dsw-alias-label-caption);\n  font-size: 11px;\n  line-height: 1.4;\n}'],

  // --- misc form furniture -------------------------------------------------
  ['.recent {\n  display: flex;\n  flex-wrap: wrap;\n  align-items: center;\n  gap: 5px;\n  margin-top: 7px;\n}',
   '.recent {\n  display: flex;\n  flex-wrap: wrap;\n  align-items: center;\n  gap: 5px;\n  margin-top: 4px;\n}'],
  ['  padding: 3px 9px;\n  border: 0.5px solid var(--dsw-alias-border-l1);\n  border-radius: 999px;', '  padding: 2px 7px;\n  border: 0.5px solid var(--dsw-alias-border-l1);\n  border-radius: 999px;'],
  ['  color: var(--dsw-alias-label-secondary);\n  font-size: 11.5px;\n}\n\n.recent__item:hover {', '  color: var(--dsw-alias-label-secondary);\n  font-size: 11px;\n}\n\n.recent__item:hover {'],
  ['  width: 100%;\n  height: 38px;\n  margin-top: 4px;\n  border-radius: 12px;', '  width: 100%;\n  height: 32px;\n  margin-top: 2px;\n  border-radius: 10px;'],
  ['.banner {\n  display: flex;\n  align-items: flex-start;\n  gap: 8px;\n  margin-bottom: 12px;\n  padding: 9px 11px;\n  border-radius: 8px;\n  font-size: 12.5px;\n  line-height: 18px;\n}',
   '.banner {\n  display: flex;\n  align-items: flex-start;\n  gap: 8px;\n  margin-bottom: 8px;\n  padding: 7px 9px;\n  border-radius: 8px;\n  font-size: 12px;\n  line-height: 16px;\n}'],
  ['.setup__cancel {\n  position: absolute;\n  top: 14px;\n  right: 14px;\n  z-index: 1;\n  display: inline-flex;\n  align-items: center;\n  gap: 6px;\n  padding: 7px 14px;',
   '.setup__cancel {\n  position: absolute;\n  top: 11px;\n  right: 11px;\n  z-index: 1;\n  display: inline-flex;\n  align-items: center;\n  gap: 5px;\n  padding: 5px 11px;'],
]

let css = readFileSync(stylesPath, 'utf8')
let applied = 0
let missed = []

for (const [from, to] of EDITS) {
  if (from === to) continue
  const count = css.split(from).length - 1
  if (count === 0) {
    missed.push(from.split('\n')[0])
    continue
  }
  css = css.split(from).join(to)
  applied++
}

console.log(`applied ${applied}/${EDITS.length - 1} edits`)
if (missed.length > 0) {
  console.log('NOT FOUND (selector may have changed):')
  for (const item of missed) console.log('  ' + item)
}

if (apply) {
  writeFileSync(stylesPath, css, 'utf8')
  console.log('written')
} else {
  console.log('dry run — pass --apply to write')
}
