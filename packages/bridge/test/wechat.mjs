/**
 * 微信接入：企业微信群机器人出站通知的回归用例。
 *
 * 三条不变式，缺一条这个模块就该被拦下：
 *   1. webhook 是凭据 —— 状态里只能出掩码，永远不出全量 URL。
 *   2. 发送是 best-effort —— 任何失败（未配置 / 未开启 / 非 2xx / errcode≠0 / 连不上 / 超时）
 *      都必须是返回的数据，不能是抛出的异常，否则它会连累它要描述的那次会话。
 *   3. URL 是 SSRF 面 —— 默认只允许企业微信那一个 host，测试旁路只能显式打开。
 *
 * 完全离线：`fetch` 被注入，不碰真网络，毫秒级跑完，也不会因为今天企业微信是否可达而红。
 *
 * Run: node packages/bridge/test/wechat.mjs
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { makeCheck, finish } from './harness.mjs'
import { isWecomWebhook, maskWebhook, createWechatNotifier, WECOM_HOST } from '../src/wechat.mjs'

const results = []
const check = makeCheck(results)

const REAL = 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=12345678-abcd-ef00-9999-abcdefabcdef'

// ---- URL 校验：默认只认企业微信那一个 host ----------------------------------

check('接受真实的企业微信群机器人 webhook', isWecomWebhook(REAL))
check('默认只白名单企业微信的 host', isWecomWebhook(REAL, { allowedHosts: [WECOM_HOST] }))
check('拒绝 http（默认强制 https）', !isWecomWebhook('http://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=x'))
check('requireHttps:false 时才放行 http', isWecomWebhook('http://127.0.0.1/cgi-bin/webhook/send?key=x', { allowedHosts: ['127.0.0.1'], requireHttps: false }))
check('拒绝不在白名单里的 host（SSRF 面）', !isWecomWebhook('https://evil.example.com/cgi-bin/webhook/send?key=x'))
check('拒绝路径不对的同 host 地址', !isWecomWebhook('https://qyapi.weixin.qq.com/cgi-bin/gettoken?key=x'))
check('拒绝非 URL 的垃圾输入', !isWecomWebhook('不是地址'))
check('拒绝空串', !isWecomWebhook(''))

// ---- 掩码：页面只能看到可辨识、不可复用的片段 --------------------------------

const masked = maskWebhook(REAL)
check('掩码保留了 host 与路径', masked.includes('qyapi.weixin.qq.com') && masked.includes('/cgi-bin/webhook/send'))
check('掩码隐藏了 key 的中段', !masked.includes('12345678-abcd-ef00-9999-abcdefabcdef'), masked)
check('掩码保留了 key 的首尾各 4 位', masked.includes('1234…cdef'), masked)
check('空 URL 掩码为空', maskWebhook('') === '')

// ---- 生命周期：配置 / 持久化 / 开关 ------------------------------------------

const dir = mkdtempSync(join(tmpdir(), 'cccn-wechat-'))
const file = join(dir, 'wechat.json')

try {
  const bot = createWechatNotifier({ file })

  let status = bot.status()
  check('初始：未配置、未开启、默认开启完成通知', status.configured === false && status.enabled === false && status.notifyOnFinish === true)
  check('初始：掩码为空', status.webhookMasked === '')

  // 没有 webhook 时不允许开启 —— 开了也是空转。
  let saved = bot.configure({ enabled: true })
  check('没有 webhook 时开启被拒（enabled 仍为 false）', saved.ok === true && saved.enabled === false)

  // 非法地址是结果，不是抛出的异常。
  saved = bot.configure({ webhookUrl: 'http://evil.example.com/hook' })
  check('非法 webhook 返回 ok:false 并带原因', saved.ok === false && typeof saved.error === 'string', saved.error)
  check('被拒的 webhook 不会污染已存状态', bot.status().configured === false)

  // 合法地址。
  saved = bot.configure({ webhookUrl: REAL })
  check('合法 webhook 保存成功', saved.ok === true && saved.configured === true)
  check('保存后仍未自动开启', saved.enabled === false)
  check('状态里只有掩码，没有全量 URL', !JSON.stringify(saved).includes('12345678-abcd'), JSON.stringify(saved))

  saved = bot.configure({ enabled: true })
  check('有 webhook 后可以开启', saved.enabled === true)

  // 持久化：新实例读同一个文件应看到同样的状态。
  const reloaded = createWechatNotifier({ file })
  check('配置写盘并被新实例读到', reloaded.status().configured === true && reloaded.status().enabled === true)

  // 清空 webhook 必须同时关掉开关 —— 否则就是「开着但无处可发」的谎。
  const cleared = reloaded.configure({ webhookUrl: '' })
  check('清空 webhook 会强制关闭开关', cleared.configured === false && cleared.enabled === false)
  const reloaded2 = createWechatNotifier({ file })
  check('清空同样写盘', reloaded2.status().configured === false && reloaded2.status().enabled === false)

  // ---- 发送：一切失败都是数据 ------------------------------------------------

  const disabled = createWechatNotifier({ file: join(dir, 'disabled.json') })
  check('未配置时 send 返回 ok:false', (await disabled.send('hi')).ok === false)

  const onButEmpty = createWechatNotifier({
    file: join(dir, 'on.json'),
    allowedHosts: ['127.0.0.1'],
    requireHttps: false,
    fetch: async () => new Response(JSON.stringify({ errcode: 0 }), { status: 200 }),
  })
  onButEmpty.configure({ webhookUrl: 'http://127.0.0.1/cgi-bin/webhook/send?key=x' })
  check('配置了但没开启时 send 返回 ok:false', (await onButEmpty.send('hi')).ok === false)
  onButEmpty.configure({ enabled: true })
  check('开启后空内容被拒', (await onButEmpty.send('   ')).ok === false)

  // 成功路径：请求体必须是 markdown。
  let seenBody = null
  const okBot = createWechatNotifier({
    file: join(dir, 'ok.json'),
    allowedHosts: ['127.0.0.1'],
    requireHttps: false,
    fetch: async (_url, init) => {
      seenBody = JSON.parse(init.body)
      return new Response(JSON.stringify({ errcode: 0, errmsg: 'ok' }), { status: 200 })
    },
  })
  okBot.configure({ webhookUrl: 'http://127.0.0.1/cgi-bin/webhook/send?key=x', enabled: true })
  const sent = await okBot.send('**标题**\n正文')
  check('正常发送返回 ok:true 且带时间戳', sent.ok === true && typeof sent.sentAt === 'number')
  check('请求体使用 markdown 消息类型', seenBody?.msgtype === 'markdown' && seenBody?.markdown?.content === '**标题**\n正文', JSON.stringify(seenBody))

  // 200 也可能失败：真实结果在 errcode。
  const errcodeBot = createWechatNotifier({
    file: join(dir, 'errcode.json'),
    allowedHosts: ['127.0.0.1'],
    requireHttps: false,
    fetch: async () => new Response(JSON.stringify({ errcode: 93000, errmsg: 'invalid webhook url' }), { status: 200 }),
  })
  errcodeBot.configure({ webhookUrl: 'http://127.0.0.1/cgi-bin/webhook/send?key=x', enabled: true })
  const errRes = await errcodeBot.send('hi')
  check('errcode≠0 即便 HTTP 200 也判为失败', errRes.ok === false && errRes.errcode === 93000, JSON.stringify(errRes))

  // 非 2xx。
  const httpBot = createWechatNotifier({
    file: join(dir, 'http.json'),
    allowedHosts: ['127.0.0.1'],
    requireHttps: false,
    fetch: async () => new Response('nope', { status: 500 }),
  })
  httpBot.configure({ webhookUrl: 'http://127.0.0.1/cgi-bin/webhook/send?key=x', enabled: true })
  const httpRes = await httpBot.send('hi')
  check('非 2xx 判为失败并带状态码', httpRes.ok === false && httpRes.status === 500, JSON.stringify(httpRes))

  // 连接失败。
  const deadBot = createWechatNotifier({
    file: join(dir, 'dead.json'),
    allowedHosts: ['127.0.0.1'],
    requireHttps: false,
    fetch: async () => {
      throw new Error('ECONNREFUSED')
    },
  })
  deadBot.configure({ webhookUrl: 'http://127.0.0.1/cgi-bin/webhook/send?key=x', enabled: true })
  const deadRes = await deadBot.send('hi')
  check('连接失败判为失败而不是抛出', deadRes.ok === false && String(deadRes.error).includes('ECONNREFUSED'), JSON.stringify(deadRes))

  // 超时。
  const timeoutBot = createWechatNotifier({
    file: join(dir, 'timeout.json'),
    allowedHosts: ['127.0.0.1'],
    requireHttps: false,
    timeoutMs: 30,
    fetch: (_url, init) =>
      new Promise((_resolve, reject) => {
        init.signal.addEventListener('abort', () => {
          const error = new Error('aborted')
          error.name = 'AbortError'
          reject(error)
        })
      }),
  })
  timeoutBot.configure({ webhookUrl: 'http://127.0.0.1/cgi-bin/webhook/send?key=x', enabled: true })
  const timeoutRes = await timeoutBot.send('hi')
  check('超时判为失败并说明是超时', timeoutRes.ok === false && String(timeoutRes.error).includes('超时'), JSON.stringify(timeoutRes))

  // notify 组合：标题加粗、空行丢弃。
  let notifyContent = ''
  const notifyBot = createWechatNotifier({
    file: join(dir, 'notify.json'),
    allowedHosts: ['127.0.0.1'],
    requireHttps: false,
    fetch: async (_url, init) => {
      notifyContent = JSON.parse(init.body).markdown.content
      return new Response(JSON.stringify({ errcode: 0 }), { status: 200 })
    },
  })
  notifyBot.configure({ webhookUrl: 'http://127.0.0.1/cgi-bin/webhook/send?key=x', enabled: true })
  await notifyBot.notify({ title: '会话已完成', lines: ['目录：D:\\work', '', '结果：正常'] })
  check('notify 把标题加粗并丢掉空行', notifyContent === '**会话已完成**\n目录：D:\\work\n结果：正常', JSON.stringify(notifyContent))

  // 损坏的配置文件不能把通知设置变成崩溃源。
  const corruptFile = join(dir, 'corrupt.json')
  const base = createWechatNotifier({ file: corruptFile })
  base.configure({ webhookUrl: REAL, enabled: true })
  const { writeFileSync } = await import('node:fs')
  writeFileSync(corruptFile, '{ not json', 'utf8')
  const revived = createWechatNotifier({ file: corruptFile })
  check('损坏的配置文件退化为「未配置」而不是抛错', revived.status().configured === false)
} finally {
  rmSync(dir, { recursive: true, force: true })
}

finish(results)
