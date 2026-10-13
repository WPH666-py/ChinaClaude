/**
 * 安全防护 — the rules that stop a live secret and a destructive command from travelling further.
 *
 * WHY THIS SCANS TEXT RATHER THAN FILES: this app's riskiest moment is not what is on disk, it is what
 * crosses a boundary — a tool result carrying an API key back into the transcript, or an outgoing
 * message telling a shell to wipe a drive. Both are strings inside this process, so both are decidable
 * here, before they reach a model or a terminal.
 *
 * THE ONE INVARIANT THIS MODULE EXISTS TO KEEP: the log must never contain the secret that tripped the
 * rule. A defence feature that writes `sk-live-…` into a plaintext file beside the app has MOVED the
 * leak, not stopped it — the user would then have a key on disk that they never chose to save. So every
 * excerpt is assembled from redacted pieces, and the surrounding context is re-scanned as well, because
 * the line that holds one key very often holds the next one too.
 *
 * Nothing here blocks a session by itself: `guard` reports `blocked` and the caller decides. A rule
 * engine that silently kills a turn is indistinguishable from a bug.
 */
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { dataSubDir } from './paths.mjs'

/** The three detector families, in display order. Stable order keeps UI bars from reordering. */
const FAMILIES = ['secret', 'danger', 'exfil']

/**
 * The rule table.
 *
 * `severity` is a claim about the MATCH, not about the family: a bare `sk-…` found in a tool result is
 * evidence that a key is exposed (`warn`) but it is not, on its own, an act of destruction; a private
 * key block or `rm -rf /` is (`block`). Reporting everything as "dangerous" is how a security panel
 * trains its user to ignore it.
 *
 * EVERY PATTERN CARRIES /g, and that is not a style preference: without it `RegExp.exec` ignores
 * `lastIndex` and returns the same first match forever, which turned a single `rm -rf /` into twenty
 * identical log rows the first time this ran. `loose` is a deliberately more permissive variant used
 * ONLY on excerpt context — see `redactSecretsIn`.
 *
 * `isolate` suppresses the surrounding context. It exists for exactly one shape of match, and the reason
 * is not cosmetic: the base64 body of a private key sits on the lines AFTER the
 * `-----BEGIN … PRIVATE KEY-----` marker, so "60 characters of context" would copy the key itself into
 * the log — the precise failure this module is written to prevent.
 */
const RULES = [
  {
    id: 'secret.openai',
    name: '大模型 API 密钥（sk-）',
    family: 'secret',
    severity: 'warn',
    pattern: /\bsk-[A-Za-z0-9_-]{16,}/g,
    loose: /\bsk-[A-Za-z0-9_-]{4,}/g,
  },
  {
    id: 'secret.github',
    name: 'GitHub 令牌',
    family: 'secret',
    severity: 'warn',
    pattern: /\b(?:ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g,
    loose: /\b(?:ghp_|github_pat_)[A-Za-z0-9_]{4,}/g,
  },
  {
    id: 'secret.gitlab',
    name: 'GitLab 令牌',
    family: 'secret',
    severity: 'warn',
    pattern: /\bglpat-[A-Za-z0-9_-]{16,}\b/g,
    loose: /\bglpat-[A-Za-z0-9_-]{4,}/g,
  },
  {
    id: 'secret.aws',
    name: 'AWS Access Key ID',
    family: 'secret',
    severity: 'warn',
    pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g,
    loose: /\b(?:AKIA|ASIA)[0-9A-Z]{4,}/g,
  },
  {
    id: 'secret.google',
    name: 'Google API 密钥（AIza）',
    family: 'secret',
    severity: 'warn',
    pattern: /\bAIza[0-9A-Za-z_-]{30,}\b/g,
    loose: /\bAIza[0-9A-Za-z_-]{4,}/g,
  },
  {
    id: 'secret.slack',
    name: 'Slack 令牌（xox）',
    family: 'secret',
    severity: 'warn',
    pattern: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g,
    loose: /\bxox[baprs]-[A-Za-z0-9-]{4,}/g,
  },
  {
    id: 'secret.privatekey',
    name: '私钥文件内容',
    family: 'secret',
    severity: 'block',
    // `[A-Z ]*` covers RSA / EC / OPENSSH / PGP … PRIVATE KEY BLOCK without pinning a list that goes
    // stale the next time OpenSSH renames a format.
    pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/g,
    isolate: true,
  },
  {
    id: 'secret.assignment',
    name: '疑似口令赋值',
    family: 'secret',
    severity: 'warn',
    // A quoted value of 12+ characters: short enough to catch real passwords, long enough that
    // `password: ""` and `token: null` do not spam the log. The quotes are required on purpose — an
    // unquoted `token=abc` is as likely to be a variable name as a credential.
    pattern: /\b(?:password|passwd|secret|token|api[_-]?key)\b\s*[:=]\s*["'][^"'\n]{12,}["']/gi,
    loose: /\b(?:password|passwd|secret|token|api[_-]?key)\b\s*[:=]\s*["'][^"'\n]{4,}["']/gi,
  },

  {
    id: 'danger.rm-rf',
    name: '递归删除根目录',
    family: 'danger',
    severity: 'block',
    // The target must BE the root/home, not merely start with a slash: `rm -rf /tmp/build` is ordinary
    // work, and flagging it would make this rule indistinguishable from noise.
    pattern: /\brm\s+-\w*(?:rf|fr)\w*\s+(?:--no-preserve-root\s+)?(?:\/|~|\$HOME)(?![\w-])/gi,
  },
  {
    id: 'danger.format',
    name: '格式化磁盘',
    family: 'danger',
    severity: 'block',
    pattern: /\bformat\s+[a-z]:/gi,
  },
  {
    id: 'danger.del-force',
    name: '强制删除整个盘符',
    family: 'danger',
    severity: 'block',
    pattern: /\bdel\s+(?:\/[a-z]\s*)+[a-z]:\\/gi,
  },
  {
    id: 'danger.remove-item',
    name: 'PowerShell 递归强删',
    family: 'danger',
    severity: 'block',
    // Both switches are required and may appear in any order, which is why they are lookaheads rather
    // than a literal `-Recurse -Force` substring.
    pattern: /Remove-Item\b(?=[^\n]*-Recurse)(?=[^\n]*-Force)[^\n]*\b[a-z]:[\\/]/gi,
  },
  {
    id: 'danger.dd',
    name: '直接写裸设备',
    family: 'danger',
    severity: 'block',
    pattern: /\bdd\s+[^\n]*\bof=\/dev\/(?:sd|hd|nvme|disk|mmcblk)/gi,
  },
  {
    id: 'danger.mkfs',
    name: '创建文件系统（会清空分区）',
    family: 'danger',
    severity: 'block',
    pattern: /\bmkfs(?:\.[a-z0-9]+)?\b/gi,
  },
  {
    id: 'danger.shutdown',
    name: '关机 / 重启',
    family: 'danger',
    severity: 'block',
    pattern: /\bshutdown\s+(?:\/[rsp]\b|-h\b)/gi,
  },
  {
    id: 'danger.forkbomb',
    name: 'Shell 叉炸弹',
    family: 'danger',
    severity: 'block',
    pattern: /:\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/g,
  },
  {
    id: 'danger.force-push',
    name: '强推受保护分支',
    family: 'danger',
    severity: 'block',
    /**
     * `--force-with-lease` is excluded by `(?![\w-])` after `force`, and it must be: the flag refuses
     * the push when the remote moved, so it is the guard rail rather than the hazard, and blocking it
     * would push users back to the unguarded `--force`.
     */
    pattern: /\bgit\s+push\b(?=[^\n]*\s(?:--force(?![\w-])|-f\b))(?=[^\n]*\b(?:main|master|release|prod))/gi,
  },

  {
    id: 'exfil.curl-upload',
    name: '上传文件到远端',
    family: 'exfil',
    severity: 'warn',
    pattern: /\bcurl\b[^\n]*(?:-X\s*POST|--request\s+POST)[^\n]*(?:-d|--data(?:-binary|-raw)?)\s*@/gi,
  },
  {
    id: 'exfil.curl-pipe-shell',
    name: '下载内容直接交给 Shell',
    family: 'exfil',
    severity: 'block',
    // Remote code execution with no review step: whatever the URL serves today becomes what runs here.
    pattern: /\bcurl\b[^\n|]*\|\s*(?:sudo\s+)?(?:ba|z|d|k|fi)?sh\b/gi,
  },
  {
    id: 'exfil.powershell-iex',
    name: 'PowerShell 下载后直接执行',
    family: 'exfil',
    severity: 'block',
    pattern: /\b(?:iwr|irm|Invoke-WebRequest|Invoke-RestMethod)\b[^\n|]*\|\s*(?:Invoke-Expression|iex)\b/gi,
  },
  {
    id: 'exfil.paste-host',
    name: '提到了中转 / 粘贴服务',
    family: 'exfil',
    severity: 'info',
    // `info`, not `block`: naming pastebin.com is evidence of intent, not of a transfer. A hostname alone
    // cannot tell "I uploaded the logs" from "here is where you can paste the error".
    pattern: /\b(?:pastebin\.com|transfer\.sh|ngrok\.io|ngrok-free\.app|ngrok\.app|0x0\.st|termbin\.com)\b/gi,
  },
]

/** Family labels, so a log line is readable without a second lookup table in the UI. */
const FAMILY_LABEL = { secret: '密钥泄露', danger: '危险命令', exfil: '数据外传' }

/** Ring size for `<DATA_ROOT>/defend/log.jsonl`. */
const LOG_CAP = 200
/** Target characters of context kept on each side of a match. */
const CONTEXT_CHARS = 60
/** Hard ceiling while walking a context edge out to a whitespace boundary. */
const CONTEXT_SNAP_MAX = 96
/** Backstop on the assembled excerpt; the context budget above already bounds it. */
const EXCERPT_CAP = 200
/** Per-rule and overall ceilings: a pasted 1 MB file must not produce a 10k-row log. */
const MAX_HITS_PER_RULE = 20
const MAX_HITS = 60

let seq = 0

function nextId() {
  seq += 1
  return `h${Date.now().toString(36)}${seq.toString(36)}`
}

/**
 * The redacted form of one matched span.
 *
 * The prefix is kept only when it cannot BE the secret: a 12+ character match contributes its first four
 * (`sk-p`, `AKIA`, `ghp_`) which is what lets a user recognise WHICH key leaked, while anything shorter
 * contributes nothing at all — four characters of a five-character secret is most of a secret. The
 * hidden count is reported because "已隐去 47 字符" is checkable evidence that the whole match was
 * removed rather than trimmed down to something still usable.
 */
function redactSpan(match) {
  const secret = String(match ?? '')
  const keep = secret.length >= 12 ? 4 : 0
  return `${secret.slice(0, keep)}…（已隐去 ${secret.length - keep} 字符）`
}

/** A fresh RegExp per scan: sharing one global regex leaks `lastIndex` between calls. */
function rulePattern(rule) {
  return new RegExp(rule.pattern.source, rule.pattern.flags)
}

/** Anything this long and this unbroken is key material, a hash or a JWT segment — not prose. */
const LONG_RUN = /[A-Za-z0-9+/=_-]{24,}/g
/** Whatever the detector would call a credential value, the context around it must not reveal. */
const QUOTED_RUN = /"[^"\n]{12,}"|'[^'\n]{12,}'/g
const PRIVATE_KEY_POISON = '…（已隐去私钥内容）'

/**
 * The ranges of `text` that hold private-key material: the marker through its body.
 *
 * This exists because `isolate` protects a private-key HIT's own excerpt but nothing else: a hit whose
 * rule matched the line ABOVE the marker has a context window that reaches straight into the base64 body,
 * which is how the key ended up in the log during the first smoke run. A window can also start INSIDE the
 * body, so the span has to be computed for the whole text and intersected with each fragment.
 *
 * The END line bounds the search when it exists; without one (a key pasted from a terminal that lost the
 * footer) the following base64-only lines are taken one by one, so a fragment that merely LOOKS base64
 * further down the document is not swallowed.
 */
function privateKeySpans(text) {
  const spans = []
  const marker = /-----BEGIN [A-Z ]*PRIVATE KEY-----/g
  let match
  while ((match = marker.exec(text)) !== null) {
    let cursor = match.index + match[0].length
    const endMarker = text.indexOf('-----END', cursor)
    if (endMarker !== -1 && endMarker - cursor < 20000) {
      const lineEnd = text.indexOf('\n', endMarker)
      cursor = lineEnd === -1 ? text.length : lineEnd
    } else {
      while (cursor < text.length) {
        const lineEnd = text.indexOf('\n', cursor)
        const line = (lineEnd === -1 ? text.slice(cursor) : text.slice(cursor, lineEnd)).trim()
        if (!/^[A-Za-z0-9+/=]{20,}$/.test(line)) break
        cursor = lineEnd === -1 ? text.length : lineEnd
      }
    }
    spans.push([match.index, cursor])
    if (match.index === marker.lastIndex) marker.lastIndex += 1
  }
  return spans
}

/** Replace the part of a fragment that overlaps a poisoned span. */
function poisonFragment(fragment, from, spans) {
  let out = ''
  let cursor = 0
  for (const [start, end] of spans) {
    const localStart = Math.max(start - from, 0)
    const localEnd = Math.min(end - from, fragment.length)
    if (localEnd <= localStart || localStart >= fragment.length || localEnd <= cursor) continue
    out += fragment.slice(cursor, localStart) + PRIVATE_KEY_POISON
    cursor = localEnd
  }
  return out + fragment.slice(cursor)
}

/**
 * Redact every secret-shaped run inside a fragment of CONTEXT.
 *
 * Four defences, each answering a failure that was actually observed in a smoke run:
 *
 *   1. Poisoned private-key spans, first, because they can cover the whole fragment.
 *   2. The strict rules, so a second complete key in the same window is removed.
 *   3. The `loose` variants. A 60-character window cut a neighbouring GitHub token down to
 *      `ghp_ABCDEFGHIJKLMN`, which no strict rule matches (they require the full length) — a PARTIAL
 *      token is still token material, so the rescan is deliberately more permissive than the detector.
 *   4. Quoted runs and long unbroken runs, for the case no rule can see: when the window starts INSIDE a
 *      value, the detector's own keyword (`token = `, `sk-proj-`) is outside it, so the leftover looks
 *      like ordinary text — yet `ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789abcdef` is the whole secret minus its
 *      prefix. A false positive here costs a few redacted characters; a false negative costs a key.
 *
 * The replacement is a FUNCTION, not a string: `$&`/`$1` in a replacement string are substituted by
 * `String.replace`, and a secret that happened to contain `$&` would come back.
 *
 * Only the secret family is applied — a dangerous command quoted in context is the evidence a reader
 * needs, not a leak.
 */
function redactContext(fragment, from, spans) {
  let out = poisonFragment(String(fragment ?? ''), from, spans)
  for (const rule of RULES) {
    if (rule.family !== 'secret') continue
    out = out.replace(rulePattern(rule), (match) => redactSpan(match))
  }
  for (const rule of RULES) {
    if (rule.family !== 'secret' || !rule.loose) continue
    out = out.replace(rulePattern({ pattern: rule.loose }), (match) => redactSpan(match))
  }
  return out.replace(QUOTED_RUN, (match) => redactSpan(match)).replace(LONG_RUN, (match) => redactSpan(match))
}

/**
 * Walk a context edge out to the nearest whitespace, within a hard limit.
 *
 * Cutting at exactly 60 characters can slice a token in half, and a half token is invisible to the
 * detector — the loose pass above is the second half of this defence. Snapping first means the common
 * case keeps whole tokens, which the strict rules can then recognise.
 */
function contextEdges(text, index, length) {
  let start = Math.max(0, index - CONTEXT_CHARS)
  while (start > 0 && start > index - CONTEXT_SNAP_MAX && !/\s/.test(text[start - 1])) start -= 1
  let end = Math.min(text.length, index + length + CONTEXT_CHARS)
  while (end < text.length && end < index + length + CONTEXT_SNAP_MAX && !/\s/.test(text[end])) end += 1
  return { start, end }
}

/**
 * Build the stored excerpt: up to ~60 characters of context on each side, with the match replaced and
 * the context re-scanned.
 *
 * `spans` is the private-key poison map for the whole text, computed once per scan rather than per hit:
 * a hit in a 1 MB file must not re-walk the document to find out whether its neighbour is a key.
 */
function buildExcerpt(text, index, length, rule, spans) {
  const primary = redactSpan(text.slice(index, index + length))
  if (rule.isolate) return primary

  const edges = contextEdges(text, index, length)
  const before = redactContext(text.slice(edges.start, index), edges.start, spans)
  const after = redactContext(text.slice(index + length, edges.end), index + length, spans)
  // Whitespace is collapsed so one hit stays one log line: the JSONL file is parsed line by line, and a
  // pasted multi-line file would otherwise turn a single hit into dozens of unparseable records.
  const excerpt = `${index > CONTEXT_CHARS ? '…' : ''}${before}${primary}${after}`
    .replace(/\s+/g, ' ')
    .trim()
  return excerpt.length > EXCERPT_CAP ? `${excerpt.slice(0, EXCERPT_CAP)}…` : excerpt
}

/**
 * Scan text against every rule.
 *
 * Pure: nothing is logged and no counter moves, so the UI's 自测 box can show a user exactly what the
 * rules see without polluting the record of what actually happened in their session.
 */
export function scanText({ text, where } = {}) {
  try {
    const body = typeof text === 'string' ? text : String(text ?? '')
    const origin = String(where ?? '').trim() || 'unknown'
    if (body === '') return { ok: true, hits: [], truncated: false }

    const at = new Date().toISOString()
    /** Computed once, not per hit: see buildExcerpt. */
    const spans = privateKeySpans(body)
    /** Sorted by position afterwards, so a hit carries no index the caller could not use. */
    const found = []
    let truncated = false

    for (const rule of RULES) {
      const pattern = rulePattern(rule)
      let match
      let perRule = 0
      let previousEnd = -1
      while ((match = pattern.exec(body)) !== null) {
        /**
         * Progress guard. A zero-width match would otherwise spin forever, and a rule that lost its /g
         * flag would report its first hit until the per-rule cap — one duplicate is a bug report,
         * twenty identical log rows look like twenty events.
         */
        if (match.index < previousEnd) break
        previousEnd = match.index + match[0].length

        found.push({
          index: match.index,
          hit: {
            id: nextId(),
            at,
            rule: rule.id,
            // The Chinese name travels with the hit: the UI must render 中文, and a second mapping table
            // in the page would drift from this one the first time a rule is renamed.
            ruleName: rule.name,
            family: rule.family,
            familyLabel: FAMILY_LABEL[rule.family] ?? rule.family,
            severity: rule.severity,
            where: origin,
            excerpt: buildExcerpt(body, match.index, match[0].length, rule, spans),
          },
        })
        perRule += 1
        if (match.index === pattern.lastIndex) pattern.lastIndex += 1
        if (perRule >= MAX_HITS_PER_RULE) {
          truncated = true
          break
        }
      }
      if (found.length >= MAX_HITS) {
        truncated = true
        break
      }
    }

    const hits = found
      .sort((a, b) => a.index - b.index)
      .slice(0, MAX_HITS)
      .map((entry) => entry.hit)
    return { ok: true, hits, truncated }
  } catch (error) {
    return { ok: false, error: String(error?.message ?? error), hits: [], truncated: false }
  }
}

/** `<DATA_ROOT>/defend`, created on first use — never at import time. */
function defendPaths() {
  const dir = dataSubDir('defend')
  return { dir, log: join(dir, 'log.jsonl'), countersFile: join(dir, 'stats.json') }
}

function blankCounters(since = new Date().toISOString()) {
  const families = {}
  for (const family of FAMILIES) families[family] = 0
  return { scans: 0, hits: 0, blocked: 0, since, families }
}

function toCount(value) {
  const number = Number(value)
  return Number.isFinite(number) && number >= 0 ? Math.floor(number) : 0
}

/** Read `stats.json`, tolerating every failure: a corrupt counter must not disable the feature. */
function readCounters(file) {
  try {
    if (!existsSync(file)) return null
    const parsed = JSON.parse(readFileSync(file, 'utf8'))
    const counters = blankCounters(typeof parsed?.since === 'string' ? parsed.since : undefined)
    counters.scans = toCount(parsed?.scans)
    counters.hits = toCount(parsed?.hits)
    counters.blocked = toCount(parsed?.blocked)
    for (const family of FAMILIES) counters.families[family] = toCount(parsed?.families?.[family])
    return counters
  } catch {
    return null
  }
}

/** Read the ring, dropping lines a crash left half-written. */
function readLog(file) {
  try {
    if (!existsSync(file)) return []
    return readFileSync(file, 'utf8')
      .split('\n')
      .filter((line) => line.trim() !== '')
      .map((line) => {
        try {
          const entry = JSON.parse(line)
          return entry && typeof entry === 'object' ? entry : null
        } catch {
          return null
        }
      })
      .filter(Boolean)
      .slice(-LOG_CAP)
  } catch {
    return []
  }
}

let store = null

/**
 * The counters and the ring, loaded from disk once per process.
 *
 * `since` is the moment counting began — the first run, or the last 清空 — and it is persisted rather
 * than derived, because a 统计起点 that resets on every launch makes the ratio of scans to hits
 * meaningless.
 */
function load() {
  if (store) return store
  const paths = defendPaths()
  const counters = readCounters(paths.countersFile)
  const recent = readLog(paths.log)
  if (counters) {
    store = { ...paths, counters, recent }
    return store
  }
  /**
   * No counters file, but possibly a log ring left by an older build: start the window at the oldest
   * surviving hit so the numbers on screen describe the rows on screen, instead of claiming the session
   * began after hits that are still listed.
   */
  const since = recent[0]?.at ?? new Date().toISOString()
  store = { ...paths, counters: blankCounters(since), recent }
  return store
}

/**
 * Persist counters through a temporary file and a rename.
 *
 * A direct overwrite that is interrupted leaves a truncated JSON file, and `readCounters` then falls back
 * to zeros — the user's whole protection history silently reset by a crash at the wrong millisecond. A
 * rename is atomic on the same volume, so the file is either the old one or the new one. The name carries
 * the pid because a dev bridge and the app can run side by side.
 */
function persistCounters(state) {
  const temp = `${state.countersFile}.${process.pid}.tmp`
  try {
    writeFileSync(temp, `${JSON.stringify(state.counters)}\n`, 'utf8')
    renameSync(temp, state.countersFile)
    return true
  } catch {
    // Best effort: a read-only or full disk must not take a scan down, and memory stays correct.
    return false
  }
}

/**
 * Rewrite the ring in full rather than append-and-trim.
 *
 * The file is at most 200 lines, so a full rewrite costs one small write and removes the class of bug
 * where a truncated append leaves the ring one entry over its cap forever. Callers only reach this when
 * there is something to add.
 */
function persistLog(state) {
  try {
    writeFileSync(state.log, state.recent.map((entry) => `${JSON.stringify(entry)}\n`).join(''), 'utf8')
    return true
  } catch {
    return false
  }
}

/**
 * Scan, record, and report whether a `block` rule fired.
 *
 * The counters move for EVERY call, including a clean one: "扫描 412 次，命中 3 次" is the number that
 * tells a user whether the protection is actually running, and a scan that leaves no trace of itself
 * cannot support that claim.
 */
export function guard({ text, where, action } = {}) {
  try {
    /**
     * `action` names the decision point ('send' / 'tool-result'). It becomes the `where` fallback so a log
     * line recorded by a caller that forgot to pass one is still attributable to a step.
     */
    const origin = String(where ?? '').trim() || String(action ?? '').trim() || 'unknown'
    const scan = scanText({ text, where: origin })
    const hits = scan.hits

    const state = load()
    const counters = state.counters
    counters.scans += 1
    counters.hits += hits.length
    const blocked = hits.some((hit) => hit.severity === 'block')
    if (blocked) counters.blocked += 1
    for (const hit of hits) {
      counters.families[hit.family] = toCount(counters.families[hit.family]) + 1
    }

    persistCounters(state)
    if (hits.length > 0) {
      state.recent = [...state.recent, ...hits].slice(-LOG_CAP)
      persistLog(state)
    }

    return { ok: true, hits, blocked, truncated: scan.truncated === true }
  } catch (error) {
    return { ok: false, error: String(error?.message ?? error), hits: [], blocked: false }
  }
}

/** Counters, per-family totals, and the recent hits (newest first), for the 安全防护 window. */
export function defendStats() {
  try {
    const state = load()
    return {
      ok: true,
      stats: {
        scans: state.counters.scans,
        hits: state.counters.hits,
        blocked: state.counters.blocked,
        since: state.counters.since,
      },
      /**
       * Every family is listed even at zero: a bar chart that drops empty rows makes "no key has ever
       * leaked" look identical to "the key detector is missing".
       */
      byFamily: FAMILIES.map((family) => ({
        family,
        label: FAMILY_LABEL[family],
        hits: toCount(state.counters.families[family]),
      })),
      recent: [...state.recent].reverse(),
      file: state.log,
      countersFile: state.countersFile,
    }
  } catch (error) {
    return {
      ok: false,
      error: String(error?.message ?? error),
      stats: { scans: 0, hits: 0, blocked: 0, since: new Date().toISOString() },
      byFamily: FAMILIES.map((family) => ({ family, label: FAMILY_LABEL[family], hits: 0 })),
      recent: [],
    }
  }
}

/**
 * Forget everything: ring and counters both.
 *
 * One button, one meaning. Clearing the rows while leaving 命中 313 on screen would read as a bug, and a
 * user who asked for the record to be gone should not have to wonder which half went.
 */
export function clearDefend() {
  try {
    const state = load()
    state.counters = blankCounters()
    state.recent = []
    const persisted = persistCounters(state) && persistLog(state)
    return persisted
      ? { ok: true }
      : { ok: true, persisted: false, error: '记录已清空，但磁盘写入失败（重启后可能仍读到旧文件）' }
  } catch (error) {
    return { ok: false, error: String(error?.message ?? error) }
  }
}
