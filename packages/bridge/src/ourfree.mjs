/**
 * our-free-model 本机网关的自动发现与自动启用。
 *
 * 目标：用户只点一次「从 our-free-model 导入」，不填地址、不填 Key、不手动去 DSH 里开开关。
 *
 * 实测到的事实（dsh-our-free-model 2.6.x）：
 *   - 插件网关默认 `forward.enabled=false`，此时端口根本没人监听；
 *   - 手工改 `$DSH_HOME/our-free-model/settings.json` 不会热加载（改完 20s 仍无监听），
 *     所以必须走插件自己的管理接口：`POST /api/our-free-model/settings` body `{forward:{enabled:true}}`；
 *   - 网关鉴权用 `forwardKey`，从 `GET /api/our-free-model/forward/key` 取；
 *   - DSH 的 Web 端口每次启动都变，所以先从 `DSH NEXT.exe` 进程的监听端口里把它找出来。
 */
import { execFile } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const DEFAULT_PORTS = [18899, 18900, 18901, 18326]

function dshHome() {
  const explicit = String(process.env.DSH_HOME ?? '').trim()
  return explicit !== '' ? explicit : join(homedir(), '.dsh')
}

function readSettingsFile() {
  const files = [
    join(dshHome(), 'our-free-model', 'settings.json'),
    join(homedir(), '.our-free-model', 'settings.json'),
  ]
  for (const file of files) {
    if (!existsSync(file)) continue
    try {
      return { file, value: JSON.parse(readFileSync(file, 'utf8')) }
    } catch {
      /* 下一处 */
    }
  }
  return null
}

function run(file, args, timeoutMs = 8000) {
  return new Promise((resolve) => {
    execFile(file, args, { timeout: timeoutMs, windowsHide: true, maxBuffer: 4 * 1024 * 1024 }, (error, stdout) => {
      resolve(String(stdout ?? ''))
    })
  })
}

/** DSH 主进程的监听端口（每次启动都不同，只能现场查）。 */
async function dshListenPorts() {
  if (process.platform !== 'win32') return []
  const [tasks, netstat] = await Promise.all([run('tasklist', ['/FO', 'CSV']), run('netstat', ['-ano'])])
  const pids = new Set()
  for (const line of tasks.split(/\r?\n/)) {
    if (!line.includes('DSH NEXT.exe')) continue
    const fields = line.split('","').map((field) => field.replace(/^"|"$/g, ''))
    if (fields[1]) pids.add(fields[1].trim())
  }
  const ports = new Set()
  for (const line of netstat.split(/\r?\n/)) {
    if (!/LISTENING/i.test(line)) continue
    const parts = line.trim().split(/\s+/)
    const local = parts[1] ?? ''
    const pid = parts[parts.length - 1]
    if (!pids.has(pid)) continue
    const port = Number(local.split(':').pop())
    if (Number.isInteger(port) && port > 0) ports.add(port)
  }
  return [...ports]
}

async function json(url, init, timeoutMs = 6000) {
  const response = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) })
  const text = await response.text()
  try {
    return { ok: response.ok, status: response.status, value: JSON.parse(text) }
  } catch {
    return { ok: response.ok, status: response.status, value: null }
  }
}

async function listModels(base, forwardKey) {
  const headers = forwardKey ? { authorization: `Bearer ${forwardKey}` } : {}
  const answer = await json(`${base}/v1/models`, { headers }, 5000)
  const models = (answer.value?.data ?? []).map((entry) => String(entry?.id ?? '')).filter((id) => id !== '')
  if (models.length === 0) throw new Error('模型清单为空')
  return models
}

/** 找到 DSH 的 Web 端口，并通过插件接口把「本地转发」打开，返回网关地址与 Key。 */
async function enableViaDsh() {
  // DSH 自己把当前 Web 地址注入子进程环境；优先用它，省掉端口扫描。
  const explicit = String(process.env.DSH_WEB_URL ?? '').trim()
  const candidates = []
  if (explicit !== '') candidates.push(explicit.replace(/\/$/, ''))
  for (const port of await dshListenPorts()) candidates.push(`http://127.0.0.1:${port}`)

  for (const base of candidates) {
    const summary = await json(`${base}/api/our-free-model/summary`).catch(() => null)
    if (!summary?.ok) continue
    const forward = summary.value?.settings?.forward ?? {}
    if (forward.enabled !== true) {
      await json(`${base}/api/our-free-model/settings`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ forward: { enabled: true } }),
      }).catch(() => null)
      // 监听器是异步起的，给它一点时间。
      for (let i = 0; i < 15; i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 400))
        const after = await json(`${base}/api/our-free-model/summary`).catch(() => null)
        if (after?.value?.settings?.forward?.enabled === true) break
      }
    }
    const keyAnswer = await json(`${base}/api/our-free-model/forward/key`).catch(() => null)
    const forwardKey = String(keyAnswer?.value?.key ?? '')
    const latest = await json(`${base}/api/our-free-model/summary`).catch(() => null)
    const settings = latest?.value?.settings?.forward ?? {}
    const host = String(settings.host ?? '127.0.0.1')
    const listenPort = Number(settings.port) > 0 ? Number(settings.port) : DEFAULT_PORTS[0]
    return { dshBase: base, base: `http://${host === '0.0.0.0' ? '127.0.0.1' : host}:${listenPort}`, forwardKey }
  }
  return null
}

/** 对外主入口：探测 → 必要时自动开启 → 返回网关与模型清单。 */
export async function detectGateway() {
  const settings = readSettingsFile()
  const candidates = []
  const push = (host, port) => {
    if (!port) return
    const base = `http://${String(host).replace('0.0.0.0', '127.0.0.1')}:${port}`
    if (!candidates.includes(base)) candidates.push(base)
  }
  const envUrl = String(process.env.CCCN_OURFREE_URL ?? '').trim()
  if (envUrl !== '') candidates.push(envUrl.replace(/\/$/, ''))
  const forward = settings?.value?.forward ?? {}
  push(forward.host ?? '127.0.0.1', Number(forward.port) || DEFAULT_PORTS[0])
  for (const port of DEFAULT_PORTS) push('127.0.0.1', port)

  let forwardKey = String(settings?.value?.chanGateway?.relay?.key ?? '')
  for (const base of candidates) {
    try {
      const models = await listModels(base, forwardKey)
      return { ok: true, base, secret: forwardKey, models }
    } catch {
      /* 下一个 */
    }
  }

  // 网关没开：让 DSH 里的插件把它打开，再试一次。
  const started = await enableViaDsh().catch(() => null)
  if (started) {
    forwardKey = started.forwardKey || forwardKey
    for (let i = 0; i < 10; i += 1) {
      try {
        const models = await listModels(started.base, forwardKey)
        return { ok: true, base: started.base, secret: forwardKey, models, started: true }
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 500))
      }
    }
    return { ok: false, error: `已通过 DSH（${started.dshBase}）打开本地转发，但网关 ${started.base} 仍不可用。请查看 DSH 日志。` }
  }

  const hint = settings
    ? `插件已安装但网关未开启，且没能通过 DSH 管理接口打开（DSH 可能未运行或端口未找到）。请在 DSH → 设置 → our-free-model → 本地转发 里打开后重试。`
    : '没有找到 dsh-our-free-model（既没有配置文件，也没有可用的本机网关）。请先在 DSH 里安装该插件。'
  return { ok: false, error: hint, tried: candidates }
}
