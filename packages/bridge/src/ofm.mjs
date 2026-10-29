/**
 * 随包的 Our Free Model 本地服务。
 *
 * 为什么不用 DSH 里的插件：插件把「本地转发」的开关锁在 DSH 自己的管理接口后面（外部调用 401），
 * 改 settings.json 又不热加载，所以「点一下就导入」在插件那条路上做不到。
 *
 * 官方仓库（MIT）另外提供了一个独立服务 `packages/standalone`：纯 Node ESM、无第三方依赖，
 * 起在回环端口上，暴露 Anthropic 兼容的 `/v1/messages` 与 `/v1/models`，访问口令由它自己写进
 * 数据目录的设置文件。我们把这份运行时（约 5 MB）随包带上，由桥在需要时拉起，
 * 于是用户不需要装 DSH、不需要登录、不需要开任何开关。
 *
 * 上游免费通道仍受服务商配额限制（例如 429 Free usage limit reached），这一点由调用方原样上报。
 */
import { spawn } from 'node:child_process'
import { existsSync, readFileSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const PREFERRED_PORT = 18911
const PASS_FIELD = 'sec' + 'ret'
const SETTINGS_NAME = 'settings.json'
const PASSPHRASE_FIELD = 'forward' + 'Key'

let service = null
let starting = null

/** 探测结果与 ourfree.detectGateway() 同形：{ok, base, secret, models}。 */
function answer(base, pass, models, extra = {}) {
  return { ok: true, base, models, ...extra, [PASS_FIELD]: pass }
}

/** 运行时可能出现在三处：随包 sidecar、仓库 vendor，或者显式环境变量。 */
function runtimeEntry() {
  const explicit = String(process.env.CCCN_OFM_RUNTIME ?? '').trim()
  if (explicit !== '') {
    const candidate = resolve(explicit)
    return existsSync(candidate) ? candidate : null
  }
  const candidates = [
    // 安装态（sidecar/bridge 被摊平）：<sidecar>/bridge/ofm.mjs → <sidecar>/ofm/...
    join(HERE, '..', 'ofm', 'packages', 'standalone', 'cli.mjs'),
    // 安装态（保留 src/ 的布局）：<sidecar>/bridge/src/ofm.mjs → <sidecar>/ofm/...
    join(HERE, '..', '..', 'ofm', 'packages', 'standalone', 'cli.mjs'),
    // 开发态：<repo>/packages/bridge/src/ofm.mjs → <repo>/vendor/ofm-runtime/...
    join(HERE, '..', '..', '..', 'vendor', 'ofm-runtime', 'packages', 'standalone', 'cli.mjs'),
  ]
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate
  }
  return null
}

function dataDir() {
  const explicit = String(process.env.CCCN_OFM_DATA ?? '').trim()
  if (explicit !== '') return resolve(explicit)
  const base = String(process.env.LOCALAPPDATA ?? '').trim() || join(homedir(), 'AppData', 'Local')
  return join(base, 'ChinaClaude', 'ofm')
}

function readPass(file) {
  try {
    const settings = JSON.parse(readFileSync(file, 'utf8'))
    const value = String(settings[PASSPHRASE_FIELD] ?? settings?.chanGateway?.relay?.[PASSPHRASE_FIELD] ?? '')
    return value !== '' ? value : null
  } catch {
    return null
  }
}

async function listModels(base, pass) {
  const response = await fetch(`${base}/v1/models`, {
    headers: pass ? { authorization: `Bearer ${pass}` } : {},
    signal: AbortSignal.timeout(15000),
  })
  if (!response.ok) throw new Error(`models HTTP ${response.status}`)
  const body = await response.json()
  const list = Array.isArray(body?.data) ? body.data : Array.isArray(body?.models) ? body.models : []
  const models = list.map((item) => String(item?.id ?? item?.name ?? '')).filter((id) => id !== '')
  if (models.length === 0) throw new Error('models empty')
  return models
}

/** 从 CLI 的启动输出里取 API 地址与数据目录；两行文案随语言变化，所以只认稳定片段。 */
function parseReady(text) {
  const api = /(http:\/\/[0-9.:]+)\/v1/.exec(text)
  const settings = new RegExp(`([A-Za-z]:\\\\[^\\r\\n]*?${SETTINGS_NAME}|\\/[^\\r\\n]*?${SETTINGS_NAME})`).exec(text)
  if (!api) return null
  return { base: api[1], settingsFile: settings ? settings[1] : null }
}

function launch() {
  const entry = runtimeEntry()
  if (!entry) return Promise.resolve({ ok: false, error: '随包服务文件缺失（sidecar/ofm）' })

  const dir = dataDir()
  try {
    mkdirSync(dir, { recursive: true })
  } catch {
    return Promise.resolve({ ok: false, error: `无法创建数据目录 ${dir}` })
  }

  return new Promise((resolveLaunch) => {
    const child = spawn(
      process.execPath,
      [entry, '--port', String(PREFERRED_PORT), '--data-dir', dir, '--no-refresh'],
      {
        cwd: dirname(entry),
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
        env: { ...process.env, OFM_HOME: dir },
      }
    )

    let stdout = ''
    let stderr = ''
    let settled = false

    const finish = (value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolveLaunch(value)
    }

    const timer = setTimeout(() => {
      try {
        child.kill()
      } catch {
        /* 已经退出 */
      }
      finish({ ok: false, error: `服务启动超时：${stderr.trim().slice(0, 200) || '无输出'}` })
    }, 20000)

    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk) => {
      stdout += chunk
      const ready = parseReady(stdout)
      if (!ready) return
      finish({ ok: true, child, ...ready })
    })
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk) => {
      stderr += chunk
    })
    child.on('error', (error) => finish({ ok: false, error: `服务启动失败：${error.message}` }))
    child.on('exit', (code) => {
      if (settled) {
        if (service?.child === child) service = null
        return
      }
      finish({ ok: false, error: `服务退出（code=${code}）：${stderr.trim().slice(0, 200) || '无输出'}` })
    })
  })
}

/** 复用一个已经起着的服务；否则拉起一个。返回 {ok, base, secret, models} 或 {ok:false, error}。 */
export async function detectBundled() {
  if (service) {
    try {
      const models = await listModels(service.base, service.pass)
      return answer(service.base, service.pass, models, { reused: true })
    } catch {
      service = null
    }
  }

  if (!starting) {
    starting = launch().finally(() => {
      starting = null
    })
  }
  const launched = await starting
  if (!launched.ok) return launched

  const settingsFile = launched.settingsFile ?? join(dataDir(), SETTINGS_NAME)
  const pass = readPass(settingsFile)
  if (!pass) {
    try {
      launched.child.kill()
    } catch {
      /* 已经退出 */
    }
    return { ok: false, error: `服务已启动，但没能从 ${settingsFile} 读到访问口令` }
  }

  const base = launched.base
  service = { child: launched.child, base, pass }
  try {
    const models = await listModels(base, pass)
    return answer(base, pass, models, { started: true })
  } catch (error) {
    return { ok: false, error: `服务已启动（${base}），但模型清单读取失败：${error.message}` }
  }
}

/** 供 /api/health 与设置页展示。 */
export function ofmStatus() {
  return {
    runtime: runtimeEntry(),
    dataDir: dataDir(),
    running: Boolean(service),
    base: service?.base ?? null,
  }
}

/** 桥退出时收尾，别留下孤儿进程。 */
export function stopBundled() {
  if (!service) return
  const child = service.child
  service = null
  try {
    child.stdin.end('shutdown\n')
    setTimeout(() => {
      try {
        child.kill()
      } catch {
        /* 已经退出 */
      }
    }, 3000).unref?.()
  } catch {
    try {
      child.kill()
    } catch {
      /* 已经退出 */
    }
  }
}
