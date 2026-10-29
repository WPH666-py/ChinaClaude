/**
 * Probes the standalone Our Free Model gateway: reads its settings file, tries the candidate keys
 * against /v1/models and (optionally) /v1/messages, and prints only counts and status codes.
 *
 * Usage: node tools/probe-ofm-gateway.mjs <baseUrl> <dataDir> [model]
 */
import fs from 'node:fs'
import path from 'node:path'

const [baseUrl = 'http://127.0.0.1:18901', dataDir, modelArg] = process.argv.slice(2)
if (!dataDir) {
  console.error('usage: node tools/probe-ofm-gateway.mjs <baseUrl> <dataDir> [model]')
  process.exit(2)
}

const settingsPath = path.join(dataDir, 'settings.json')
const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'))
const fieldNames = Object.keys(settings).filter(name => /key/i.test(name))
console.log('settings keys:', fieldNames.join(', '))

const candidates = fieldNames
  .map(name => [name, settings[name]])
  .filter(([, value]) => typeof value === 'string' && value.length > 8)

async function call(url, init) {
  const response = await fetch(url, init)
  const text = await response.text()
  return { status: response.status, text }
}

for (const [name, value] of candidates) {
  const result = await call(`${baseUrl}/v1/models`, { headers: { authorization: `Bearer ${value}` } })
  let count = -1
  let first = []
  try {
    const body = JSON.parse(result.text)
    const list = body.data ?? body.models ?? []
    count = list.length
    first = list.slice(0, 5).map(item => item.id ?? item.name)
  } catch {}
  console.log(`${name}: status=${result.status} models=${count} ${first.join(', ')}`)
  if (result.status !== 200) continue

  if (modelArg) {
    const body = {
      model: modelArg,
      max_tokens: 64,
      messages: [{ role: 'user', content: 'Reply with exactly: OK' }],
    }
    const answer = await call(`${baseUrl}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${value}` },
      body: JSON.stringify(body),
    })
    const snippet = answer.text.slice(0, 300).replace(/\s+/g, ' ')
    console.log(`  messages(${modelArg}): status=${answer.status} body=${snippet}`)
  }
  break
}
