/**
 * Connectors port: registry truthfulness + the one route that actually works.
 *
 * The interesting property is NOT "can it call an API" but "does it refuse to claim a capability it
 * does not have". Two of the three upstream plugins speak protocols `claude.exe` cannot, so the tests
 * pin down that they report `supportsChat: false` and a reason — a regression here would show a
 * user a provider that fails on the first message.
 *
 * `fetch` is stubbed: this suite never touches the network.
 */
import { finish, makeCheck } from './harness.mjs'
import {
  OPENCODE_GO,
  cliProviderRows,
  connectorById,
  connectorCatalog,
  connectorDiagnose,
  connectorList,
  connectorProviders,
  connectorProxyRefuse,
  connectorProxyStatus,
  connectorUsage,
  mergeCliProviders,
} from '../src/connectors.mjs'

const results = []
const check = makeCheck(results)

const realFetch = globalThis.fetch

function stubFetch(handler) {
  globalThis.fetch = async (url, options) => handler(String(url), options)
}

function jsonResponse(status, payload) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(payload),
  }
}

try {
  {
    const list = connectorList()
    check('registry: two connectors (trae was removed with its plugin)', list.length === 2, String(list.length))
    const go = list.find((entry) => entry.id === 'opencode-go')
    check('registry: opencode-go can carry chat', go?.supportsChat === true)
    check('registry: opencode-go is ready', go?.state === 'ready', String(go?.state))
    const wb = list.find((entry) => entry.id === 'workbuddy')
    check('registry: workbuddy does not claim chat', wb?.supportsChat === false)
    check('registry: workbuddy explains why', String(wb?.detail).includes('专有'), String(wb?.detail).slice(0, 40))
    check('registry: trae is not a connector any more', list.find((entry) => entry.id === 'trae') === undefined)
    check('registry: every connector has a docs link', list.every((entry) => String(entry.docs).startsWith('https://')))
  }

  {
    const unknown = connectorById('nope')
    check('lookup: unknown id is null', unknown === null)
  }

  {
    const refused = await connectorCatalog({ id: 'workbuddy', apiKey: 'x' })
    check('catalog: non-Anthropic connector is refused', refused.ok === false && refused.unsupported === true, refused.error)
    const noKey = await connectorCatalog({ id: 'opencode-go', apiKey: '  ' })
    check('catalog: empty key is refused', noKey.ok === false, noKey.error)
  }

  {
    let seenUrl = ''
    let seenAuth = ''
    stubFetch((url, options) => {
      seenUrl = url
      seenAuth = String(options?.headers?.authorization ?? '')
      return jsonResponse(200, { data: [{ id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash' }, 'qwen3.8-flash'] })
    })
    const answer = await connectorCatalog({ id: 'opencode-go', apiKey: 'sk-test' })
    check('catalog: ok', answer.ok === true, answer.error)
    check('catalog: reads /v1/models', seenUrl === `${OPENCODE_GO.apiBase}/models`, seenUrl)
    check('catalog: sends bearer key', seenAuth === 'Bearer sk-test', seenAuth)
    check('catalog: maps model ids', answer.models?.length === 2 && answer.models[0].id === 'deepseek-v4-flash')
    check('catalog: returns the anthropic base', answer.baseUrl === OPENCODE_GO.anthropicBase, answer.baseUrl)
  }

  {
    stubFetch(() => jsonResponse(401, { error: 'invalid key' }))
    const answer = await connectorCatalog({ id: 'opencode-go', apiKey: 'sk-bad' })
    check('catalog: 401 is explained', answer.ok === false && String(answer.error).includes('401'), answer.error)
  }

  {
    stubFetch(() => {
      throw new Error('getaddrinfo ENOTFOUND')
    })
    const answer = await connectorUsage({ id: 'opencode-go', apiKey: 'sk-test' })
    check('usage: network failure is a sentence', answer.ok === false && String(answer.error).includes('连不上'), answer.error)
  }

  {
    const refused = await connectorUsage({ id: 'workbuddy', apiKey: 'k' })
    check('usage: non-chat connector is refused with a reason', refused.ok === false && refused.unsupported === true, refused.error)
  }

  {
    const built = connectorProviders({
      id: 'opencode-go',
      apiKey: 'sk-test',
      models: [{ id: 'deepseek-v4-flash' }, { id: 'qwen3.8-flash' }],
    })
    check('apply: builds one row per model', built.ok === true && built.providers?.length === 2, built.error)
    check('apply: rows use the anthropic base', built.providers?.every((row) => row.baseUrl === OPENCODE_GO.anthropicBase))
    check('apply: rows carry the key', built.providers?.every((row) => row.apiKey === 'sk-test'))

    const noModels = connectorProviders({ id: 'opencode-go', apiKey: 'sk-test', models: [] })
    check('apply: refuses an empty catalog', noModels.ok === false, noModels.error)

    const notChat = connectorProviders({ id: 'workbuddy', apiKey: 'k', models: [{ id: 'x' }] })
    check('apply: refuses a non-chat connector', notChat.ok === false && notChat.unsupported === true)
  }

  {
    // Diagnosis is read-only: it may say "found" or "not found", but it must never echo a token value.
    check('diagnose: removed trae is refused', connectorDiagnose({ id: 'trae' }).ok === false)
    const workbuddy = connectorDiagnose({ id: 'workbuddy' })
    check('diagnose: workbuddy answers', workbuddy.ok === true && typeof workbuddy.diagnosis === 'string')
    check('diagnose: unknown id refused', connectorDiagnose({ id: 'nope' }).ok === false)
  }

  {
    // 代理骨架：路由此刻存在，但必须明确拒绝，而不是假装转发。
    const go = connectorProxyStatus({ id: 'opencode-go' })
    check('proxy: opencode-go needs no proxy', go.ok === true && go.state === 'not-needed', JSON.stringify(go.state))
    check('proxy: removed trae has no proxy', connectorProxyStatus({ id: 'trae' }).ok === false)
    const refused = connectorProxyRefuse({ id: 'trae' })
    check('proxy: POST on a removed connector is refused', refused.ok === false)
    check('proxy: opencode-go refusal says not-needed', connectorProxyRefuse({ id: 'opencode-go' }).code === 'not-needed')
    check('proxy: unknown connector refused', connectorProxyStatus({ id: 'nope' }).ok === false)
  }

  {
    // 开箱即用：模型行由运行时用真实端口拼出，用户不需要手填 URL。
    const rows = cliProviderRows({ port: 43130, workbuddyCli: 'C:\\wb\\cli.mjs' }).rows
    check('rows: one per available CLI', rows.length === 1, JSON.stringify(rows.map((row) => row.name)))
    check('rows: base urls point at this bridge', rows.every((row) => row.baseUrl.startsWith('http://127.0.0.1:43130/proxy/')), JSON.stringify(rows.map((row) => row.baseUrl)))
    check('rows: workbuddy route path', rows.some((row) => row.baseUrl.endsWith('/proxy/workbuddy')))
    check('rows: placeholder key is not a secret', rows.every((row) => row.apiKey === 'local-cli'))
    check('rows: no CLI means no rows', cliProviderRows({ port: 43130 }).rows.length === 0)

    const first = mergeCliProviders([{ name: 'keep-me', baseUrl: 'https://example.test', apiKey: 'k' }], rows)
    check('merge: adds missing rows', first.added.length === 1 && first.providers.length === 2)
    const second = mergeCliProviders(first.providers, rows)
    check('merge: idempotent on re-import', second.added.length === 0 && second.providers.length === 2, JSON.stringify(second.added))
    const edited = mergeCliProviders([{ name: 'workbuddy-default', baseUrl: 'http://127.0.0.1:9/custom', apiKey: 'mine' }], rows)
    check('merge: user edits are not overwritten', !edited.added.some((row) => row.name === 'workbuddy-default'), JSON.stringify(edited.added.map((row) => row.name)))
  }
} finally {
  globalThis.fetch = realFetch
}

finish(results)
