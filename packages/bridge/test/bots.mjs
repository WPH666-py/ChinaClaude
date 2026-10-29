/**
 * IM 机器人：轮询、白名单、绑定偏移与失败退避。
 *
 * `fetch` is stubbed throughout — the suites must not call Telegram or a homeserver. What IS proven is
 * everything that would silently misbehave in production: an offset that does not advance (every restart
 * replays old messages), a whitelist that is not enforced, a token that leaks into a response, and a
 * failed poll that does not record why.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dataRoot = mkdtempSync(join(tmpdir(), 'cccn-bots-'))
process.env.CCCN_DATA_DIR = dataRoot

const { finish, makeCheck } = await import('./harness.mjs')
const bots = await import('../src/bots.mjs')

const results = []
const check = makeCheck(results)
const realFetch = globalThis.fetch
const calls = []

function stub(handler) {
  globalThis.fetch = async (url, options) => {
    calls.push({ url: String(url), options })
    return handler(String(url), options)
  }
}

const json = (status, payload) => ({ ok: status >= 200 && status < 300, status, json: async () => payload, text: async () => JSON.stringify(payload) })

try {
  {
    const list = bots.botList()
    check('registry: two channels, named', list.channels.length === 2 && list.channels.map((c) => c.id).join(',') === 'telegram,matrix')
    check('registry: unsupported channels are named', list.unsupported.length === 1 && String(list.unsupported[0].name).includes('QQ'))
    check('save: unknown channel refused', bots.botSave({ channel: 'qq', token: 'x' }).ok === false)
    check('save: empty token refused', bots.botSave({ channel: 'telegram', token: ' ' }).ok === false)
    check('save: matrix requires https', bots.botSave({ channel: 'matrix', token: 't', homeserver: 'http://x' }).ok === false)
  }

  let telegramId = ''
  {
    const saved = bots.botSave({ channel: 'telegram', token: '123:SECRET-TOKEN', label: '测试机器人', allowedChats: ['42'] })
    check('save: telegram accepted', saved.ok === true, saved.error)
    telegramId = saved.bot.id
    check('mask: token never returned', !JSON.stringify(saved.bot).includes('SECRET-TOKEN'), JSON.stringify(saved.bot.tokenMask))
    check('mask: prefix and tail only', saved.bot.tokenMask === '123:…EN', saved.bot.tokenMask)
  }

  {
    // Rejected chat: the bot must not run the handler, and it must say so in the chat.
    let handlerCalled = 0
    bots.setBotHandler(async () => {
      handlerCalled += 1
      return '已收到'
    })
    stub((url) => {
      if (url.includes('getUpdates')) {
        return json(200, {
          ok: true,
          result: [
            { update_id: 100, message: { chat: { id: 42 }, text: '你好' } },
            { update_id: 101, message: { chat: { id: 99 }, text: '我是陌生人' } },
          ],
        })
      }
      return json(200, { ok: true })
    })
    const polled = await bots.pollTelegramOnce({ id: telegramId })
    check('poll: ok', polled.ok === true, polled.error)
    check('poll: allowlisted chat handled', polled.handled.some((entry) => entry.chatId === '42' && entry.accepted === true))
    check('poll: stranger refused', polled.handled.some((entry) => entry.chatId === '99' && entry.accepted === false))
    check('poll: handler only ran for the allowed chat', handlerCalled === 1, String(handlerCalled))
    check('poll: a refusal was sent to the stranger', calls.some((call) => call.url.includes('sendMessage')))

    // A second poll must not replay: the persisted offset is update_id + 1.
    calls.length = 0
    stub(() => json(200, { ok: true, result: [] }))
    await bots.pollTelegramOnce({ id: telegramId })
    const body = JSON.parse(calls.find((call) => call.url.includes('getUpdates'))?.options?.body ?? '{}')
    check('poll: offset advanced past handled updates', body.offset === 102, JSON.stringify(body))
  }

  {
    stub(() => json(401, { ok: false, description: 'Unauthorized' }))
    const failed = await bots.pollTelegramOnce({ id: telegramId })
    check('poll: 401 is a sentence', failed.ok === false && String(failed.error).includes('Unauthorized'), failed.error)
  }

  {
    const bound = bots.botBind({ id: telegramId, chat: '42', sessionId: 'sess-1' })
    check('bind: stores chat → session', bound.ok === true && bound.bindings['42'] === 'sess-1', JSON.stringify(bound))
  }

  let matrixId = ''
  {
    const saved = bots.botSave({ channel: 'matrix', token: 'mat-token', homeserver: 'https://matrix.example.org' })
    check('save: matrix accepted', saved.ok === true, saved.error)
    matrixId = saved.bot.id

    stub((url) => {
      if (url.includes('/sync')) {
        return json(200, {
          next_batch: 'batch-2',
          rooms: { join: { '!room:example.org': { timeline: { events: [{ type: 'm.room.message', content: { body: '群里好' } }] } } } },
        })
      }
      return json(200, { event_id: '$x' })
    })
    const polled = await bots.pollMatrixOnce({ id: matrixId })
    check('matrix: sync ok', polled.ok === true, polled.error)
    check('matrix: room message handled', polled.handled.some((entry) => entry.roomId === '!room:example.org'))
    check('matrix: reply was PUT', calls.some((call) => call.url.includes('/send/m.room.message/')))
    check('matrix: since token persisted', (await bots.pollMatrixOnce({ id: matrixId })).ok === true)
    const syncCall = calls.filter((call) => call.url.includes('/sync')).pop()
    check('matrix: next poll uses since', String(syncCall?.url).includes('since=batch-2'), String(syncCall?.url))
  }

  {
    stub(() => json(200, { ok: true, result: [] }))
    const started = bots.startBot({ id: telegramId })
    check('start: reports running', started.ok === true)
    check('start: status lists it', bots.botStatus().running.includes(telegramId))
    const stopped = bots.stopBot({ id: telegramId })
    check('stop: removes it', stopped.ok === true && !bots.botStatus().running.includes(telegramId))
  }
} catch (error) {
  check('suite ran without throwing', false, String(error?.stack ?? error))
} finally {
  globalThis.fetch = realFetch
  rmSync(dataRoot, { recursive: true, force: true })
}

finish(results, 12000)
