/**
 * 局域网访问 + 静态托管：把此前一次性临时脚本验过的「手机访问」路径正式纳入回归门禁。
 *
 * 分两层，都是这一轮新增的 remote/webhost 模块的护栏：
 *
 *   A. 纯逻辑 —— isLoopback / readCookie / parseForm / pairPage 转义 / serveWebFile 路径穿越 /
 *      createRemoteAccess 的配对与吊销生命周期。毫秒级，不碰网络。
 *
 *   B. 端到端 —— spawn 真正的 cli.mjs，数据目录里预置 `remote.json {enabled:true}`，
 *      于是桥自动绑 `0.0.0.0`；再**从本机访问本机自己的局域网 IP**，服务端看到的
 *      `remoteAddress` 就是非 loopback 的局域网地址。这是单机完整跑通 LAN 鉴权路径的关键。
 *
 * 为什么值得端到端：这条路径的全部风险都在「谁被放进来」上——鉴权门写错一行就是远程代码执行。
 * 单元测试证明不了门真的接在 HTTP 上，所以两端都要。
 *
 * Run: node packages/bridge/test/lan-access.mjs
 */
import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { networkInterfaces, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { makeCheck, finish, stopChild } from './harness.mjs'
import { isLoopback, readCookie, createRemoteAccess, SESSION_COOKIE, localAddresses } from '../src/remote.mjs'
import { pairPage, parseForm, serveWebFile } from '../src/webhost.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const BRIDGE = join(here, '..', 'src', 'cli.mjs')

const results = []
const check = makeCheck(results)

// =============================================================================
// A. 纯逻辑
// =============================================================================

// ---- isLoopback：信任边界的定义，写错一个前缀就把整台网络放进来 --------------

check('::1 是回环', isLoopback('::1'))
check('127.0.0.1 是回环', isLoopback('127.0.0.1'))
check('整个 127.0.0.0/8 都算回环', isLoopback('127.9.9.9'))
check('IPv4 映射形式仍算回环', isLoopback('::ffff:127.0.0.1'))
check('局域网地址不是回环', !isLoopback('192.168.111.73'))
check('映射后的局域网地址不是回环', !isLoopback('::ffff:192.168.111.73'))
check('缺省地址不是回环', !isLoopback(undefined) && !isLoopback(''))

// ---- localAddresses：只列非 internal 的 IPv4，且带 adapter 名 ----------------

const addrs = localAddresses()
check('localAddresses 返回数组', Array.isArray(addrs))
check('每项都带 name/address/virtual', addrs.every((a) => typeof a.name === 'string' && typeof a.address === 'string' && typeof a.virtual === 'boolean'))
check('不包含 internal 回环', !addrs.some((a) => a.address.startsWith('127.')))

// ---- readCookie --------------------------------------------------------------

check('从 Cookie 头里取出会话', readCookie('a=1; cccn_session=token123', SESSION_COOKIE) === 'token123')
check('没有 Cookie 头时返回 null', readCookie(undefined, SESSION_COOKIE) === null)
check('名字不匹配时返回 null', readCookie('other=1', SESSION_COOKIE) === null)
check('Cookie 值会被解码', readCookie('cccn_session=a%20b', SESSION_COOKIE) === 'a b')

// ---- parseForm ---------------------------------------------------------------

check('解析单个字段', JSON.stringify(parseForm('code=123456')) === '{"code":"123456"}')
check('把 + 还原为空格', parseForm('b=hello+world').b === 'hello world')
check('做百分号解码', parseForm('x=%E4%B8%AD').x === '中')
check('空串得到空对象', Object.keys(parseForm('')).length === 0)
check('畸形字段被跳过而不是整单失败', Object.keys(parseForm('a=%E4')).length === 0)

// ---- pairPage：它渲染的是攻击者能影响的消息，必须转义 ------------------------

const escaped = pairPage({ message: '<img src=x onerror=alert(1)>' })
check('配对页转义了消息里的 HTML', escaped.includes('&lt;img') && !escaped.includes('<img src=x'))
check('showForm 为真时出现表单', pairPage({ showForm: true }).includes('<form'))
check('showForm 为假时不出现表单', !pairPage({ showForm: false }).includes('<form'))

// ---- serveWebFile：手机是不可信调用方，`..` 当攻击处理 ------------------------

const tmp = mkdtempSync(join(tmpdir(), 'cccn-lan-'))
const webDir = join(tmp, 'sidecar', 'web')
mkdirSync(join(webDir, 'sub'), { recursive: true })
writeFileSync(join(webDir, 'index.html'), '<!doctype html><html><head><title>x</title></head><body>CCCN-APP-SHELL</body></html>', 'utf8')
writeFileSync(join(webDir, 'app.js'), 'console.log("asset")', 'utf8')
writeFileSync(join(webDir, 'sub', 'index.html'), '<html><head></head><body>SUB</body></html>', 'utf8')
// 故意放在 web 根之外，用来验证穿越尝试拿不到它。
writeFileSync(join(tmp, 'sidecar', 'secret.txt'), 'TOP-SECRET', 'utf8')

function makeRes() {
  return {
    statusCode: 0,
    headers: {},
    chunks: [],
    writeHead(code, headers) {
      this.statusCode = code
      this.headers = headers ?? {}
    },
    end(body) {
      if (body !== undefined) this.chunks.push(Buffer.isBuffer(body) ? body : Buffer.from(String(body)))
    },
    text() {
      return Buffer.concat(this.chunks).toString('utf8')
    },
  }
}

let res = makeRes()
check('托管 index.html', serveWebFile(res, webDir, '/index.html') === true && res.statusCode === 200)
check('index.html 注入 bridge-origin 脚本', res.text().includes('<script src="/bridge-origin.js"></script>'))
check('index.html 不允许缓存（no-store）', res.headers['cache-control'] === 'no-store')
check('index.html 的 content-type 正确', String(res.headers['content-type']).includes('text/html'))

res = makeRes()
serveWebFile(res, webDir, '/app.js')
check('静态资源用长缓存（immutable）', String(res.headers['cache-control']).includes('immutable'))
check('静态资源 content-type 正确', String(res.headers['content-type']).includes('text/javascript'))

res = makeRes()
check('目录 / 回落到 index.html', serveWebFile(res, webDir, '/') === true && res.text().includes('CCCN-APP-SHELL'))
res = makeRes()
check('子目录 /sub 回落到其 index.html', serveWebFile(res, webDir, '/sub') === true && res.text().includes('SUB'))

res = makeRes()
check('不存在的文件返回 false', serveWebFile(res, webDir, '/nope.js') === false)
res = makeRes()
check('穿越尝试拿不到 web 根之外的文件', serveWebFile(res, webDir, '/../secret.txt') === false)
res = makeRes()
check('URL 编码的穿越同样拿不到', serveWebFile(res, webDir, '/..%2fsecret.txt') === false)
res = makeRes()
check('webRoot 为空时返回 false', serveWebFile(res, undefined, '/index.html') === false)

// ---- createRemoteAccess 生命周期 ---------------------------------------------

const stateFile = join(tmp, 'remote.json')
const access = createRemoteAccess({ file: stateFile, port: 43130 })

check('初始为关闭', access.isEnabled() === false)
check('回环请求免鉴权放行', access.authorize({ socket: { remoteAddress: '127.0.0.1' } }).ok === true)

const lanReq = { socket: { remoteAddress: '192.168.111.73' }, headers: {} }
let denied = access.authorize(lanReq)
check('未开启时局域网请求被 403 拒绝', denied.ok === false && denied.status === 403 && denied.reason === 'lan-disabled')

access.setEnabled(true)
check('开启后 isEnabled 为真', access.isEnabled() === true)
denied = access.authorize(lanReq)
check('开启后无凭据仍被 401 拒绝', denied.ok === false && denied.status === 401 && denied.reason === 'no-credential')

const pairInfo = access.issuePairCode()
check('配对码是 6 位数字', /^\d{6}$/.test(pairInfo.code), pairInfo.code)
check('错误的配对码换不到令牌', access.redeemPairCode('000000' === pairInfo.code ? '111111' : '000000') === null)

const token = access.redeemPairCode(pairInfo.code)
check('正确的配对码换到令牌', typeof token === 'string' && token.length > 20)
check('配对码是一次性的', access.redeemPairCode(pairInfo.code) === null)

check('Bearer 令牌通过鉴权', access.authorize({ socket: { remoteAddress: '192.168.111.73' }, headers: { authorization: `Bearer ${token}` } }).ok === true)
check('Cookie 令牌通过鉴权', access.authorize({ socket: { remoteAddress: '192.168.111.73' }, headers: { cookie: `${SESSION_COOKIE}=${token}` } }).ok === true)
denied = access.authorize({ socket: { remoteAddress: '192.168.111.73' }, headers: { authorization: 'Bearer not-a-real-token' } })
check('伪造令牌被 401 拒绝', denied.ok === false && denied.reason === 'bad-credential')

check('已配对设备计数为 1', access.status().pairedDevices === 1)
access.revokeAll()
check('解除配对后计数归零', access.status().pairedDevices === 0)
check('解除配对后旧令牌失效', access.authorize({ socket: { remoteAddress: '192.168.111.73' }, headers: { cookie: `${SESSION_COOKIE}=${token}` } }).ok === false)

// 关闭局域网会连带吊销全部设备，避免「门关了但钥匙还有效」。
access.setEnabled(true)
const token2 = access.redeemPairCode(access.issuePairCode().code)
access.setEnabled(false)
check('关闭局域网会吊销全部已配对设备', access.status().pairedDevices === 0)
check('关闭后旧令牌不再被接受', access.authorize({ socket: { remoteAddress: '192.168.111.73' }, headers: { cookie: `${SESSION_COOKIE}=${token2}` } }).ok === false)

// 过期与暴力尝试。
const expiring = createRemoteAccess({ file: join(tmp, 'remote2.json') })
const now = Date.now()
const code = expiring.issuePairCode(now).code
check('过期的配对码换不到令牌', expiring.redeemPairCode(code, now + 6 * 60 * 1000) === null)

const brute = createRemoteAccess({ file: join(tmp, 'remote3.json') })
const realCode = brute.issuePairCode().code
const wrong = realCode === '000000' ? '111111' : '000000'
for (let i = 0; i < 10; i++) brute.redeemPairCode(wrong)
check('连续错误尝试后正确的配对码也被烧掉', brute.redeemPairCode(realCode) === null)

// 损坏的配置文件不能让用户被挡在自己的应用外面。
const corrupt = join(tmp, 'remote-corrupt.json')
writeFileSync(corrupt, '{ not json', 'utf8')
const revived = createRemoteAccess({ file: corrupt })
check('损坏的 remote.json 退化为「未开启」而不是抛错', revived.isEnabled() === false)

// =============================================================================
// B. 端到端：真的起一个桥，从局域网地址打进去
// =============================================================================

function firstLanIp() {
  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.internal) continue
      if (entry.family !== 'IPv4') continue
      if (entry.address.startsWith('169.254.')) continue
      return entry.address
    }
  }
  return null
}

const lanIp = firstLanIp()

function waitForReady(child, timeoutMs = 40000) {
  return new Promise((resolve, reject) => {
    let buffer = ''
    const timer = setTimeout(() => reject(new Error('bridge did not report ready')), timeoutMs)
    child.stdout.on('data', (chunk) => {
      buffer += chunk
      const match = buffer.match(/CCCN_READY (\{.*\})/)
      if (match) {
        clearTimeout(timer)
        try {
          resolve(JSON.parse(match[1]))
        } catch (error) {
          reject(error)
        }
      }
    })
    child.once('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
  })
}

async function request(base, path, { method = 'GET', headers = {}, body } = {}) {
  const response = await fetch(base + path, { method, headers, body, redirect: 'manual' })
  const text = await response.text()
  const setCookie = response.headers.getSetCookie?.()[0] ?? response.headers.get('set-cookie')
  return { status: response.status, headers: response.headers, text, setCookie, json: () => JSON.parse(text) }
}

if (lanIp) {
  const dataDir = join(tmp, 'data')
  const sidecarDir = join(tmp, 'sidecar')
  mkdirSync(dataDir, { recursive: true })
  // 打开手机访问：桥据此把绑定地址从回环换成 0.0.0.0。
  writeFileSync(join(dataDir, 'remote.json'), JSON.stringify({ enabled: true, sessions: [] }, null, 2), 'utf8')
  // 预置一个已配置的微信机器人，验证状态只回掩码、不回全量凭据。
  const seededKey = 'seeded-key-1234-5678'
  writeFileSync(
    join(dataDir, 'wechat.json'),
    JSON.stringify({ enabled: true, webhookUrl: `https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=${seededKey}`, notifyOnFinish: true }, null, 2),
    'utf8',
  )

  const child = spawn(process.execPath, [BRIDGE, '--port', '0'], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      CCCN_DATA_DIR: dataDir,
      CCCN_SIDECAR_DIR: sidecarDir,
    },
  })

  try {
    const handshake = await waitForReady(child)
    const port = handshake.port
    const loop = `http://127.0.0.1:${port}`
    const lan = `http://${lanIp}:${port}`

    // 先探一下局域网地址是否真的可达（防火墙/虚拟网卡可能挡住）；不可达就跳过这一层，
    // 不要让一个环境问题把门禁染红。
    let lanReachable = true
    try {
      await request(lan, '/api/health')
    } catch {
      lanReachable = false
    }

    if (lanReachable) {
      check('回环可以访问健康接口', (await request(loop, '/api/health')).json().ok === true)

      const loopRemote = (await request(loop, '/api/remote')).json()
      check('回环看到的 remote 状态标记 loopback:true', loopRemote.loopback === true)
      check('桥确实绑到了局域网（active:true）', loopRemote.active === true && loopRemote.enabled === true)

      const lanNoCred = await request(lan, '/api/remote')
      check('局域网无凭据访问 API 被 401 拒绝', lanNoCred.status === 401 && lanNoCred.json().reason === 'no-credential')

      const lanPage = await request(lan, '/')
      check('局域网无凭据打开首页拿到配对页', lanPage.status === 401 && lanPage.text.includes('手机访问') && lanPage.text.includes('<form'))

      // 未配对的局域网连通用鉴权门都过不去（401），配对码路由根本不会被触达。
      check('未配对的局域网无法生成配对码（被鉴权门拦下）', (await request(lan, '/api/remote/pair-code', { method: 'POST' })).status === 401)

      const pairRes = await request(loop, '/api/remote/pair-code', { method: 'POST' })
      const pairBody = pairRes.json()
      check('电脑端可以生成 6 位配对码', pairRes.status === 200 && /^\d{6}$/.test(pairBody.code), pairBody.code)

      const wrongRedeem = await request(lan, '/pair', { method: 'POST', body: `code=${pairBody.code === '000000' ? '111111' : '000000'}` })
      check('局域网提交错误配对码被拒', wrongRedeem.status === 401)

      const redeem = await request(lan, '/pair', { method: 'POST', body: `code=${pairBody.code}` })
      check('局域网提交正确配对码被重定向到首页', redeem.status === 303 && redeem.headers.get('location') === '/')
      const cookie = String(redeem.setCookie ?? '').split(';')[0]
      check('配对成功下发了会话 Cookie（HttpOnly）', cookie.startsWith(`${SESSION_COOKIE}=`) && /HttpOnly/i.test(String(redeem.setCookie)))

      const pairedRemote = await request(lan, '/api/remote', { headers: { cookie } })
      check('带着 Cookie 的局域网请求通过鉴权（loopback:false）', pairedRemote.status === 200 && pairedRemote.json().loopback === false)

      // 已配对的手机能过鉴权门，但仍会在路由内被 loopback-only 规则拒掉——两层防护都要成立。
      check('已配对的局域网仍不能生成配对码（仅电脑端）', (await request(lan, '/api/remote/pair-code', { method: 'POST', headers: { cookie } })).status === 403)

      // 静态托管与 SPA 回落（回环侧）。
      const appJs = await request(loop, '/app.js')
      check('桥托管构建产物 app.js', appJs.status === 200 && String(appJs.headers.get('content-type')).includes('text/javascript'))
      const spa = await request(loop, '/settings/remote')
      check('未知的 SPA 路由回落到 index.html', spa.status === 200 && spa.text.includes('CCCN-APP-SHELL'))
      check('回落页同样注入 bridge-origin 脚本', (await request(loop, '/')).text.includes('/bridge-origin.js'))

      const origin = await request(lan, '/bridge-origin.js')
      check('bridge-origin.js 无需配对即可获取（公开引导）', origin.status === 200 && origin.text.includes('__CCCN_BRIDGE_URL__'))

      // 微信通知：读只回掩码，写与测试消息都只限电脑端。
      const wechatStatus = (await request(loop, '/api/wechat')).json()
      check('电脑端能读到微信通知状态', wechatStatus.configured === true && wechatStatus.enabled === true)
      check('状态里只有掩码，没有全量 webhook', !JSON.stringify(wechatStatus).includes(seededKey), JSON.stringify(wechatStatus.webhookMasked))
      check('局域网可以读状态但标记 loopback:false', (await request(lan, '/api/wechat', { headers: { cookie } })).json().loopback === false)
      check('局域网不能修改微信通知设置', (await request(lan, '/api/wechat', { method: 'POST', headers: { cookie }, body: JSON.stringify({ enabled: false }) })).status === 403)
      check('局域网不能发微信测试消息', (await request(lan, '/api/wechat/test', { method: 'POST', headers: { cookie }, body: '{}' })).status === 403)

      const badUrl = await request(loop, '/api/wechat', { method: 'POST', body: JSON.stringify({ webhookUrl: 'http://evil.example.com/hook' }) })
      check('电脑端提交非法 webhook 得到 ok:false（不发网络请求）', badUrl.status === 200 && badUrl.json().ok === false)

      // 共享模型配置：手机与桌面不同源、localStorage 不共享，桌面把端点与模型名发布到桥、手机只读复用。
      // 凭据不下发（手机本地输入），写死「只有电脑端能写」，否则手机就能改掉桌面用的端点与凭据。
      const seededProviders = [
        { id: 'p1', name: 'DeepSeek', baseUrl: 'https://api.deepseek.com/anthropic', apiKey: 'sk-shared-123', persistKey: true, models: [{ id: 'm1', model: 'deepseek-chat', label: 'DeepSeek Chat' }] },
      ]
      const publish = await request(loop, '/api/models', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ providers: seededProviders }),
      })
      check('电脑端可以发布模型配置', publish.status === 200 && publish.json().providers?.length === 1)
      // 端点与模型名共享，凭据不共享：手机只补齐端点即可，密钥在手机本地输入。
      check('发布响应不回传 API-KEY', !JSON.stringify(publish.json()).includes('sk-shared-123'))

      const loopModels = (await request(loop, '/api/models')).json()
      check('回环读到已发布的模型并标记 loopback:true', loopModels.loopback === true && loopModels.providers[0]?.name === 'DeepSeek')
      check('回环读取的共享模型也不含 API-KEY', loopModels.providers[0]?.apiKey === '' && !JSON.stringify(loopModels).includes('sk-shared-123'))

      const lanModels = await request(lan, '/api/models', { headers: { cookie } })
      check('已配对手机可以读到共享模型（loopback:false）', lanModels.status === 200 && lanModels.json().loopback === false && lanModels.json().providers?.length === 1)
      check('已配对手机读到的共享模型不含 API-KEY', lanModels.json().providers[0]?.apiKey === '' && !JSON.stringify(lanModels.json()).includes('sk-shared-123'))

      check('已配对手机不能修改模型配置（仅电脑端）', (await request(lan, '/api/models', { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({ providers: [] }) })).status === 403)
      check('未配对的局域网读不到共享模型（401）', (await request(lan, '/api/models')).status === 401)

      // 解除配对：吊销后旧 Cookie 立即失效。
      check('电脑端可以解除配对', (await request(loop, '/api/remote/revoke', { method: 'POST' })).status === 200)
      const afterRevoke = await request(lan, '/api/remote', { headers: { cookie } })
      check('吊销后旧 Cookie 被 401 拒绝', afterRevoke.status === 401 && afterRevoke.json().reason === 'bad-credential')
    } else {
      console.log('  SKIP  局域网地址不可达，跳过端到端 LAN 鉴权检查（纯逻辑部分仍已覆盖）')
    }
  } finally {
    await stopChild(child)
  }
} else {
  console.log('  SKIP  本机没有可用的局域网 IPv4，跳过端到端 LAN 检查')
}

rmSync(tmp, { recursive: true, force: true })
finish(results)
