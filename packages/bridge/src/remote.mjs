/**
 * LAN access: let a phone on the same network drive this bridge.
 *
 * THE SECURITY SHAPE OF THIS FEATURE, because it is the whole design:
 *
 *   1. Requests from THIS machine (loopback) are trusted and bypass auth entirely. That is what the
 *      Tauri webview is, so the desktop keeps working with no login step. Loopback cannot be reached
 *      from another device, so trusting it adds no exposure.
 *
 *   2. Requests from anywhere else are UNTRUSTED, even on the same LAN, and must present a device
 *      token. This is not ceremony: this bridge can run tools with `bypassPermissions` on the user's
 *      machine, so a single unauthenticated request is remote code execution. A cafe/dorm/office
 *      network is exactly where an open port gets found.
 *
 *   3. LAN exposure is OFF until the user turns it on, and turning it on rebinds the socket (a
 *      listen-time property), so it takes effect on the next launch. Default-off means a user who
 *      never wants this feature never has a port open on their network.
 *
 * WHY A PAIRING CODE RATHER THAN TYPING A TOKEN: the bootstrap credential has to be typed on a phone
 * keyboard. A 6-digit code the user reads off their own screen is achievable; a 43-character token is
 * not. The code is short-lived, single-use, attempt-limited, and only issuable from loopback — a
 * phone cannot mint its own code.
 *
 * KNOWN LIMITATION, stated rather than hidden: plain HTTP on the LAN means the session cookie travels
 * in cleartext, so anyone who can sniff the local network can steal it. There is no TLS here because
 * a phone will not trust a self-signed certificate without an install step. Treat LAN access as
 * "trusted home network", and use 解除配对 to invalidate every issued cookie at once.
 */
import { createHash, randomBytes, randomInt, timingSafeEqual } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { networkInterfaces } from 'node:os'
import { dataFile } from './paths.mjs'

/** How long a pairing code stays valid. Long enough to walk to the phone, short enough to matter. */
const PAIR_TTL_MS = 5 * 60 * 1000

/** Wrong guesses before the code is burned. Stops a brute force of 6 digits from a LAN peer. */
const MAX_PAIR_ATTEMPTS = 10

/** Paired devices kept at once; beyond this the oldest is dropped. */
const MAX_SESSIONS = 5

export const SESSION_COOKIE = 'cccn_session'

/**
 * Whether an address belongs to this machine.
 *
 * Covers the IPv4-mapped form (`::ffff:127.0.0.1`) that a dual-stack socket reports, and the whole
 * 127.0.0.0/8 range rather than only `.0.0.1`, since any address in it is still local.
 */
export function isLoopback(address) {
  if (!address) return false
  const value = String(address)
  if (value === '::1') return true
  if (value.startsWith('::ffff:')) return isLoopback(value.slice(7))
  if (/^127\./.test(value)) return true
  return false
}

/**
 * Adapter names that are almost never the LAN a phone is on.
 *
 * Meaningful but NOT sufficient, and the failure is worth recording: on this machine the first
 * candidate was `192.168.56.1` — a VirtualBox host-only adapter — while the real Wi-Fi was
 * `192.168.111.73`. Its adapter name is a plain "以太网", which is indistinguishable from a physical
 * NIC, so no name rule can catch it. The guess below is therefore only a DEFAULT; the UI lists every
 * address with its adapter name so the user can pick the one their phone is actually on.
 */
const VIRTUAL_ADAPTER = /virtual|vmware|hyper-?v|vethernet|loopback|docker|tailscale|zerotier|npcap|^tap|^tun|bluetooth|hamachi|radmin|wsl/i

/**
 * Adapters a phone is plausibly on. Used only to ORDER the list: a Wi-Fi adapter is what the phone
 * shares, while host-only/virtual adapters are reachable from this machine and from nothing else.
 */
const WIRELESS_ADAPTER = /wi-?fi|wlan|wireless|无线|wifi/i

/** Address blocks that belong to host-only virtual adapters (VirtualBox 192.168.56/24, VMware .x). */
const HOST_ONLY_BLOCK = /^192\.168\.56\./

/** Non-internal IPv4 addresses of this machine, real LAN adapters first. */
export function localAddresses() {
  const found = []
  for (const [name, entries] of Object.entries(networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.internal) continue
      if (entry.family !== 'IPv4') continue
      // 169.254.x.x means DHCP failed; nothing on that link can be reached reliably.
      const linkLocal = entry.address.startsWith('169.254.')
      const hostOnly = HOST_ONLY_BLOCK.test(entry.address)
      found.push({
        name,
        address: entry.address,
        virtual: VIRTUAL_ADAPTER.test(name) || linkLocal,
        // 排序权重：无线优先，其次是 host-only 网段（192.168.56.x 这类只有本机能到），最后是其余。
        rank: (VIRTUAL_ADAPTER.test(name) || linkLocal ? 4 : 0) + (hostOnly ? 2 : 0) + (WIRELESS_ADAPTER.test(name) ? 0 : 1),
      })
    }
  }
  // Stable order so the URL does not change between two calls with identical network state.
  return found
    .sort((a, b) => a.rank - b.rank || a.name.localeCompare(b.name))
    .map(({ rank: _rank, ...rest }) => rest)
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

/** Constant-time compare of two hex digests. */
function sameHash(a, b) {
  const left = Buffer.from(String(a), 'hex')
  const right = Buffer.from(String(b), 'hex')
  if (left.length !== right.length || left.length === 0) return false
  return timingSafeEqual(left, right)
}

/** Minimal cookie header parser; returns null when the cookie is absent. */
export function readCookie(header, name) {
  if (!header) return null
  for (const part of String(header).split(';')) {
    const index = part.indexOf('=')
    if (index < 0) continue
    if (part.slice(0, index).trim() !== name) continue
    return decodeURIComponent(part.slice(index + 1).trim())
  }
  return null
}

/**
 * Persisted state, read once and written on change.
 *
 * Only the HASH of each device token is stored. The token itself exists solely inside the phone's
 * cookie, so a copy of this file does not let anyone in.
 */
function readState(file) {
  try {
    if (!existsSync(file)) return { enabled: false, sessions: [] }
    const parsed = JSON.parse(readFileSync(file, 'utf8'))
    return {
      enabled: parsed?.enabled === true,
      sessions: Array.isArray(parsed?.sessions) ? parsed.sessions.filter((s) => typeof s?.hash === 'string') : [],
    }
  } catch {
    // A corrupt file must not lock the user out of their own app; start over, LAN still off.
    return { enabled: false, sessions: [] }
  }
}

export function createRemoteAccess(options = {}) {
  const file = options.file ?? dataFile('remote.json')
  const state = readState(file)

  /** In-memory only: a code that survives a restart is a code nobody is watching for. */
  let pair = null

  let port = options.port ?? 0

  function persist() {
    writeFileSync(file, JSON.stringify(state, null, 2) + '\n', 'utf8')
  }

  /** The URL a phone should open, or null when no route exists yet. */
  function urlFor(portOverride = port) {
    const first = localAddresses()[0]
    if (!first || !portOverride) return null
    return `http://${first.address}:${portOverride}`
  }

  function status(portOverride = port) {
    return {
      enabled: state.enabled,
      url: urlFor(portOverride),
      addresses: localAddresses(),
      pairedDevices: state.sessions.length,
      configFile: file,
    }
  }

  /** Turn LAN exposure on or off. Persisted only; the caller tells the user to restart. */
  function setEnabled(enabled) {
    state.enabled = enabled === true
    // Turning it off also drops every paired device: leaving valid cookies behind for a door the
    // user just closed would be a trap.
    if (!state.enabled) state.sessions = []
    persist()
    return status()
  }

  function issuePairCode(now = Date.now()) {
    const code = String(randomInt(0, 1_000_000)).padStart(6, '0')
    pair = { code, expiresAt: now + PAIR_TTL_MS, attempts: 0 }
    return { code, expiresAt: pair.expiresAt, ttlMs: PAIR_TTL_MS }
  }

  /**
   * Exchange a pairing code for a device token.
   *
   * Returns the raw token exactly once — the caller puts it in a cookie and never stores it. Every
   * failure mode (no code, expired, too many guesses, wrong) returns null, so a prober learns nothing
   * beyond "no".
   */
  function redeemPairCode(code, now = Date.now()) {
    if (!pair) return null
    if (now > pair.expiresAt) {
      pair = null
      return null
    }
    pair.attempts += 1
    if (pair.attempts > MAX_PAIR_ATTEMPTS) {
      pair = null
      return null
    }
    if (String(code ?? '').trim() !== pair.code) return null

    const token = randomBytes(32).toString('base64url')
    state.sessions.push({ hash: sha256(token), pairedAt: now })
    // Cap the list so a long-lived install cannot accumulate unbounded credentials.
    while (state.sessions.length > MAX_SESSIONS) state.sessions.shift()
    pair = null
    persist()
    return token
  }

  function revokeAll() {
    state.sessions = []
    pair = null
    persist()
    return status()
  }

  /**
   * The gate. Called for every request.
   *
   * `ok` means the request may proceed. A denial carries the reason so the caller can answer with the
   * right status and a message a human can act on.
   */
  function authorize(req, now = Date.now()) {
    const address = req.socket?.remoteAddress ?? req.connection?.remoteAddress
    if (isLoopback(address)) return { ok: true, via: 'loopback', loopback: true }

    if (!state.enabled) {
      return {
        ok: false,
        status: 403,
        reason: 'lan-disabled',
        message: '局域网访问未开启：请在电脑端的「设置 → 手机访问」里打开，然后重启应用。',
      }
    }

    const header = req.headers?.authorization
    const bearer = typeof header === 'string' && header.startsWith('Bearer ') ? header.slice(7).trim() : null
    const presented = bearer || readCookie(req.headers?.cookie, SESSION_COOKIE)
    if (!presented) {
      return { ok: false, status: 401, reason: 'no-credential', message: '需要先配对：请在电脑端获取配对码。' }
    }

    const digest = sha256(presented)
    // Expiry is not tracked separately: a stolen cookie is revoked by 解除配对, which is the action a
    // user can actually reason about ("我的手机还连着呢吗" has a visible answer).
    const match = state.sessions.find((session) => sameHash(session.hash, digest))
    if (!match) {
      return { ok: false, status: 401, reason: 'bad-credential', message: '配对已失效：请在电脑端重新生成配对码。' }
    }

    return { ok: true, via: 'token', loopback: false, pairedAt: match.pairedAt }
  }

  return {
    isEnabled: () => state.enabled,
    status,
    setEnabled,
    issuePairCode,
    redeemPairCode,
    revokeAll,
    authorize,
    urlFor,
    setPort(value) {
      port = value
    },
  }
}
