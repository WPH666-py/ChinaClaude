/**
 * 消息通道（`dsh-im` 的移植）：把会话进展推到 IM。
 *
 * WHY ONLY WEBHOOK CHANNELS: the upstream plugin drives 13 channels with official bot SDKs, per-chat
 * session binding and streaming cards. That is a product in itself. What this app can do honestly with
 * zero dependencies is the part every team actually starts with — an incoming-webhook push to the group
 * the user already has — for the channels whose webhook payloads are small and documented.
 *
 * WHY THE WEBHOOK IS MASKED IN EVERY RESPONSE: a webhook URL is a bearer credential (anyone with it can
 * post to the group). The panel only needs to show WHICH group, so responses carry the host and a short
 * fingerprint, never the token.
 *
 * WHY HOSTS ARE ALLOWLISTED: this bridge is reachable from a paired phone. A generic "post to any URL"
 * endpoint would turn it into an SSRF gadget aimed at the user's LAN. Each channel may only talk to its
 * own official host.
 */
import { createHmac } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'

import { dataFile } from './paths.mjs'

const TIMEOUT_MS = 10000

/** The channels this build can genuinely deliver to, with the exact host each one is allowed to reach. */
export const IM_CHANNELS = [
  {
    id: 'wecom',
    name: '企业微信群机器人',
    host: 'qyapi.weixin.qq.com',
    pathHint: '/cgi-bin/webhook/send?key=…',
    docs: 'https://developer.work.weixin.qq.com/document/path/91770',
    hint: '群设置 → 群机器人 → 添加机器人，复制 Webhook 地址。',
  },
  {
    id: 'feishu',
    name: '飞书自定义机器人',
    host: 'open.feishu.cn',
    pathHint: '/open-apis/bot/v2/hook/…',
    docs: 'https://open.feishu.cn/document/client-docs/bot-v3/add-custom-bot',
    hint: '群设置 → 群机器人 → 添加自定义机器人，复制 Webhook 地址。',
  },
  {
    id: 'dingtalk',
    name: '钉钉自定义机器人',
    host: 'oapi.dingtalk.com',
    pathHint: '/robot/send?access_token=…',
    docs: 'https://open.dingtalk.com/document/orgapp/custom-robot-access',
    hint: '群设置 → 智能群助手 → 添加机器人 → 自定义，复制 Webhook 与加签密钥（可选）。',
  },
  {
    id: 'slack',
    name: 'Slack Incoming Webhook',
    host: 'hooks.slack.com',
    pathHint: '/services/…',
    docs: 'https://api.slack.com/messaging/webhooks',
    hint: 'Slack App 管理页 → Incoming Webhooks → 添加到频道，复制 Webhook URL。',
  },
  {
    id: 'discord',
    name: 'Discord Webhook',
    host: 'discord.com',
    pathHint: '/api/webhooks/…',
    docs: 'https://support.discord.com/hc/en-us/articles/228383668',
    hint: '频道设置 → 整合 → Webhook → 新建，复制 Webhook URL。',
  },
]

/** Channels the upstream plugin drives that this build deliberately does not: named, not hidden. */
export const IM_NOT_SUPPORTED = [
  { name: '微信 / QQ / Telegram / WhatsApp / Matrix', reason: '需要官方机器人 SDK、长连接与会话绑定，属另一批工程' },
]

function storeFile() {
  return dataFile('im.json')
}

/** Stored channels, keyed by id. A corrupt file degrades to "nothing configured". */
export function readIm() {
  try {
    const parsed = JSON.parse(readFileSync(storeFile(), 'utf8'))
    return parsed && typeof parsed === 'object' && parsed.channels ? parsed : { channels: {} }
  } catch {
    return { channels: {} }
  }
}

function writeIm(state) {
  writeFileSync(storeFile(), `${JSON.stringify(state, null, 2)}\n`, 'utf8')
}

/** Host + a short digest: enough for the user to recognise the group, never enough to post. */
function maskWebhook(webhook) {
  try {
    const url = new URL(webhook)
    const digest = createHmac('sha256', 'cccn-im-mask').update(String(webhook)).digest('hex').slice(0, 8)
    return `${url.host}${url.pathname.startsWith('/') ? '' : '/'}…#${digest}`
  } catch {
    return '（无效地址）'
  }
}

function channelOf(id) {
  return IM_CHANNELS.find((channel) => channel.id === id) ?? null
}

/** Validate a webhook against ITS channel's host and scheme. */
export function validateWebhook(id, webhook) {
  const channel = channelOf(id)
  if (!channel) return { ok: false, error: `未知渠道：${String(id)}` }
  const raw = String(webhook ?? '').trim()
  if (raw === '') return { ok: false, error: '请填写 Webhook 地址' }
  let url
  try {
    url = new URL(raw)
  } catch {
    return { ok: false, error: '这不是一个合法的 URL' }
  }
  if (url.protocol !== 'https:') return { ok: false, error: '只接受 https 地址' }
  if (url.hostname !== channel.host) {
    return { ok: false, error: `${channel.name} 的 Webhook 必须是 ${channel.host} 域名，收到的是 ${url.hostname}` }
  }
  return { ok: true, channel, url }
}

/** Public state: every channel with a masked endpoint and whether a secret is held. */
export function imList() {
  const { channels } = readIm()
  return {
    ok: true,
    channels: IM_CHANNELS.map((channel) => {
      const saved = channels[channel.id] ?? null
      return {
        id: channel.id,
        name: channel.name,
        host: channel.host,
        pathHint: channel.pathHint,
        docs: channel.docs,
        hint: channel.hint,
        configured: saved !== null,
        masked: saved ? maskWebhook(saved.webhook) : null,
        hasSecret: Boolean(saved?.secret),
        savedAt: saved?.savedAt ?? null,
      }
    }),
    unsupported: IM_NOT_SUPPORTED,
  }
}

/** Store one channel. `webhook` is required; `secret` is the DingTalk signing key (optional). */
export function imSave({ id, webhook, secret } = {}) {
  const check = validateWebhook(id, webhook)
  if (!check.ok) return { ok: false, error: check.error }
  const state = readIm()
  state.channels[id] = {
    webhook: String(webhook).trim(),
    secret: String(secret ?? '').trim(),
    savedAt: new Date().toISOString(),
  }
  writeIm(state)
  return { ok: true, channel: imList().channels.find((channel) => channel.id === id) }
}

export function imRemove({ id } = {}) {
  const state = readIm()
  if (!state.channels[id]) return { ok: false, error: '这个渠道还没有配置' }
  delete state.channels[id]
  writeIm(state)
  return { ok: true }
}

/**
 * DingTalk's signature: HMAC-SHA256 over `timestamp + "\n" + secret`, base64, then URL-encoded.
 *
 * Exported so a test can pin it to a fixed timestamp: the signature is the one part of the send path
 * that a mistake would show up as "signature mismatch" at the far end, long after the code looked fine.
 */
export function dingtalkSign(secret, timestamp) {
  const stringToSign = `${timestamp}\n${secret}`
  const signature = createHmac('sha256', secret).update(stringToSign).digest('base64')
  return encodeURIComponent(signature)
}

/** The JSON body each channel expects. Kept side by side so a change is visible as a diff of all three. */
function payloadFor(id, text) {
  if (id === 'wecom') return { msgtype: 'text', text: { content: text } }
  if (id === 'feishu') return { msg_type: 'text', content: { text } }
  if (id === 'slack') return { text }
  if (id === 'discord') return { content: text }
  return { msgtype: 'text', text: { content: text } }
}

/**
 * Send one text message.
 *
 * Returns a sentence for every failure the far end can produce (network, 401/403, and the channel's own
 * `errcode`), because "推送失败" alone gives the user nothing to act on.
 */
export async function imSend({ id, text } = {}) {
  const channel = channelOf(id)
  if (!channel) return { ok: false, error: `未知渠道：${String(id)}` }
  const saved = readIm().channels[id]
  if (!saved) return { ok: false, error: `${channel.name} 还没有配置` }

  const content = String(text ?? '').trim()
  if (content === '') return { ok: false, error: '消息内容不能为空' }
  if (content.length > 4000) return { ok: false, error: '消息太长（上限 4000 字符）' }

  let target = saved.webhook
  if (id === 'dingtalk' && saved.secret) {
    const timestamp = Date.now()
    const separator = target.includes('?') ? '&' : '?'
    target = `${target}${separator}timestamp=${timestamp}&sign=${dingtalkSign(saved.secret, timestamp)}`
  }

  try {
    const response = await fetch(target, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payloadFor(id, content)),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
    const bodyText = await response.text()
    let payload = null
    try {
      payload = bodyText === '' ? null : JSON.parse(bodyText)
    } catch {
      payload = null
    }

    if (!response.ok) {
      return { ok: false, status: response.status, error: `推送失败（HTTP ${response.status}）：${bodyText.slice(0, 160)}` }
    }
    // Each channel reports application-level failures with a 0 errcode; HTTP 200 alone means nothing.
    const errcode = payload?.errcode ?? payload?.code ?? payload?.StatusCode ?? 0
    if (Number(errcode) !== 0) {
      const message = payload?.errmsg ?? payload?.msg ?? payload?.StatusMessage ?? bodyText.slice(0, 160)
      return { ok: false, status: response.status, error: `平台拒绝了这条消息（${errcode}）：${message}` }
    }
    return { ok: true, status: response.status }
  } catch (error) {
    const name = error?.name ?? ''
    if (name === 'TimeoutError' || name === 'AbortError') return { ok: false, error: `推送超时（${TIMEOUT_MS / 1000} 秒）` }
    return { ok: false, error: `连不上 ${channel.host}：${String(error?.message ?? error)}` }
  }
}
