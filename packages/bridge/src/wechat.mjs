/**
 * 微信接入：把会话的进展出站推送到「企业微信群机器人」。
 *
 * WHY THIS SHAPE, AND NOT A公众号/个人微信:
 *   1. A公众号 callback needs the bridge reachable from the public internet. This app is deliberately
 *      LAN-only and ships as an offline installer, so exposing a callback URL would contradict the one
 *      property the whole build is built around.
 *   2. A personal-WeChat bridge violates the platform's user agreement and risks the user's account.
 *      Shipping that would be handing the user a ban.
 *   3. A群机器人 webhook is a single outbound HTTPS request to a fixed host. It needs no inbound port,
 *      no domain, no account protocol — it works from a machine that is fully offline except for that
 *      one call, which is exactly this app's posture. The bot's display name in the group is the user's
 *      to set (`ChinaClaude-Mobot` for this project).
 *
 * THE WEBHOOK URL IS A CREDENTIAL: anyone holding it can post into the group. It is therefore written
 * to the per-user data root, never returned to a page in full (only masked), and only settable from
 * loopback — the same rule the pairing code follows.
 *
 * THE URL IS ALSO AN SSRF SURFACE: the bridge makes the request, and the caller supplies the address.
 * A loopback caller could already point `/api/test-connection` at arbitrary hosts, so this is not a new
 * class of exposure, but a webhook has no business being anywhere else either. The sender is therefore
 * restricted to the WeCom host by default; the allowlist is an option so a test can point it at a
 * local mock without the production default ever being loosened.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dataFile } from './paths.mjs'

/** The only host a real WeCom group-bot webhook lives on. */
export const WECOM_HOST = 'qyapi.weixin.qq.com'

/** A hung request must not pin a socket forever; the push is best-effort anyway. */
const REQUEST_TIMEOUT_MS = 8000

/** 企业微信 markdown 正文上限约 4096 字节；留一点余量给换行与控制字符。 */
const MAX_TEXT_CHARS = 3800

/** Show enough of a webhook URL to recognise it, never enough to use it. */
export function maskWebhook(url) {
  const value = String(url ?? '')
  if (!value) return ''
  const match = /[?&]key=([^&]+)/.exec(value)
  if (!match) {
    // No `key=` to hide; still avoid echoing a full path back to a page.
    return value.length > 18 ? `${value.slice(0, 18)}…` : value
  }
  const key = match[1]
  const shown = key.length > 8 ? `${key.slice(0, 4)}…${key.slice(-4)}` : '…'
  return value.replace(key, shown)
}

/**
 * Whether a URL is a WeCom group-bot webhook under the given allowlist.
 *
 * Kept free of side effects so both the sender and the tests can call it directly.
 */
export function isWecomWebhook(url, { allowedHosts = [WECOM_HOST], requireHttps = true } = {}) {
  let parsed
  try {
    parsed = new URL(String(url ?? '').trim())
  } catch {
    return false
  }
  if (requireHttps && parsed.protocol !== 'https:') return false
  if (!/^https?:$/.test(parsed.protocol)) return false
  if (!allowedHosts.includes(parsed.hostname)) return false
  return /^\/cgi-bin\/webhook\/send\b/.test(parsed.pathname)
}

function readState(file) {
  try {
    if (!existsSync(file)) return { enabled: false, webhookUrl: '', notifyOnFinish: true }
    const parsed = JSON.parse(readFileSync(file, 'utf8'))
    return {
      enabled: parsed?.enabled === true,
      webhookUrl: typeof parsed?.webhookUrl === 'string' ? parsed.webhookUrl : '',
      // Defaults ON once a webhook exists: the user configured a bot in order to be told things.
      notifyOnFinish: parsed?.notifyOnFinish !== false,
    }
  } catch {
    // A corrupt file must not take the app down over a notification setting.
    return { enabled: false, webhookUrl: '', notifyOnFinish: true }
  }
}

/**
 * @param {object} [options]
 * @param {string} [options.file]           where the setting is persisted
 * @param {string[]} [options.allowedHosts] hosts a webhook may point at (test seam)
 * @param {boolean} [options.requireHttps]  whether plain http is tolerated (test seam)
 * @param {Function} [options.fetch]        injectable fetch (test seam)
 */
export function createWechatNotifier(options = {}) {
  const file = options.file ?? dataFile('wechat.json')
  const allowedHosts = options.allowedHosts ?? [WECOM_HOST]
  const requireHttps = options.requireHttps !== false
  const timeoutMs = options.timeoutMs ?? REQUEST_TIMEOUT_MS
  const doFetch = options.fetch ?? globalThis.fetch

  const state = readState(file)

  function persist() {
    writeFileSync(file, JSON.stringify(state, null, 2) + '\n', 'utf8')
  }

  function status() {
    return {
      enabled: state.enabled,
      /** Whether a webhook has been saved — distinct from whether push is turned on. */
      configured: Boolean(state.webhookUrl),
      notifyOnFinish: state.notifyOnFinish,
      /** Masked for display; the page must never hold the full credential. */
      webhookMasked: maskWebhook(state.webhookUrl),
      configFile: file,
    }
  }

  /**
   * Change the setting. A bad URL is a RESULT, not a throw: the caller is a form that must show why.
   * Turning push on without a webhook is refused rather than silently saved as a no-op.
   */
  function configure(patch = {}) {
    if (patch.webhookUrl !== undefined) {
      const url = String(patch.webhookUrl ?? '').trim()
      if (url === '') {
        state.webhookUrl = ''
        // No webhook, no push: leaving `enabled` true with nothing to send to is a lie.
        state.enabled = false
      } else if (!isWecomWebhook(url, { allowedHosts, requireHttps })) {
        return {
          ok: false,
          error: requireHttps
            ? '机器人地址必须是企业微信的 https webhook（形如 https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=…）'
            : '机器人地址格式不正确',
        }
      } else {
        state.webhookUrl = url
      }
    }
    if (patch.enabled !== undefined) {
      state.enabled = patch.enabled === true && state.webhookUrl !== ''
    }
    if (patch.notifyOnFinish !== undefined) state.notifyOnFinish = patch.notifyOnFinish === true
    persist()
    return { ok: true, ...status() }
  }

  /**
   * Post one markdown message. Best-effort by contract: a notification that did not arrive must never
   * fail the thing it was describing, so every failure is returned as data.
   */
  async function send(text) {
    if (!state.webhookUrl) return { ok: false, error: '尚未配置企业微信机器人地址' }
    if (!state.enabled) return { ok: false, error: '微信通知未开启' }
    const content = String(text ?? '').slice(0, MAX_TEXT_CHARS)
    if (content.trim() === '') return { ok: false, error: '通知内容为空' }

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const response = await doFetch(state.webhookUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ msgtype: 'markdown', markdown: { content } }),
        signal: controller.signal,
      })
      if (!response.ok) {
        return { ok: false, status: response.status, error: `企业微信接口返回 HTTP ${response.status}` }
      }
      /**
       * WeCom answers 200 even when it refused the message, putting the real verdict in `errcode`.
       * A status-only check would report "已发送" for a message that never appeared — the exact lie
       * this module exists to avoid.
       */
      const payload = await response.json().catch(() => null)
      if (payload && payload.errcode !== undefined && payload.errcode !== 0) {
        return { ok: false, errcode: payload.errcode, error: payload.errmsg || `企业微信错误码 ${payload.errcode}` }
      }
      return { ok: true, sentAt: Date.now() }
    } catch (error) {
      const reason =
        error?.name === 'AbortError' ? '请求企业微信超时' : `无法连接企业微信：${String(error?.message ?? error)}`
      return { ok: false, error: reason }
    } finally {
      clearTimeout(timer)
    }
  }

  /** Compose a titled block and push it. `lines` may contain empty entries, which are dropped. */
  async function notify({ title = '', lines = [] } = {}) {
    const content = [title ? `**${title}**` : '', ...lines].filter((line) => String(line ?? '').trim() !== '').join('\n')
    return await send(content)
  }

  return { status, configure, send, notify, file }
}
