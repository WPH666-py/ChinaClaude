/**
 * IM 机器人长连接（`dsh-im` 的机器人部分）：Telegram 长轮询、Matrix sync，以及聊天与会话的绑定。
 *
 * WHY LONG POLLING AND NOT A WEBHOOK: a desktop app has no public address, so a webhook cannot reach it.
 * Telegram's `getUpdates` and Matrix's `/sync` are the two official channels that work behind NAT with
 * plain HTTPS — no SDK, no inbound port, no tunnel.
 *
 * WHY ONLY THESE TWO: WeChat and QQ bots require their vendors' SDKs and app review; claiming them here
 * would be a lie. `BOT_CHANNELS` names what exists, and the panel lists the rest as unsupported.
 *
 * WHY BINDING IS EXPLICIT: a chat is tied to ONE session, and that binding is stored with the bot. A
 * group message must not silently continue whatever session happened to run last — that is how private
 * context leaks into a group.
 */
import { readFileSync, writeFileSync } from 'node:fs'

import { dataFile } from './paths.mjs'

const POLL_TIMEOUT_MS = 25000
const RETRY_BASE_MS = 2000
const RETRY_MAX_MS = 60000

export const BOT_CHANNELS = [
  {
    id: 'telegram',
    name: 'Telegram 机器人',
    fields: ['token'],
    docs: 'https://core.telegram.org/bots/api',
    hint: '在 @BotFather 创建机器人，粘贴 Bot Token；仅允许白名单聊天使用。',
  },
  {
    id: 'matrix',
    name: 'Matrix 机器人',
    fields: ['homeserver', 'token'],
    docs: 'https://spec.matrix.org/latest/client-server-api/',
    hint: '填入 homeserver（https://…）与访问令牌；机器人只能看到自己被邀请的房间。',
  },
]

export const BOT_NOT_SUPPORTED = [
  { name: '微信 / 企业微信 / QQ', reason: '需要官方 SDK、应用审核与回调地址，桌面端无法只靠 HTTPS 长轮询接入' },
]

function storeFile() {
  return dataFile('im-bots.json')
}

function readStore() {
  try {
    const parsed = JSON.parse(readFileSync(storeFile(), 'utf8'))
    return parsed && typeof parsed === 'object' && parsed.bots ? parsed : { bots: [], offset: 0, since: null }
  } catch {
    return { bots: [], offset: 0, since: null }
  }
}

function writeStore(store) {
  writeFileSync(storeFile(), `${JSON.stringify(store, null, 2)}\n`, 'utf8')
}

function mask(token) {
  const text = String(token ?? '')
  if (text === '') return ''
  return `${text.slice(0, 4)}…${text.slice(-2)}`
}

/** Public state: tokens masked, running flag from the in-process registry. */
export function botList() {
  const store = readStore()
  return {
    ok: true,
    channels: BOT_CHANNELS,
    unsupported: BOT_NOT_SUPPORTED,
    bots: store.bots.map((bot) => ({
      id: bot.id,
      channel: bot.channel,
      label: bot.label,
      homeserver: bot.homeserver ?? null,
      tokenMask: mask(bot.token),
      allowedChats: bot.allowedChats ?? [],
      workspace: bot.workspace ?? null,
      sessionId: bot.sessionId ?? null,
      running: running.has(bot.id),
      lastError: bot.lastError ?? null,
      lastMessageAt: bot.lastMessageAt ?? null,
    })),
  }
}

export function botSave({ id, channel, token, homeserver, label, allowedChats, workspace } = {}) {
  const spec = BOT_CHANNELS.find((entry) => entry.id === channel)
  if (!spec) return { ok: false, error: `未知渠道：${String(channel)}` }
  const secret = String(token ?? '').trim()
  if (secret === '') return { ok: false, error: '请填写 Token' }
  const server = String(homeserver ?? '').trim()
  if (channel === 'matrix') {
    if (!/^https:\/\//.test(server)) return { ok: false, error: 'homeserver 必须是 https 地址' }
  }

  const store = readStore()
  const at = id ? store.bots.findIndex((bot) => bot.id === id) : -1
  const record = {
    id: at >= 0 ? store.bots[at].id : `bot-${Date.now().toString(36)}`,
    channel,
    label: String(label ?? '').trim() || spec.name,
    token: secret,
    homeserver: channel === 'matrix' ? server : null,
    allowedChats: (Array.isArray(allowedChats) ? allowedChats : []).map((entry) => String(entry).trim()).filter(Boolean),
    workspace: String(workspace ?? '').trim() || null,
    sessionId: at >= 0 ? store.bots[at].sessionId ?? null : null,
  }
  if (at >= 0) store.bots[at] = record
  else store.bots.push(record)
  writeStore(store)
  return { ok: true, bot: botList().bots.find((bot) => bot.id === record.id) }
}

export function botRemove({ id } = {}) {
  stopBot({ id })
  const store = readStore()
  const next = store.bots.filter((bot) => bot.id !== id)
  if (next.length === store.bots.length) return { ok: false, error: '没有这个机器人' }
  store.bots = next
  writeStore(store)
  return { ok: true }
}

/** Bind a chat to a session (or clear it with an empty value). */
export function botBind({ id, chat, sessionId } = {}) {
  const store = readStore()
  const bot = store.bots.find((entry) => entry.id === id)
  if (!bot) return { ok: false, error: '没有这个机器人' }
  const chatId = String(chat ?? '').trim()
  if (chatId === '') return { ok: false, error: '请填写聊天 ID' }
  bot.bindings = { ...(bot.bindings ?? {}), [chatId]: String(sessionId ?? '').trim() || null }
  if (String(sessionId ?? '').trim() !== '') bot.sessionId = String(sessionId).trim()
  writeStore(store)
  return { ok: true, bindings: bot.bindings }
}

function allowed(bot, chatId) {
  return (bot.allowedChats ?? []).length === 0 || bot.allowedChats.includes(String(chatId))
}

/** Injected by the bridge: `(bot, chatId, text) => Promise<string|null>` returns a reply to send back. */
let handler = null
export function setBotHandler(fn) {
  handler = typeof fn === 'function' ? fn : null
}

/** One Telegram poll. Exported so a test can drive a single cycle without starting timers. */
export async function pollTelegramOnce({ id } = {}) {
  const store = readStore()
  const bot = store.bots.find((entry) => entry.id === id)
  if (!bot || bot.channel !== 'telegram') return { ok: false, error: '没有这个 Telegram 机器人' }

  const response = await fetch(`https://api.telegram.org/bot${bot.token}/getUpdates`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ offset: Number(store.offset) || 0, timeout: 0, allowed_updates: ['message'] }),
    signal: AbortSignal.timeout(POLL_TIMEOUT_MS),
  })
  const payload = await response.json().catch(() => null)
  if (!response.ok || payload?.ok === false) {
    return { ok: false, error: `Telegram 拒绝轮询：${payload?.description ?? `HTTP ${response.status}`}` }
  }

  const updates = Array.isArray(payload?.result) ? payload.result : []
  const handled = []
  for (const update of updates) {
    store.offset = Math.max(Number(store.offset) || 0, Number(update.update_id) + 1)
    const message = update.message
    if (!message?.text) continue
    const chatId = String(message.chat?.id ?? '')
    if (!allowed(bot, chatId)) {
      await sendTelegram(bot, chatId, '这个聊天不在白名单里。')
      handled.push({ chatId, accepted: false })
      continue
    }
    const reply = handler ? await handler(bot, chatId, message.text) : null
    if (reply) await sendTelegram(bot, chatId, reply)
    handled.push({ chatId, accepted: true })
  }
  store.bots.find((entry) => entry.id === id).lastMessageAt = handled.length > 0 ? Date.now() : bot.lastMessageAt ?? null
  writeStore(store)
  return { ok: true, handled }
}

async function sendTelegram(bot, chatId, text) {
  try {
    await fetch(`https://api.telegram.org/bot${bot.token}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text }),
      signal: AbortSignal.timeout(POLL_TIMEOUT_MS),
    })
    return true
  } catch {
    return false
  }
}

/** One Matrix `/sync` pass. Returns the events it consumed and persists the next `since` token. */
export async function pollMatrixOnce({ id } = {}) {
  const store = readStore()
  const bot = store.bots.find((entry) => entry.id === id)
  if (!bot || bot.channel !== 'matrix') return { ok: false, error: '没有这个 Matrix 机器人' }

  const query = new URLSearchParams({ timeout: '0' })
  if (store.since) query.set('since', String(store.since))
  const response = await fetch(`${bot.homeserver}/_matrix/client/v3/sync?${query.toString()}`, {
    headers: { authorization: `Bearer ${bot.token}` },
    signal: AbortSignal.timeout(POLL_TIMEOUT_MS),
  })
  const payload = await response.json().catch(() => null)
  if (!response.ok) return { ok: false, error: `Matrix sync 失败：HTTP ${response.status}` }

  const handled = []
  for (const [roomId, room] of Object.entries(payload?.rooms?.join ?? {})) {
    for (const event of room?.timeline?.events ?? []) {
      if (event?.type !== 'm.room.message' || typeof event.content?.body !== 'string') continue
      if (!allowed(bot, roomId)) continue
      const reply = handler ? await handler(bot, roomId, event.content.body) : null
      if (reply) await sendMatrix(bot, roomId, reply)
      handled.push({ roomId, accepted: true })
    }
  }
  if (typeof payload?.next_batch === 'string') {
    store.since = payload.next_batch
    writeStore(store)
  }
  return { ok: true, handled }
}

async function sendMatrix(bot, roomId, text) {
  const transaction = `cccn-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  try {
    await fetch(
      `${bot.homeserver}/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/send/m.room.message/${transaction}`,
      {
        method: 'PUT',
        headers: { authorization: `Bearer ${bot.token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ msgtype: 'm.text', body: text }),
        signal: AbortSignal.timeout(POLL_TIMEOUT_MS),
      },
    )
    return true
  } catch {
    return false
  }
}

/** Running loops, by bot id. Process-local on purpose: a restart must not resume a stale poller. */
const running = new Map()

export function botStatus() {
  return { ok: true, running: [...running.keys()] }
}

/**
 * Start the poll loop. Backoff is exponential up to a minute: a revoked token must not turn into a
 * request-per-second hot loop against the vendor's API.
 */
export function startBot({ id } = {}) {
  const bot = readStore().bots.find((entry) => entry.id === id)
  if (!bot) return { ok: false, error: '没有这个机器人' }
  if (running.has(id)) return { ok: true, already: true }

  const controller = new AbortController()
  running.set(id, controller)
  let delay = RETRY_BASE_MS

  const loop = async () => {
    while (!controller.signal.aborted) {
      let result
      try {
        result = bot.channel === 'telegram' ? await pollTelegramOnce({ id }) : await pollMatrixOnce({ id })
      } catch (error) {
        result = { ok: false, error: String(error?.message ?? error) }
      }
      const store = readStore()
      const record = store.bots.find((entry) => entry.id === id)
      if (record) {
        record.lastError = result.ok ? null : result.error
        writeStore(store)
      }
      if (result.ok) {
        delay = RETRY_BASE_MS
      } else {
        delay = Math.min(delay * 2, RETRY_MAX_MS)
      }
      await new Promise((resolve) => setTimeout(resolve, delay))
    }
  }
  void loop()
  return { ok: true, running: true }
}

export function stopBot({ id } = {}) {
  const controller = running.get(id)
  if (!controller) return { ok: true, already: true }
  controller.abort()
  running.delete(id)
  return { ok: true }
}
