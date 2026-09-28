/**
 * Serve the built web bundle for headless screenshots.
 *
 * The panels are only proven to render by looking at them: a green typecheck and a green `vite
 * build` both pass on a component that throws at mount. This serves `packages/web/dist` plus a
 * `/api` proxy to a running bridge, so a headless browser sees exactly what the packaged app serves
 * — the same shell, the same `?bridge=` override the webview uses.
 *
 * Run: node _probe/serve-dist.mjs [port] [bridgeUrl]
 */
import { createServer } from 'node:http'
import { readFile, stat } from 'node:fs/promises'
import { join, extname, resolve } from 'node:path'

const port = Number(process.argv[2] ?? 5180)
const bridgeUrl = process.argv[3] ?? 'http://127.0.0.1:43130'
const dist = resolve('packages/web/dist')

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.json': 'application/json; charset=utf-8',
  '.woff2': 'font/woff2',
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`)

  // Proxy the API so the page can talk to the bridge through one origin, mirroring vite dev.
  if (url.pathname.startsWith('/api')) {
    try {
      const upstream = await fetch(`${bridgeUrl}${url.pathname}${url.search}`, {
        method: req.method,
        headers: { 'content-type': req.headers['content-type'] ?? 'application/json' },
        body: req.method === 'GET' || req.method === 'HEAD' ? undefined : req,
        duplex: 'half',
      })

      const headers = {}
      for (const [key, value] of upstream.headers) {
        // Length and encoding belong to the FINAL response; copying them would mis-describe a
        // stream whose size is not known up front.
        if (key === 'content-length' || key === 'content-encoding') continue
        headers[key] = value
      }
      res.writeHead(upstream.status, headers)

      if (upstream.body) {
        // PIPE, do not buffer. `/api/sessions/:id/events` is an endless SSE stream: buffering it
        // with arrayBuffer() never resolves, so the page receives zero events and the transcript
        // silently stays empty — which looks exactly like a broken app rather than a broken proxy.
        const { Readable } = await import('node:stream')
        Readable.fromWeb(upstream.body).pipe(res)
      } else {
        res.end()
      }
    } catch (error) {
      res.writeHead(502, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: `proxy failed: ${String(error.message ?? error)}` }))
    }
    return
  }

  // SPA fallback: any unknown path serves index.html.
  let filePath = join(dist, url.pathname === '/' ? 'index.html' : url.pathname)
  try {
    const info = await stat(filePath)
    if (info.isDirectory()) filePath = join(filePath, 'index.html')
  } catch {
    filePath = join(dist, 'index.html')
  }

  try {
    const body = await readFile(filePath)
    res.writeHead(200, { 'content-type': TYPES[extname(filePath)] ?? 'application/octet-stream' })
    res.end(body)
  } catch (error) {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
    res.end(`not found: ${String(error.message ?? error)}`)
  }
})

server.listen(port, '127.0.0.1', () => {
  console.log(`serving ${dist}`)
  console.log(`http://127.0.0.1:${port}/   (api -> ${bridgeUrl})`)
})
