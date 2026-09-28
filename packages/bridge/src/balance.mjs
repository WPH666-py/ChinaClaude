/**
 * Account balance, read from the provider's own API.
 *
 * WHY IT IS NOT AUTOMATIC FOR EVERY VENDOR
 *
 * "Show my balance" has no standard: there is no shared endpoint, no shared shape, and some vendors
 * only expose it through a console. So this ships an adapter for the endpoint this client is built
 * around (verified against the live API, not read off a doc), plus a generic adapter for anyone
 * whose provider returns a number at a known URL. Claiming broader support would mean guessing
 * response shapes, and a wrong guess surfaces as a wrong balance — worse than none.
 *
 * The BRIDGE makes the request, not the page: it is not subject to CORS, and a provider that does
 * not send permissive headers would otherwise look like "no balance available".
 */

/** A balance figure, normalised so the UI does not have to know about vendor shapes. */
export function emptyBalance() {
  return { available: false, currency: null, total: null, granted: null, toppedUp: null, detail: null }
}

/**
 * Known adapters, matched on the endpoint host.
 *
 * DeepSeek's shape was verified live:
 *   { "is_available": true,
 *     "balance_infos": [ { "currency": "CNY", "total_balance": "109.19",
 *                          "granted_balance": "0.00", "topped_up_balance": "109.19" } ] }
 * Note the amounts are STRINGS; parsing them as-is would produce NaN arithmetic downstream.
 */
const ADAPTERS = [
  {
    id: 'deepseek',
    label: 'DeepSeek',
    match: (host) => host.endsWith('api.deepseek.com'),
    /**
     * The balance lives on the API root, NOT under the Anthropic-compatible prefix — a base URL of
     * `https://api.deepseek.com/anthropic` must still query `https://api.deepseek.com/user/balance`.
     */
    url: (base) => `${new URL(base).origin}/user/balance`,
    parse: (payload) => {
      const info = Array.isArray(payload?.balance_infos) ? payload.balance_infos[0] : null
      if (!info) return null
      const num = (value) => {
        const parsed = Number(value)
        return Number.isFinite(parsed) ? parsed : null
      }
      return {
        available: payload?.is_available !== false,
        currency: info.currency ?? null,
        total: num(info.total_balance),
        granted: num(info.granted_balance),
        toppedUp: num(info.topped_up_balance),
        detail: null,
      }
    },
  },
]

/** The adapter for an endpoint, or null when none is known. */
export function adapterFor(baseUrl) {
  let host
  try {
    host = new URL(baseUrl).host.toLowerCase()
  } catch {
    return null
  }
  return ADAPTERS.find((adapter) => adapter.match(host)) ?? null
}

/**
 * Generic adapter: a URL plus the dotted path to the number inside the response.
 *
 * Kept deliberately dumb — it fetches and reads one value. Anything cleverer would be inventing a
 * schema for vendors we cannot test against.
 */
function parseByPath(payload, path) {
  if (!path) return null
  let cursor = payload
  for (const segment of String(path).split('.')) {
    if (cursor === null || cursor === undefined) return null
    // Tolerate a leading array index so `balance_infos.0.total_balance` works.
    cursor = Array.isArray(cursor) && /^\d+$/.test(segment) ? cursor[Number(segment)] : cursor[segment]
  }
  const parsed = Number(cursor)
  return Number.isFinite(parsed) ? parsed : null
}

/**
 * Query the balance for one provider.
 *
 * Never throws: an unreachable endpoint, a 401 and an unexpected shape are all reported as
 * `available: false` with a reason, because the caller is a sidebar that must render something
 * honest rather than disappear.
 *
 * @param {{baseUrl:string, apiKey:string, balanceUrl?:string, balancePath?:string, currency?:string}} provider
 * @param {{fetchImpl?:typeof fetch, timeoutMs?:number}} [options]
 */
export async function fetchBalance(provider, options = {}) {
  const doFetch = options.fetchImpl ?? fetch
  const timeoutMs = options.timeoutMs ?? 12000
  const baseUrl = String(provider?.baseUrl ?? '').trim()
  const apiKey = String(provider?.apiKey ?? '').trim()

  if (!baseUrl) return { ...emptyBalance(), error: '未配置端点' }
  if (!apiKey) return { ...emptyBalance(), error: '未配置 API KEY' }

  const custom = String(provider?.balanceUrl ?? '').trim()
  const builtin = adapterFor(baseUrl)

  let url
  let parse
  if (custom) {
    url = custom
    const path = String(provider?.balancePath ?? '').trim()
    parse = (payload) => {
      const total = parseByPath(payload, path)
      if (total === null) return null
      return {
        available: true,
        currency: provider?.currency ?? null,
        total,
        granted: null,
        toppedUp: null,
        detail: null,
      }
    }
  } else if (builtin) {
    url = builtin.url(baseUrl)
    parse = builtin.parse
  } else {
    return {
      ...emptyBalance(),
      error: '该服务商没有内置余额接口，可在设置里填写余额地址',
      adapter: null,
    }
  }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await doFetch(url, {
      headers: { authorization: `Bearer ${apiKey}`, accept: 'application/json' },
      signal: controller.signal,
    })
    if (!response.ok) {
      // 401 is common enough to be worth naming: it means the key is wrong for THIS endpoint.
      const hint = response.status === 401 || response.status === 403 ? '（KEY 不被该端点接受）' : ''
      return { ...emptyBalance(), error: `HTTP ${response.status}${hint}`, adapter: builtin?.id ?? 'custom', url }
    }
    const payload = await response.json().catch(() => null)
    const parsed = parse(payload)
    if (!parsed) {
      return { ...emptyBalance(), error: '响应里没有可识别的余额字段', adapter: builtin?.id ?? 'custom', url }
    }
    return { ...parsed, error: null, adapter: builtin?.id ?? 'custom', url }
  } catch (error) {
    const aborted = error?.name === 'AbortError'
    return {
      ...emptyBalance(),
      error: aborted ? `请求超时（${timeoutMs}ms）` : String(error?.message ?? error),
      adapter: builtin?.id ?? 'custom',
      url,
    }
  } finally {
    clearTimeout(timer)
  }
}

/** Format a balance for display, keeping the vendor's own currency label. */
export function formatBalance(balance) {
  if (!balance?.available || balance.total === null || balance.total === undefined) return null
  const symbol = balance.currency === 'CNY' ? '¥' : balance.currency === 'USD' ? '$' : ''
  const amount = Math.abs(balance.total) >= 100 ? balance.total.toFixed(2) : balance.total.toFixed(4)
  return `${symbol}${amount}${symbol ? '' : ' ' + (balance.currency ?? '')}`.trim()
}
