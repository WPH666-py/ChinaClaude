/**
 * Sends one tiny message to every model the bundled Our Free Model service publishes and prints the
 * outcome per model. Used to tell "the wiring works" apart from "the upstream free quota is spent".
 *
 * Usage: node tools/ofm-live-models.mjs <dataDir> [limit]
 */
import fs from 'node:fs'
import path from 'node:path'

const [dataDir, limitArg] = process.argv.slice(2)
if (!dataDir) {
  console.error('usage: node tools/ofm-live-models.mjs <dataDir> [limit]')
  process.exit(2)
}

const settings = JSON.parse(fs.readFileSync(path.join(dataDir, 'settings.json'), 'utf8'))
const port = Number(settings.standalonePort) || 18911
const base = `http://127.0.0.1:${port}`
const headers = { authorization: `Bearer ${settings.forwardKey}` }

const listResponse = await fetch(`${base}/v1/models`, { headers })
const list = (await listResponse.json()).data ?? []
const models = list.map((item) => item.id)
const limit = Number(limitArg) || models.length
console.log(`models=${models.length} base=${base}`)

for (const model of models.slice(0, limit)) {
  const started = Date.now()
  try {
    const response = await fetch(`${base}/v1/messages`, {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({
        model,
        max_tokens: 32,
        messages: [{ role: 'user', content: '只回复两个字：可用' }],
      }),
      signal: AbortSignal.timeout(120000),
    })
    const text = await response.text()
    const ms = Date.now() - started
    if (response.ok) {
      let answer = ''
      try {
        const body = JSON.parse(text)
        answer = (body.content ?? []).map((part) => part.text ?? '').join('').trim()
      } catch {}
      console.log(`OK    ${model} (${ms}ms) -> ${answer.slice(0, 40)}`)
    } else {
      let reason = text.slice(0, 120).replace(/\s+/g, ' ')
      try {
        const body = JSON.parse(text)
        reason = body?.error?.message ?? reason
      } catch {}
      console.log(`FAIL  ${model} (${ms}ms) HTTP ${response.status} ${reason}`)
    }
  } catch (error) {
    console.log(`FAIL  ${model} (${Date.now() - started}ms) ${error.message}`)
  }
}
