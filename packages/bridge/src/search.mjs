/**
 * Web search for "modsearch".
 *
 * WHY A SERVER-SIDE FETCH AND NOT A MODEL TOOL ONLY: the point of this capability is that a person can
 * search without leaving the app, and that the model can cite real URLs. Both need one implementation
 * of "search the web", so this module is the single place that knows how.
 *
 * ENGINE CHOICE: DuckDuckGo's HTML endpoint needs no key and no JavaScript, which keeps the bridge
 * dependency-free. It is also the only endpoint that still returns plain HTML to a scripted client.
 * A 429/403 is reported as-is instead of being retried into a wall.
 */

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0 Safari/537.36'

/** Strip the tags DuckDuckGo leaves inside its result titles and snippets. */
function decodeEntities(text) {
  return String(text)
    .replace(/<[^>]*>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&#(\d+);/g, (_all, code) => String.fromCharCode(Number(code)))
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * DuckDuckGo wraps outbound links as `/l/?uddg=<encoded url>`. Unwrapping it matters: the wrapped form
 * bounces through a redirector that may be blocked later, and what the user should copy is the target.
 */
function unwrap(href) {
  const value = String(href ?? '')
  const match = /[?&]uddg=([^&]+)/.exec(value)
  if (!match) return value.startsWith('http') ? value : ''
  try {
    return decodeURIComponent(match[1])
  } catch {
    return ''
  }
}

export async function searchWeb({ query, limit = 8, timeoutMs = 15000 } = {}) {
  const text = String(query ?? '').trim()
  if (text === '') return { ok: false, error: '搜索内容为空' }

  const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(text)}`
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), Math.max(1000, Number(timeoutMs) || 15000))
  try {
    const response = await fetch(url, {
      headers: { 'user-agent': UA, accept: 'text/html', 'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8' },
      signal: controller.signal,
    })
    if (!response.ok) {
      return { ok: false, error: `搜索引擎返回 HTTP ${response.status}（免费接口有限流，稍后再试）` }
    }
    const html = await response.text()
    const results = []
    const block = /<a[^>]+class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>([\s\S]*?)(?=<a[^>]+class="result__a"|<\/body>)/g
    for (const match of html.matchAll(block)) {
      const target = unwrap(match[1])
      if (!target) continue
      const snippetMatch = /class="result__snippet"[^>]*>([\s\S]*?)<\/a>/.exec(match[3])
      results.push({
        title: decodeEntities(match[2]) || target,
        url: target,
        snippet: snippetMatch ? decodeEntities(snippetMatch[1]) : '',
      })
      if (results.length >= Math.max(1, Math.min(20, Number(limit) || 8))) break
    }
    if (results.length === 0) {
      return { ok: false, error: '没有解析到结果：对方可能返回了验证页（免费接口常见），换个词或稍后再试', html: html.slice(0, 400) }
    }
    return { ok: true, engine: 'duckduckgo', query: text, results }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return { ok: false, error: `连不上搜索引擎：${message}` }
  } finally {
    clearTimeout(timer)
  }
}
