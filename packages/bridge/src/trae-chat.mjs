/**
 * Trae 直连对话：用本机解密出的登录态调用 `llm_utils_chat`。
 *
 * PORTED FROM `dsh-connect-trae` 4.0.1 (`src/protocol.ts` / identity headers). The wire facts this relies on:
 *   POST {host}/api/agent/v3/llm_utils_chat
 *   body  { messages:[{role, content:[{type:'text',text}]}], model, function, stream:true, request_id, session_id }
 *   ids   the chat endpoint only accepts a model's `config_name`, not its display name
 *   identity headers come from the desktop storage (machine id / device id), never a fresh random per request
 *
 * The model→function ownership is per model (`glm-5.3` lives under `solo_work_remote`, most others under
 * `solo_work_lite`), so callers pass it explicitly; `traeChat` retries the other functions on `4001` rather
 * than pretending one function covers the whole roster.
 */
import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { homedir, hostname, release } from 'node:os'
import { join } from 'node:path'

const CHAT_PATH = '/api/agent/v3/llm_utils_chat'
// MEASURED on this account: only chat_v3 has a roster (6 configs); the solo_* functions answer 2001.
const FUNCTIONS = ['chat_v3', 'solo_work_lite', 'solo_work_remote', 'solo_agent_remote']

function storageCandidates() {
  const roaming = process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming')
  return [
    join(roaming, 'Trae CN', 'User', 'globalStorage', 'storage.json'),
    join(roaming, 'TRAE SOLO CN', 'User', 'globalStorage', 'storage.json'),
    join(roaming, 'Trae', 'User', 'globalStorage', 'storage.json'),
  ].filter((path) => path !== '')
}

/** Desktop identity headers, read from the same storage.json the token comes from. */
export function readTraeIdentity() {
  for (const file of storageCandidates()) {
    if (!existsSync(file)) continue
    try {
      const storage = JSON.parse(readFileSync(file, 'utf8'))
      const machineId = String(storage['telemetry.machineId'] ?? '').trim()
      const deviceId = String(storage['telemetry.devDeviceId'] ?? storage['telemetry.machineId'] ?? '').trim()
      if (machineId === '' && deviceId === '') continue
      const version = String(storage['iCubeLastVersion'] ?? '3.4.4')
      const versionCode = version.replace(/\D/g, '').slice(0, 6) || '1'
      return {
        ok: true,
        appVersion: version,
        versionCode,
        headers: {
          'x-machine-id': machineId || deviceId,
          'x-device-id': deviceId || machineId,
          'x-device-type': process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'mac' : process.platform,
          'x-os-version': release(),
          'x-app-version': String(storage['icube.lastVersion'] ?? '3.4.4'),
          'x-ide-version': String(storage['icube.lastVersion'] ?? '3.4.4'),
          'x-ide-version-type': 'stable',
        },
        hostname: hostname(),
        file,
      }
    } catch {
      /* 下一份候选 */
    }
  }
  return { ok: false, headers: {}, hostname: hostname(), file: null }
}

function parseSseText(raw) {
  /**
   * Trae 的流不是 OpenAI 形状：文本在 `event: output` 的 `data.response` 里（增量），
   * `event: done` 只带 finish_reason。按帧解析，而不是按行猜字段。
   */
  let text = ''
  let reasoning = ''
  let error = null
  for (const frame of String(raw).split(/\r?\n\r?\n/)) {
    const lineEvent = /event:\s*(\S+)/.exec(frame)?.[1] ?? ''
    const dataLine = /data:\s*([\s\S]*)$/.exec(frame)?.[1] ?? ''
    if (dataLine === '') continue
    let payload = null
    try {
      payload = JSON.parse(dataLine)
    } catch {
      continue
    }
    if (lineEvent === 'output') {
      if (typeof payload.response === 'string') text += payload.response
      if (typeof payload.reasoning_content === 'string') reasoning += payload.reasoning_content
    } else if (lineEvent === 'error' || payload?.code) {
      if (payload?.code) error = { code: String(payload.code), message: String(payload.message ?? '') }
    } else if (lineEvent === 'done') {
      break
    }
  }
  return { text, reasoning, error }
}


export async function traeChat({ auth, identity, messages, model, maxTokens, timeoutMs = 180000 } = {}) {
  if (!auth?.token) return { ok: false, code: 'unauthenticated', error: '没有可用的 Trae 登录态' }
  if (!Array.isArray(messages) || messages.length === 0) return { ok: false, error: '请求里没有可发送的消息' }
  const host = String(auth.host ?? 'https://api.trae.cn').replace(/\/$/, '')
  const id = identity?.ok ? identity : readTraeIdentity()
  const body = {
    messages: messages.map((message) => ({ role: message.role, content: [{ type: 'text', text: String(message.text ?? '') }] })),
    // prepareSoloBody 里 model 与 config_name 同时下发；只给 model 会被当成补丁任务。
    model: String(model ?? ''),
    config_name: String(model ?? ''),
    function: FUNCTIONS[0],
    stream: true,
    request_id: randomUUID(),
    session_id: randomUUID(),
    ...(maxTokens ? { max_tokens: maxTokens } : {}),
  }

  let lastError = null
  for (const fn of FUNCTIONS) {
    try {
      const response = await fetch(`${host}${CHAT_PATH}`, {
        method: 'POST',
        headers: {
          // TRANSCRIBED FROM dsh-connect-trae 4.0.1 (`buildTraeHeaders`): the agent gateway does NOT accept
          // `Bearer` — it wants `Cloud-IDE-JWT <token>` plus `X-Ide-Token`, the plugin channel and an app id.
          Authorization: `Cloud-IDE-JWT ${auth.token}`,
          'X-Ide-Token': auth.token,
          'x-plugin-channel': 'icube-ai',
          'x-app-id': '6eefa01c-1036-4c7e-9ca5-d891f63bfcd8',
          'User-Agent': `Trae/${id.appVersion ?? '3.4.4'}`,
          'x-app-version-code': id.versionCode ?? '1',
          'x-ide-version-code': id.versionCode ?? '1',
          'x-custom-trace-id': randomUUID().replaceAll('-', '').slice(0, 32),
          'content-type': 'application/json',
          accept: 'text/event-stream',
          ...(id.headers ?? {}),
        },
        body: JSON.stringify({ ...body, function: fn }),
        signal: AbortSignal.timeout(timeoutMs),
      })
      const text = await response.text()
      if (!response.ok) {
        lastError = { code: String(response.status), error: `Trae 返回 HTTP ${response.status}：${text.slice(0, 200)}` }
        continue
      }
      // 4001 = 这个 function 不服务该模型，换下一个；其它错误直接报出。
      if (/"code"\s*:\s*4001/.test(text)) {
        lastError = { code: '4001', error: `模型 ${body.model} 不在 function ${fn} 的清单里` }
        continue
      }
      const parsed = parseSseText(text)
      if (parsed.error) {
        lastError = { code: parsed.error.code, error: `Trae ${parsed.error.code}: ${parsed.error.message}` }
        continue
      }
      if (parsed.text === '') {
        lastError = { code: 'empty', error: `Trae 流里没有文本：${text.slice(0, 200)}` }
        continue
      }
      return { ok: true, text: parsed.text, reasoning: parsed.reasoning, function: fn, model: body.model }
    } catch (error) {
      lastError = { code: 'network', error: String(error?.message ?? error) }
    }
  }
  return { ok: false, ...(lastError ?? { code: 'failed', error: 'Trae 调用失败' }) }
}

/** 本账号在某个 function 下真正可用的模型（config_name）。get_detail_param 是唯一权威来源。 */
export async function traeDirectConfigs({ auth, identity, fn = 'chat_v3' } = {}) {
  if (!auth?.token) return { ok: false, error: '没有可用的 Trae 登录态' }
  const id = identity?.ok ? identity : readTraeIdentity()
  const base = 'https://trae-api-cn.mchost.guru'
  const headers = {
    Authorization: `Cloud-IDE-JWT ${auth.token}`,
    'X-Ide-Token': auth.token,
    'x-plugin-channel': 'icube-ai',
    'x-app-id': '6eefa01c-1036-4c7e-9ca5-d891f63bfcd8',
    'User-Agent': `Trae/${id.appVersion ?? '3.4.4'}`,
    'x-app-version-code': id.versionCode ?? '1',
    'x-ide-version-code': id.versionCode ?? '1',
    'content-type': 'application/json',
    accept: 'application/json',
    ...(id.headers ?? {}),
  }
  try {
    const response = await fetch(`${base}/api/ide/v1/get_detail_param`, { method: 'POST', headers, body: JSON.stringify({ function: fn }), signal: AbortSignal.timeout(30000) })
    const payload = await response.json().catch(() => null)
    const list = Array.isArray(payload?.config_info_list) ? payload.config_info_list : []
    return { ok: true, function: fn, configs: list.map((entry) => ({ config: String(entry.config_name ?? ''), context: entry.context_window_tokens ?? null })).filter((entry) => entry.config !== '') }
  } catch (error) {
    return { ok: false, error: String(error?.message ?? error) }
  }
}