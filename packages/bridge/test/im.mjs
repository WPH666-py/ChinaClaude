/**
 * IM 通道：SSRF 守卫、掩码、加签和三种失败形态。
 *
 * The end-to-end half needs real webhook credentials, so this suite stubs `fetch` and proves the
 * decisions that do not depend on a tenant: which host may be reached, what a stored webhook looks like
 * when it comes back out, and whether a platform-level refusal (HTTP 200 with `errcode != 0`) is treated
 * as success — the classic way a "推送成功" lie is born.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dataRoot = mkdtempSync(join(tmpdir(), 'cccn-im-'))
process.env.CCCN_DATA_DIR = dataRoot

const { finish, makeCheck } = await import('./harness.mjs')
const im = await import('../src/im.mjs')

const results = []
const check = makeCheck(results)
const realFetch = globalThis.fetch

try {
  {
    const wrongHost = im.validateWebhook('wecom', 'https://evil.example.com/cgi-bin/webhook/send?key=abc')
    check('guard: a foreign host is refused', wrongHost.ok === false && String(wrongHost.error).includes('qyapi.weixin.qq.com'), wrongHost.error)
    const plain = im.validateWebhook('wecom', 'http://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=abc')
    check('guard: http is refused', plain.ok === false, plain.error)
    const ok = im.validateWebhook('feishu', 'https://open.feishu.cn/open-apis/bot/v2/hook/abc')
    check('guard: the official host passes', ok.ok === true)
  }

  {
    const saved = im.imSave({ id: 'wecom', webhook: 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=SECRET-KEY' })
    check('save: accepted', saved.ok === true, saved.error)
    const listed = im.imList().channels.find((channel) => channel.id === 'wecom')
    check('mask: configured flag', listed.configured === true)
    check('mask: never returns the key', !JSON.stringify(listed).includes('SECRET-KEY'), JSON.stringify(listed))
    check('mask: keeps the host', String(listed.masked).startsWith('qyapi.weixin.qq.com'), String(listed.masked))
    check('mask: digest present', /#[0-9a-f]{8}$/.test(String(listed.masked)), String(listed.masked))
  }

  {
    const timestamp = 1700000000000
    const signature = im.dingtalkSign('secret-value', timestamp)
    const decoded = Buffer.from(decodeURIComponent(signature), 'base64').toString('hex')
    check('sign: url-encoded', !signature.includes('+') && !signature.includes('/') && !signature.includes('='), signature)
    check('sign: base64 of a 32-byte hmac', decoded.length === 64, decoded)
    // Same inputs must give the same signature; a timestamp in the string would break this.
    check('sign: deterministic', im.dingtalkSign('secret-value', timestamp) === signature)
    check('sign: secret changes it', im.dingtalkSign('other', timestamp) !== signature)
  }

  function stub(handler) {
    globalThis.fetch = async (url, options) => handler(String(url), options)
  }
  const reply = (status, payload) => ({
    ok: status >= 200 && status < 300,
    status,
    text: async () => (typeof payload === 'string' ? payload : JSON.stringify(payload)),
  })

  {
    stub(() => reply(200, { errcode: 0, errmsg: 'ok' }))
    const sent = await im.imSend({ id: 'wecom', text: '测试' })
    check('send: success', sent.ok === true, sent.error)
  }

  {
    stub(() => reply(200, { errcode: 93000, errmsg: 'invalid webhook url' }))
    const refused = await im.imSend({ id: 'wecom', text: '测试' })
    check('send: application-level refusal is not success', refused.ok === false && String(refused.error).includes('93000'), refused.error)
  }

  {
    stub(() => reply(500, 'boom'))
    const failed = await im.imSend({ id: 'feishu', text: '测试' })
    check('send: unconfigured channel is refused before the network', failed.ok === false && String(failed.error).includes('没有配置'), failed.error)

    im.imSave({ id: 'feishu', webhook: 'https://open.feishu.cn/open-apis/bot/v2/hook/xyz' })
    const failed2 = await im.imSend({ id: 'feishu', text: '测试' })
    check('send: HTTP failure is a sentence with the status', failed2.ok === false && String(failed2.error).includes('500'), failed2.error)
  }

  {
    stub(() => {
      throw new Error('getaddrinfo ENOTFOUND qyapi.weixin.qq.com')
    })
    const offline = await im.imSend({ id: 'wecom', text: '测试' })
    check('send: network failure names the host', offline.ok === false && String(offline.error).includes('连不上'), offline.error)
  }

  {
    // Slack answers with the literal text "ok"; Discord answers 204 with an empty body. Neither carries an
    // errcode, so the success path must not assume a JSON payload — the 204 case is the easy one to break.
    const slackWrongHost = im.validateWebhook('slack', 'https://hooks.example.com/services/x')
    check('guard: slack host is pinned', slackWrongHost.ok === false, slackWrongHost.error)
    im.imSave({ id: 'slack', webhook: 'https://hooks.slack.com/services/AAA/BBB/CCC' })
    stub(() => reply(200, 'ok'))
    const slack = await im.imSend({ id: 'slack', text: '测试' })
    check('send: slack plain-text ok', slack.ok === true, slack.error)

    const discordWrongHost = im.validateWebhook('discord', 'https://discordapp.com/api/webhooks/x')
    check('guard: discord host is pinned to discord.com', discordWrongHost.ok === false, discordWrongHost.error)
    im.imSave({ id: 'discord', webhook: 'https://discord.com/api/webhooks/1/abc' })
    stub(() => reply(204, ''))
    const discord = await im.imSend({ id: 'discord', text: '测试' })
    check('send: discord 204 with empty body is success', discord.ok === true, discord.error)
  }

  {
    const empty = await im.imSend({ id: 'wecom', text: '   ' })
    check('send: empty text is refused', empty.ok === false, empty.error)
    const unknown = await im.imSend({ id: 'nope', text: 'x' })
    check('send: unknown channel is refused', unknown.ok === false && String(unknown.error).includes('未知'))
    const removed = im.imRemove({ id: 'feishu' })
    check('remove: works once, then says it is gone', removed.ok === true && im.imRemove({ id: 'feishu' }).ok === false)
  }
} catch (error) {
  check('suite ran without throwing', false, String(error?.stack ?? error))
} finally {
  globalThis.fetch = realFetch
  rmSync(dataRoot, { recursive: true, force: true })
}

finish(results, 10000)
