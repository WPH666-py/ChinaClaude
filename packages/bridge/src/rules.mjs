/**
 * 规则引擎 — "when the prompt looks like this, do that".
 *
 * WHY RULES ARE STORED LOCALLY AND EVALUATED HERE, NOT IN THE CLI: a rule is a habit of the person
 * using this app ("贴密钥前提醒我一下", "改完先跑测试"), it must apply to a prompt BEFORE it is sent, and
 * the CLI has no hook for that. The bridge sees the text on its way to the process, so this is the one
 * place a rule can label a prompt, add a sentence to it, or refuse it.
 *
 * WHY `block` IS ONLY REPORTED AND NOT ENFORCED: this module knows the text and nothing else. Whether a
 * refused prompt may be sent anyway (the composer's "still send" button) or must be hard-stopped is a
 * UI decision, so a block rule comes back as a hit with `action: 'block'` and the caller decides. A
 * module that silently dropped the request would take that choice away from the only layer that has it.
 *
 * Nothing here throws: every export returns `{ ok: false, error }` with a Chinese sentence.
 */
import { existsSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createHash, randomUUID } from 'node:crypto'
import { isAbsolute, normalize } from 'node:path'
import { dataFile } from './paths.mjs'

/** The file the rule set lives in, inside the app's data root. */
const STORE_NAME = 'rules.json'

const RULE_TYPES = ['keyword', 'regex']
const ACTIONS = ['label', 'append', 'block']
const SCOPES = ['global', 'workspace']

/**
 * The rules a fresh install starts with.
 *
 * WHY SEEDS AT ALL: an empty panel teaches nothing — the user has to invent a pattern before they can
 * see what a rule does, and an empty list is indistinguishable from a broken one. These three are the
 * cases the feature exists for: a dangerous delete, a key pasted into a prompt, and "run the tests
 * before handing it over".
 *
 * Fixed literal ids rather than generated ones, so a seeded rule can be edited, disabled or deleted
 * before anything has been written to disk: the first successful save persists whatever list the user
 * ended up with, seeds included.
 *
 * ONLY the seeds carry two keywords in one value (`删除|rm -rf`). A single rule has a single `value`
 * string, and each of these two intents has two spellings in real prompts; without the separator this
 * would be five seed rules instead of three. A user-written keyword has no `|` in it, so it stays a
 * plain substring — see `matchRule`.
 */
const SEED_RULES = [
  {
    id: 'seed-danger-delete',
    name: '危险删除',
    enabled: true,
    match: { type: 'keyword', value: '删除|rm -rf', ignoreCase: true },
    scope: 'global',
    action: 'label',
    label: '涉及删除：先确认删的是什么、有没有备份',
    append: '',
    note: '删除类请求最容易一句话就执行。命中只做标注、不拦截，最终判断留给人。',
  },
  {
    id: 'seed-secret-key',
    name: '疑似硬编码密钥',
    enabled: true,
    // ignoreCase on: these prefixes are printed in upper case as often as lower in the vendors' docs,
    // and the prefix is the entire signal.
    match: { type: 'regex', value: '(sk|ghp|glpat)-[A-Za-z0-9]{16,}', ignoreCase: true },
    scope: 'global',
    action: 'label',
    label: '提示词里出现了疑似密钥：确认是否该放进会话',
    append: '',
    note: '只在本机匹配，不联网、不落盘。若确实要贴，先确认这个仓库是不是私有的。',
  },
  {
    id: 'seed-run-tests',
    name: '改完先跑测试',
    enabled: true,
    match: { type: 'keyword', value: '测试|test', ignoreCase: true },
    scope: 'global',
    action: 'append',
    label: '追加：交付前自测',
    append: '改完请自己跑一遍测试再交付',
    note: '把「自测」写成默认动作，省得每次口头强调。',
  },
]

/** Absolute path of the rule store; the data root is created on the way. */
function storeFile() {
  return dataFile(STORE_NAME)
}

/**
 * Canonical form of a workspace path, for comparing one against another.
 *
 * A trailing separator is the whole reason this exists: a session's cwd can arrive as `D:/proj/` from a
 * URL while the stored rule holds `D:\proj` from the picker, and a byte comparison would make a
 * workspace rule silently never fire. On Windows the comparison is also case-insensitive, because the
 * filesystem is.
 */
function canonicalPath(value) {
  const text = normalize(String(value ?? '').trim())
  const stripped = text.replace(/[\\/]+$/, '')
  // `D:` is not a path and `/` is the POSIX root, so the separator there is not decoration.
  if (stripped === '') return text
  if (/^[a-zA-Z]:$/.test(stripped)) return `${stripped}\\`
  return stripped
}

/**
 * Validate the workspace a scoped rule belongs to.
 *
 * Same trust boundary as the memory store: the value arrives from the page, and a relative or
 * mistyped one would produce a rule that never fires while looking perfectly healthy in the list — the
 * worst possible failure for a feature whose whole job is to act on prompts.
 */
function checkWorkspace(value) {
  if (!value) return { ok: false, error: '「仅当前工作区」的规则需要填写工作目录' }
  if (!isAbsolute(value)) return { ok: false, error: `工作目录必须是绝对路径：${value}` }
  const cwd = canonicalPath(value)
  try {
    if (!existsSync(cwd)) return { ok: false, error: `工作目录不存在：${cwd}` }
    if (!statSync(cwd).isDirectory()) return { ok: false, error: `不是目录：${cwd}` }
  } catch (error) {
    return { ok: false, error: `无法读取工作目录：${String(error?.message ?? error)}` }
  }
  return { ok: true, cwd }
}

/** A rule the UI has a control for; anything else falls back rather than dropping the row. */
function normalizeAction(value) {
  return ACTIONS.includes(value) ? value : 'label'
}

function normalizeType(value) {
  return RULE_TYPES.includes(value) ? value : 'keyword'
}

function normalizeScope(value) {
  return SCOPES.includes(value) ? value : 'global'
}

/**
 * One stored rule, repaired into the documented shape.
 *
 * `ignoreCase` is resolved to a boolean here rather than left undefined, so the file and the panel both
 * say what the rule actually does: "absent" means case-insensitive everywhere else, and a tri-state
 * checkbox that shows "off" while matching case-insensitively is a lie the user cannot see.
 *
 * An entry with no usable `id` gets one derived from its position and content. Dropping it would lose a
 * rule silently, and a fresh `randomUUID()` per read would mean the id the panel holds stops existing a
 * moment later, so 编辑 and 删除 could never address it.
 */
function normalizeRule(raw, index) {
  if (!raw || typeof raw !== 'object') return null
  const name = typeof raw.name === 'string' ? raw.name.trim() : ''
  const matchRaw = raw.match && typeof raw.match === 'object' ? raw.match : {}
  const value = typeof matchRaw.value === 'string' ? matchRaw.value.trim() : ''
  if (!name || !value) return null

  const scope = normalizeScope(raw.scope)
  const cwd = typeof raw.cwd === 'string' ? raw.cwd.trim() : ''
  const id =
    typeof raw.id === 'string' && raw.id.trim()
      ? raw.id.trim()
      : `salvaged-${createHash('sha1')
          .update(`${index}\u0000${name}\u0000${value}\u0000${scope}\u0000${cwd}`)
          .digest('hex')
          .slice(0, 12)}`

  return {
    id,
    name,
    enabled: raw.enabled !== false,
    match: { type: normalizeType(matchRaw.type), value, ignoreCase: matchRaw.ignoreCase !== false },
    // A workspace rule with no workspace is kept as-is rather than promoted to global: promoting it
    // would make it fire everywhere, which is a far bigger surprise than a row the user must fix.
    scope,
    cwd: scope === 'workspace' ? cwd : '',
    action: normalizeAction(raw.action),
    label: typeof raw.label === 'string' ? raw.label.trim() : '',
    append: typeof raw.append === 'string' ? raw.append.trim() : '',
    note: typeof raw.note === 'string' ? raw.note.trim() : '',
  }
}

/** A fresh copy of the seeds, so a caller mutating the returned list cannot edit the module constant. */
function seedRules() {
  return SEED_RULES.map((rule) => ({ ...rule, match: { ...rule.match } }))
}

/**
 * Read the rule set.
 *
 * Three outcomes, deliberately different:
 *   - no file     → first run: the seed rules, so the panel is never an empty box;
 *   - unreadable  → an empty list, NOT the seeds. The file exists, which means a rule set exists; a
 *     corrupt one must degrade to "nothing to show" rather than to defaults the user never chose and
 *     would then save over whatever is left in there;
 *   - readable    → the stored list, each entry repaired into the documented shape.
 */
function readRules() {
  const file = storeFile()
  let raw
  try {
    if (!existsSync(file)) return { file, rules: seedRules() }
    raw = readFileSync(file, 'utf8')
  } catch {
    return { file, rules: [] }
  }

  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch {
    return { file, rules: [] }
  }
  const list = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.rules) ? parsed.rules : []
  return { file, rules: list.map(normalizeRule).filter(Boolean) }
}

/**
 * Write the rule set atomically: temp file first, then rename.
 *
 * Same reason as the memory store — a truncated `rules.json` reads as "no rules", which silently turns
 * the whole engine off without saying so.
 */
function writeRules(file, rules) {
  const temp = `${file}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`
  try {
    writeFileSync(temp, `${JSON.stringify(rules, null, 2)}\n`, 'utf8')
    renameSync(temp, file)
  } catch (error) {
    try {
      rmSync(temp, { force: true })
    } catch {
      /* best effort */
    }
    return { ok: false, error: `写入失败：${String(error?.message ?? error)}` }
  }
  return { ok: true }
}

/**
 * Turn a page-supplied rule into a stored one, rejecting anything that cannot work.
 *
 * The regex is compiled HERE, at save time, so an invalid pattern is refused while the user is looking
 * at the field that caused it. `evaluateRules` compiles the same pattern again inside a try/catch and
 * skips a broken rule, because by then the only way it can be broken is a hand-edited store — and one
 * bad line in a config file must not disable every other rule.
 */
function prepareRule(raw) {
  if (!raw || typeof raw !== 'object') return { ok: false, error: '缺少规则内容' }

  const name = typeof raw.name === 'string' ? raw.name.trim() : ''
  if (!name) return { ok: false, error: '规则名称不能为空' }

  const matchRaw = raw.match && typeof raw.match === 'object' ? raw.match : {}
  const value = typeof matchRaw.value === 'string' ? matchRaw.value.trim() : ''
  if (!value) return { ok: false, error: '匹配内容不能为空' }

  const type = normalizeType(matchRaw.type)
  const ignoreCase = matchRaw.ignoreCase !== false
  if (type === 'regex') {
    try {
      new RegExp(value, ignoreCase ? 'i' : '')
    } catch (error) {
      return { ok: false, error: `正则表达式无效：${String(error?.message ?? error)}` }
    }
  }

  const scope = normalizeScope(raw.scope)
  let cwd = ''
  if (scope === 'workspace') {
    const checked = checkWorkspace(typeof raw.cwd === 'string' ? raw.cwd.trim() : '')
    if (!checked.ok) return checked
    cwd = checked.cwd
  }

  return {
    ok: true,
    rule: {
      id: typeof raw.id === 'string' && raw.id.trim() ? raw.id.trim() : randomUUID(),
      name,
      enabled: raw.enabled !== false,
      match: { type, value, ignoreCase },
      scope,
      cwd,
      action: normalizeAction(raw.action),
      label: typeof raw.label === 'string' ? raw.label.trim() : '',
      append: typeof raw.append === 'string' ? raw.append.trim() : '',
      note: typeof raw.note === 'string' ? raw.note.trim() : '',
    },
  }
}

/**
 * Does this rule match, and what did it match?
 *
 * The matched fragment is returned rather than a boolean because the panel shows it ("why did this
 * rule fire?") and a block rule's entire justification IS that fragment; re-deriving it in the UI
 * would mean running the same regex twice.
 */
function matchRule(rule, text) {
  const { type, value } = rule.match
  const caseSensitive = rule.match.ignoreCase === false

  if (type === 'regex') {
    let expression
    try {
      expression = new RegExp(value, caseSensitive ? '' : 'i')
    } catch {
      // Skipped, never thrown: see prepareRule.
      return null
    }
    const found = expression.exec(text)
    return found ? found[0] : null
  }

  /**
   * Keyword: substring, with `|` as "or".
   *
   * One rule carries one value string, and the shipped seeds each need two spellings of one intent
   * (删除 / rm -rf, 测试 / test), which is why the separator exists. A value without `|` is a plain
   * substring, so a rule written by hand behaves exactly as the field name suggests.
   */
  const haystack = caseSensitive ? text : text.toLowerCase()
  for (const alternative of value.split('|')) {
    const needle = alternative.trim()
    if (!needle) continue
    if (haystack.includes(caseSensitive ? needle : needle.toLowerCase())) return needle
  }
  return null
}

/** Is `cwd` the workspace this rule was scoped to? */
function sameWorkspace(ruleCwd, cwd) {
  if (!ruleCwd || !cwd) return false
  const left = canonicalPath(ruleCwd)
  const right = canonicalPath(cwd)
  if (!left || !right) return false
  return process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right
}

/**
 * Every rule, in display order.
 *
 * Always `ok`: "no file yet" is the seed set, not a failure, so the panel has nothing to report and
 * nothing to hide.
 *
 * @returns {{ok:true, file:string, rules:Array<object>}}
 */
export function listRules() {
  const { file, rules } = readRules()
  return { ok: true, file, rules }
}

/**
 * Insert or update one rule.
 *
 * An id that is present but unknown is inserted with that id rather than rejected: "replace in place"
 * and "insert" are the only two useful outcomes, and refusing would leave the caller holding a rule it
 * cannot store. Order is preserved — an edited rule keeps its position, because the list order is what
 * the user arranged and a row jumping to the bottom on every save looks like data loss.
 *
 * @returns {{ok:true, rules:Array<object>}|{ok:false, error:string}}
 */
export function saveRule({ rule } = {}) {
  const prepared = prepareRule(rule)
  if (!prepared.ok) return prepared

  const file = storeFile()
  const { rules } = readRules()
  const index = rules.findIndex((entry) => entry.id === prepared.rule.id)
  if (index >= 0) rules[index] = prepared.rule
  else rules.push(prepared.rule)

  const written = writeRules(file, rules)
  if (!written.ok) return written
  return { ok: true, rules }
}

/**
 * Remove one rule by id.
 *
 * An id that is not there is `ok` with the list unchanged: two windows can have this panel open, and
 * the second 删除 must not report a failure for reaching the state the user wanted. Nothing is written
 * in that case, so a no-op delete cannot be the operation that overwrites an unreadable store.
 *
 * @returns {{ok:true, rules:Array<object>}|{ok:false, error:string}}
 */
export function deleteRule({ id } = {}) {
  const target = typeof id === 'string' ? id.trim() : ''
  if (!target) return { ok: false, error: '缺少规则 id' }

  const file = storeFile()
  const { rules } = readRules()
  const kept = rules.filter((rule) => rule.id !== target)
  if (kept.length === rules.length) return { ok: true, rules }

  const written = writeRules(file, kept)
  if (!written.ok) return written
  return { ok: true, rules: kept }
}

/**
 * Which rules fire for this text?
 *
 * `cwd` is only ever COMPARED, never opened, so a workspace that no longer exists does not turn every
 * evaluation into an error: the test box has to keep answering for a project the user has since closed
 * or unplugged, and "your rule is broken" would be the wrong message. It is still required to be an
 * absolute path, so a typo cannot make a workspace rule match by accident.
 *
 * @returns {{ok:true, hits:Array<{id:string, name:string, label:string, action:string, append:string, matched:string}>}|{ok:false, error:string}}
 */
export function evaluateRules({ text, cwd } = {}) {
  if (typeof text !== 'string') return { ok: false, error: 'text 必须是字符串' }
  const workspace = typeof cwd === 'string' ? cwd.trim() : ''
  if (workspace && !isAbsolute(workspace)) {
    return { ok: false, error: `工作目录必须是绝对路径：${workspace}` }
  }

  const { rules } = readRules()
  const hits = []
  for (const rule of rules) {
    if (!rule.enabled) continue
    if (rule.scope === 'workspace' && !sameWorkspace(rule.cwd, workspace)) continue
    const matched = matchRule(rule, text)
    if (matched === null) continue
    hits.push({
      id: rule.id,
      name: rule.name,
      label: rule.label,
      action: rule.action,
      append: rule.append,
      matched,
    })
  }
  return { ok: true, hits }
}
