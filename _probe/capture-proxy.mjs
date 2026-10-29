/**
 * 抓包代理：只在本机、只为这一次协议取证。
 *
 * 它把浏览器的 CONNECT 隧道升级成 TLS（用自签证书），解密后按原样转发给真实主机，并把
 * 请求/响应写进 captcha 文件。证书是临时的（7 天），Electron 需要用
 * `--ignore-certificate-errors` 启动才信任它——不往系统根证书里装东西。
 */
import { appendFileSync, readFileSync } from 'node:fs'
import { createServer as createHttpServer } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { TLSSocket, createSecureContext } from 'node:tls'
import { join } from 'node:path'

const ROOT = process.argv[2] ?? process.env.TEMP
const PORT = Number(process.argv[3] ?? 8899)
const LOG = join(ROOT, 'capture.jsonl')
const pfx = readFileSync(join(ROOT, 'leaf.pfx'))
const secureContext = createSecureContext({ pfx, passphrase: 'capture' })

const record = (entry) => appendFileSync(LOG, `${JSON.stringify(entry)}\n`, 'utf8')
const mask = (value) => (typeof value === 'string' && value.length > 24 ? `${value.slice(0, 12)}…(${value.length})` : value)

const inner = createHttpServer((req, res) => {
  const host = req.headers.host ?? ''
  const chunks = []
  req.on('data', (chunk) => chunks.push(chunk))
  req.on('end', () => {
    const body = Buffer.concat(chunks)
    const headers = { ...req.headers }
    if (headers.authorization) headers.authorization = mask(headers.authorization)
    record({ at: Date.now(), kind: 'request', host, method: req.method, url: req.url, headers, body: body.toString('utf8').slice(0, 200000) })

    const upstream = httpsRequest(
      { host: host.split(':')[0], port: 443, path: req.url, method: req.method, headers: req.headers },
      (upstreamRes) => {
        res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.headers)
        const out = []
        upstreamRes.on('data', (chunk) => out.push(chunk))
        upstreamRes.on('end', () => {
          record({ at: Date.now(), kind: 'response', host, url: req.url, status: upstreamRes.statusCode, body: Buffer.concat(out).toString('utf8').slice(0, 200000) })
        })
        upstreamRes.pipe(res)
      },
    )
    upstream.on('error', (error) => {
      res.writeHead(502)
      res.end(String(error.message))
    })
    upstream.end(body)
  })
})

const server = createHttpServer()
server.on('connect', (req, clientSocket, head) => {
  clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
  const tlsSocket = new TLSSocket(clientSocket, { isServer: true, secureContext })
  if (head?.length) tlsSocket.unshift(head)
  inner.emit('connection', tlsSocket)
})

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[capture] http://127.0.0.1:${PORT} -> ${LOG}`)
})
