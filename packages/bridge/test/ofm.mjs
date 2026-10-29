/**
 * 随包的 Our Free Model 本地服务（packages/bridge/src/ofm.mjs）。
 *
 * 这一套跑的是真进程：桥用随包的 node 拉起 vendor/ofm-runtime 里的独立服务，然后按它自己写的
 * 访问口令拉 `/v1/models`。证明的是「点一下导入」在没有任何 DSH 的环境里也能成立——
 * 这正是插件那条路做不到的地方（管理接口对外 401、改配置文件又不热加载）。
 *
 * 不证明的：上游免费通道的配额。这里只核对清单形状；真调用可能被服务商以 429 拒绝。
 */
import { existsSync } from 'node:fs'
import { join } from 'node:path'

const { finish, makeCheck } = await import('./harness.mjs')
const ofm = await import('../src/ofm.mjs')

const results = []
const check = makeCheck(results)

try {
  {
    const status = ofm.ofmStatus()
    const runtime = status.runtime
    check('runtime: entry resolved', Boolean(runtime), String(runtime))
    check('runtime: entry exists on disk', Boolean(runtime && existsSync(runtime)), String(runtime))
    check('status: not running before first use', status.running === false, JSON.stringify(status))
    check('status: data dir under LOCALAPPDATA or temp', /ChinaClaude|ofm/i.test(status.dataDir), status.dataDir)
  }

  const first = await ofm.detectBundled()
  if (!first.ok) {
    check('start: bundled service starts', false, first.error)
  } else {
    check('start: bundled service starts', true)
    check('start: base is a loopback URL', /^http:\/\/127\.0\.0\.1:\d+$/.test(first.base), first.base)
    check('start: reports started (not reused)', first.started === true, JSON.stringify(first).slice(0, 120))
    check('models: non-empty list', Array.isArray(first.models) && first.models.length > 0, String(first.models?.length))
    check('models: ids are plain strings', first.models.every((id) => typeof id === 'string' && id.length > 0 && !id.includes(' ')))
    check(
      'models: contains a free channel',
      first.models.some((id) => id.endsWith('-free')),
      first.models.slice(0, 5).join(', ')
    )
    check('token: not echoed with the base', typeof first.secret === 'string' && !first.base.includes(first.secret))

    const second = await ofm.detectBundled()
    check('reuse: second call succeeds', second.ok === true, second.error)
    check('reuse: same base', second.base === first.base, `${second.base} vs ${first.base}`)
    check('reuse: flagged as reused', second.reused === true, JSON.stringify(second).slice(0, 120))
    check('reuse: same model count', second.models?.length === first.models.length)

    const health = ofm.ofmStatus()
    check('status: running after start', health.running === true, JSON.stringify(health))
    check('status: base reported', health.base === first.base, String(health.base))

    // 鉴权必须真的生效：拿错误的凭据应当被拒。
    const denied = await fetch(`${first.base}/v1/models`, { headers: { authorization: 'Bearer not-the-key' } })
    check('auth: wrong credential is rejected', denied.status === 401 || denied.status === 403, `HTTP ${denied.status}`)
  }

  ofm.stopBundled()
} catch (error) {
  check('suite: no unexpected throw', false, error?.stack ?? String(error))
} finally {
  ofm.stopBundled()
}

finish(results)
