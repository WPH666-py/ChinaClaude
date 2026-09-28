/**
 * Connection test for an Anthropic-compatible endpoint.
 *
 * WHY THE BRIDGE MAKES THE CALL: the page cannot. A vendor that sends no permissive CORS headers
 * would look like a broken endpoint, and a preflight against a path the vendor does not implement
 * would fail before the real request was ever tried. The bridge has no such restriction.
 *
 * WHY IT SENDS A REAL MESSAGE rather than probing `GET /v1/models`:
 *
 *   - Several supported vendors DO NOT IMPLEMENT `/v1/models` at all (Aliyun's Anthropic-compatible
 *     endpoint is documented as Messages-only, and returns 404 there). A model-list probe would
 *     report those endpoints as broken when they work perfectly.
 *   - The three things the user typed are the endpoint, the key AND the model name. Only an actual
 *     Messages call exercises all three: a wrong key is 401, a wrong path is 404, and a model the
 *     endpoint does not serve is a 400 that names the model. A reachability check would pass on a
 *     key that cannot answer anything.
 *
 * The cost is one turn of a handful of tokens, which is the price of testing the thing that matters.
 */

/** Headers Anthropic requires; a relay that ignores them still accepts them. */
function buildHeaders(apiKey) {
  return {
    'content-type': 'application/json',
    'anthropic-version': '2023-06-01',
    // Sent both ways on purpose: some relays read `x-api-key`, others only `Authorization`.
    'x-api-key': apiKey,
    authorization: `Bearer ${apiKey}`,
  }
}

/**
 * Join a base URL with `/v1/messages` without doubling a version segment.
 *
 * A base URL ending in `/v1` is a common way to configure this (the docs of several vendors show it),
 * and appending `/v1/messages` to it produces `/v1/v1/messages` — a 404 that looks like a wrong host.
 */
export function messagesUrl(baseUrl) {
  const trimmed = String(baseUrl ?? '').trim().replace(/\/+$/, '')
  if (!trimmed) return ''
  return /\/v1$/.test(trimmed) ? `${trimmed}/messages` : `${trimmed}/v1/messages`
}

/** Pull the most useful sentence out of an error body, whatever shape the vendor used. */
function describeError(status, payload, rawText) {
  const message =
    payload?.error?.message ??
    payload?.message ??
    payload?.error?.type ??
    (rawText ? rawText.slice(0, 200) : '')
  const named = {
    400: '请求被拒绝（模型名或参数不被该端点接受）',
    401: '鉴权失败（API-KEY 不被该端点接受）',
    403: '无权访问（KEY 有效但未开通该模型？）',
    404: '路径不存在（Base-URL 可能少了或多了 /v1）',
    429: '配额或频率受限',
    500: '端点内部错误',
    502: '网关错误（端点或中转不可用）',
    503: '服务暂不可用',
  }[status]
  const head = named ? `${named}` : `HTTP ${status}`
  return message ? `${head}：${message}` : head
}

/**
 * Test one endpoint/key/model combination.
 *
 * Never throws: an unreachable host, a timeout and a rejected key are all reported as
 * `{ ok: false, message }`, because the caller is a form that must show the reason.
 *
 * @returns {Promise<{ok:boolean, status:number|null, latencyMs:number, message:string, model:string}>}
 */
export async function testConnection(provider, options = {}) {
  const doFetch = options.fetchImpl ?? fetch
  const timeoutMs = options.timeoutMs ?? 25000

  const baseUrl = String(provider?.baseUrl ?? '').trim()
  const apiKey = String(provider?.apiKey ?? '').trim()
  const model = String(provider?.model ?? '').trim()

  if (!baseUrl) return { ok: false, status: null, latencyMs: 0, message: '请填写 Base-URL', model }
  if (!apiKey) return { ok: false, status: null, latencyMs: 0, message: '请填写 API-KEY', model }
  if (!model) return { ok: false, status: null, latencyMs: 0, message: '请填写模型名称', model }

  /**
   * A key that cannot be put in an HTTP header, caught here rather than in fetch.
   *
   * Headers are ByteStrings, so one full-width character turns into
   * "Cannot convert argument to a ByteString because the character at index 3 has a value of 8226",
   * which says nothing about the key. That is not a rare typo: copying a key out of a console that
   * renders Chinese text wraps it in full-width punctuation or inserts a zero-width space, and the
   * pasted result LOOKS correct.
   */
  const badChar = [...apiKey].find((char) => char.codePointAt(0) > 255)
  if (badChar !== undefined) {
    return {
      ok: false,
      status: null,
      latencyMs: 0,
      message: `API-KEY 里有非 ASCII 字符「${badChar}」(U+${badChar.codePointAt(0).toString(16).toUpperCase()})，通常是复制时带入了全角字符或零宽字符，请重新复制`,
      model,
    }
  }
  // Surrounding whitespace is TRIMMED rather than reported: it is a paste artifact that the trim
  // silently fixes, and warning about something already handled would be noise.

  let url
  try {
    url = messagesUrl(baseUrl)
    // Reject a host-less value early, so the user gets "地址不合法" instead of "fetch failed".
    new URL(url)
  } catch {
    return { ok: false, status: null, latencyMs: 0, message: `Base-URL 不是合法地址：${baseUrl}`, model }
  }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  const started = Date.now()

  try {
    const response = await doFetch(url, {
      method: 'POST',
      headers: buildHeaders(apiKey),
      signal: controller.signal,
      body: JSON.stringify({
        model,
        // Enough for a real answer, small enough that a test is free in practice.
        max_tokens: 16,
        messages: [{ role: 'user', content: 'ping' }],
      }),
    })
    const latencyMs = Date.now() - started

    if (response.ok) {
      // Read the body so a relay that returns 200 with an error payload is not reported as success.
      const text = await response.text().catch(() => '')
      let payload = null
      try {
        payload = JSON.parse(text)
      } catch {
        /* plain text or SSE: the status is what matters */
      }
      if (payload?.error) {
        return { ok: false, status: response.status, latencyMs, message: describeError(response.status, payload, text), model }
      }
      return {
        ok: true,
        status: response.status,
        latencyMs,
        message: `连接成功（${latencyMs} ms）`,
        model,
        url,
      }
    }

    const text = await response.text().catch(() => '')
    let payload = null
    try {
      payload = JSON.parse(text)
    } catch {
      /* non-JSON error body */
    }
    return { ok: false, status: response.status, latencyMs, message: describeError(response.status, payload, text), model, url }
  } catch (error) {
    const latencyMs = Date.now() - started
    const aborted = error?.name === 'AbortError'
    return {
      ok: false,
      status: null,
      latencyMs,
      message: aborted ? `连接超时（${timeoutMs} ms）` : `无法连接：${String(error?.message ?? error)}`,
      model,
      url,
    }
  } finally {
    clearTimeout(timer)
  }
}
