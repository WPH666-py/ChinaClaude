/**
 * The rule-set version of the vendored audit engine.
 *
 * Pinned here rather than read from `vendor/vet/scanner-bin/protocol.js` at runtime for two
 * reasons:
 *
 *  1. IMPORTING VENDOR CODE INTO THE BRIDGE AT MODULE LOAD WOULD MAKE THE BRIDGE'S STARTUP depend on
 *     a directory that only exists when the audit feature was staged. A missing `vendor/` would
 *     then take down every session, not just the audit panel.
 *  2. A verdict is only meaningful against a named rule set. Stating the version makes "this came
 *     back clean" attributable to `static-v26` rather than to whatever happened to be on disk.
 *
 * The cost of pinning is drift, so `test/vet.mjs` asserts this constant equals the engine's own
 * exported ENGINE_VERSION. If the vendored engine is ever re-vendored without updating this, that
 * test fails instead of the UI quietly mislabeling verdicts.
 */
export const ENGINE_VERSION = 'static-v26'
