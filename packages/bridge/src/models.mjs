/**
 * The model configuration the desktop shares with its paired phones.
 *
 * WHY THIS EXISTS: the desktop webview and a phone browser are two different origins (`tauri://`
 * versus `http://192.168.x.x:43130`), so they do NOT share localStorage — the desktop's bound model
 * simply does not exist as far as the phone is concerned, and the phone showed "您还未绑定模型" even
 * though the machine serving it was fully configured. This is the server-side copy that closes the
 * gap: the desktop PUBLISHES its provider list here on every change, and the phone READS it when it
 * has nothing of its own.
 *
 * WHAT IS SHARED IS ENDPOINTS AND MODEL NAMES, NOT CREDENTIALS. The stored snapshot is the desktop's
 * own copy and keeps its keys; anything handed to a client goes through `publicModels()` below, which
 * blanks them. See that function for why.
 *
 * The file lives beside the other feature state (`remote.json`, `wechat.json`) under the data root,
 * so it is removed by the same uninstall/cleanup a user already understands.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { dataFile } from './paths.mjs'

function file() {
  return dataFile('models.json')
}

/**
 * The last published snapshot, or an empty one.
 *
 * A missing or corrupt file degrades to "nothing shared" rather than throwing: a phone that cannot
 * read this must fall back to its own binding form, never fail to load.
 */
export function readModels() {
  try {
    const parsed = JSON.parse(readFileSync(file(), 'utf8'))
    if (!parsed || !Array.isArray(parsed.providers)) return { providers: [], updatedAt: 0 }
    return { providers: parsed.providers, updatedAt: Number(parsed.updatedAt) || 0 }
  } catch {
    return { providers: [], updatedAt: 0 }
  }
}

/** Replace the snapshot. Returns what was stored, so the caller echoes the same shape back. */
export function writeModels(providers) {
  const snapshot = {
    providers: Array.isArray(providers) ? providers : [],
    updatedAt: Date.now(),
  }
  writeFileSync(file(), JSON.stringify(snapshot, null, 2), 'utf8')
  return snapshot
}

/**
 * The snapshot with credentials stripped, which is the ONLY shape that ever leaves this module for a
 * client.
 *
 * WHY KEYS ARE WITHHELD: a phone only needs to know WHICH endpoint serves WHICH models so its owner
 * does not retype them; the key itself is a credential, and reaching a phone means crossing the LAN as
 * plain HTTP and then sitting in that phone's storage. The key is asked for once ON the phone and kept
 * there, so the desktop's credential never leaves the machine. The phone sees an empty `apiKey` and its
 * existing "缺少 API-KEY" banner already tells the user what to do — no separate flag is needed.
 */
export function publicModels() {
  const { providers, updatedAt } = readModels()
  return {
    updatedAt,
    providers: providers.map((provider) => ({ ...provider, apiKey: '' })),
  }
}

/** Endpoints compare equal when they differ only by surrounding space or a trailing slash. */
function normalizeBaseUrl(baseUrl) {
  return String(baseUrl ?? '').trim().replace(/\/+$/, '')
}

/**
 * The stored credential for an endpoint, for the bridge's OWN use.
 *
 * WHY THIS EXISTS: `publicModels()` blanks keys before they reach a client, so a phone's balance
 * call arrives with an empty key and would otherwise read "未配置 API KEY" even though the machine
 * serving it holds a working key for that very endpoint. This resolves the key server-side by
 * endpoint, WITHOUT sending it to the caller — the phone still never sees the credential, it just
 * no longer has to present one for a provider the desktop already paid for.
 *
 * Returns '' when no provider matches, which the caller must treat as "no key", never as a reason
 * to reach for an unrelated credential.
 */
export function keyForBaseUrl(baseUrl) {
  const wanted = normalizeBaseUrl(baseUrl)
  if (!wanted) return ''
  const { providers } = readModels()
  const match = providers.find((provider) => normalizeBaseUrl(provider?.baseUrl) === wanted)
  return String(match?.apiKey ?? '')
}
