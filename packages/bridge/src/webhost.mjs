/**
 * Serve the built UI to a phone.
 *
 * WHY THE BRIDGE HOSTS THE PAGE AT ALL: the desktop UI is loaded by the Tauri webview, which can only
 * serve itself. A phone has nothing to load the app FROM unless the bridge does it, so this module
 * turns the sidecar into a small static host for `web/dist`. It is also why the bridge must own the
 * auth gate — the page and the API it calls live on the same origin now.
 *
 * THE ONE SUBTLETY: `useBridge.ts` decides which bridge to talk to from `window.__CCCN_BRIDGE_URL__`,
 * which the Rust shell normally injects. A phone has no shell, and the packaged fallback is a
 * hardcoded `127.0.0.1:43130` — which on a phone means the PHONE's own loopback, i.e. nothing. So
 * index.html is served with one extra same-origin script that fills in `location.origin`. Injecting a
 * `src` rather than an inline snippet is deliberate: the page's CSP is `script-src 'self'`, which
 * would block an inline script.
 */
import { existsSync, readFileSync, statSync } from 'node:fs'
import { extname, join, normalize, resolve, sep } from 'node:path'

/** Extension → content type. Only what the bundle actually ships; anything else is octet-stream. */
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
}

export const ORIGIN_SCRIPT_PATH = '/bridge-origin.js'

/**
 * Fills in the bridge URL the shell would otherwise inject, plus a flag the UI can read to know it is
 * being driven from a phone (so it can hide desktop-only affordances).
 */
export const ORIGIN_SCRIPT = `/* served by the bridge: this page is not in the Tauri webview. */
window.__CCCN_SERVED_BY_BRIDGE__ = true;
window.__CCCN_BRIDGE_URL__ = location.origin;
`

/** Read a small request body as text, bounded so a hostile peer cannot stream forever. */
export function readFormBody(req, limit = 8 * 1024) {
  return new Promise((resolvePromise) => {
    let size = 0
    const chunks = []
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > limit) {
        req.destroy()
        resolvePromise('')
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolvePromise(Buffer.concat(chunks).toString('utf8')))
    req.on('error', () => resolvePromise(''))
  })
}

export function parseForm(body) {
  const out = {}
  for (const pair of String(body ?? '').split('&')) {
    if (!pair) continue
    const index = pair.indexOf('=')
    const key = index < 0 ? pair : pair.slice(0, index)
    const value = index < 0 ? '' : pair.slice(index + 1)
    try {
      out[decodeURIComponent(key.replace(/\+/g, ' '))] = decodeURIComponent(value.replace(/\+/g, ' '))
    } catch {
      /* malformed pair: skip rather than fail the whole submission */
    }
  }
  return out
}

const escapeHtml = (value) =>
  String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char])

/**
 * The page a phone sees when it has no valid session.
 *
 * Serving this from a denial is the whole pairing UX: the user opens the URL and lands on the form,
 * rather than on a 401 they have to interpret. It carries its own strict CSP because it renders
 * attacker-influenced text (the message) and needs nothing but inline styles.
 */
export function pairPage({ message = '', showForm = true } = {}) {
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; form-action 'self'" />
<title>ChinaClaude · 配对</title>
<style>
  :root { color-scheme: dark; }
  body { margin: 0; min-height: 100vh; display: flex; align-items: center; justify-content: center;
         background: #151517; color: #e8e8ea;
         font: 16px/1.6 system-ui, -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif; }
  .card { width: min(92vw, 26rem); padding: 1.75rem; border-radius: 14px;
          background: #1e1e21; border: 1px solid #2c2c31; }
  h1 { margin: 0 0 .35rem; font-size: 1.15rem; }
  p { margin: .5rem 0; color: #a9a9b3; font-size: .9rem; }
  .msg { color: #f0a37a; }
  input { width: 100%; box-sizing: border-box; margin-top: 1rem; padding: .8rem .9rem;
          font-size: 1.5rem; letter-spacing: .35em; text-align: center;
          color: #e8e8ea; background: #151517; border: 1px solid #3a3a41; border-radius: 10px; }
  button { width: 100%; margin-top: .9rem; padding: .8rem; font-size: 1rem; cursor: pointer;
           color: #1a1a1c; background: #d97757; border: 0; border-radius: 10px; font-weight: 600; }
</style>
</head>
<body>
  <div class="card">
    <h1>ChinaClaude 手机访问</h1>
    ${message ? `<p class="msg">${escapeHtml(message)}</p>` : ''}
    ${
      showForm
        ? `<p>请在电脑上打开「设置 → 手机访问」，点「生成配对码」，然后把 6 位数字填在这里。</p>
    <form method="post" action="/pair">
      <input name="code" inputmode="numeric" autocomplete="one-time-code" maxlength="6"
             pattern="[0-9]{6}" placeholder="000000" required autofocus />
      <button type="submit">配对</button>
    </form>`
        : '<p>开启后，这台设备才能访问电脑上的会话。</p>'
    }
  </div>
</body>
</html>`
}

/**
 * Serve a file from the built UI, or hand back `false` so the caller can 404.
 *
 * `webRoot` is the staged `sidecar/web` directory. Every path is resolved and checked to stay inside
 * it — the phone is an untrusted caller, so `..` in a URL is treated as an attack rather than a
 * curiosity.
 */
export function serveWebFile(res, webRoot, pathname) {
  if (!webRoot || !existsSync(webRoot)) return false

  let relative
  try {
    relative = decodeURIComponent(pathname)
  } catch {
    return false
  }

  const target = resolve(join(webRoot, normalize(relative)))
  const root = resolve(webRoot)
  if (target !== root && !target.startsWith(root + sep)) return false

  let file = target
  if (existsSync(file) && statSync(file).isDirectory()) file = join(file, 'index.html')
  if (!existsSync(file) || !statSync(file).isFile()) return false

  const type = MIME[extname(file).toLowerCase()] ?? 'application/octet-stream'
  let body = readFileSync(file)

  if (extname(file).toLowerCase() === '.html') {
    /**
     * Teach the page where its own API lives, and that it is not in the desktop shell.
     *
     * Injected immediately AFTER `<head>` rather than before `</head>`, so it precedes every other
     * script in the document. Today that is belt-and-braces (the app is emitted as `type="module"`,
     * which is deferred and therefore runs after any classic script anyway), but it stops being
     * belt-and-braces the moment a bundler change emits a classic script — at which point source
     * order would decide, and injecting late would silently leave `__CCCN_BRIDGE_URL__` undefined.
     */
    const tag = `<script src="${ORIGIN_SCRIPT_PATH}"></script>`
    const html = body.toString('utf8')
    const withOrigin = /<\s*head[^>]*>/i.test(html)
      ? html.replace(/<\s*head[^>]*>/i, (match) => `${match}\n  ${tag}`)
      : html.replace('</head>', `${tag}</head>`)
    body = Buffer.from(withOrigin, 'utf8')
    res.writeHead(200, { 'content-type': type, 'cache-control': 'no-store' })
  } else {
    // Asset filenames carry a content hash, so they can be cached hard; index.html above is not.
    res.writeHead(200, { 'content-type': type, 'cache-control': 'public, max-age=31536000, immutable' })
  }

  res.end(body)
  return true
}
