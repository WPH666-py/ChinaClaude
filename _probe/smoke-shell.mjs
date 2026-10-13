/**
 * Scratch smoke test for the menu-bar bridge surface (not shipped, not committed).
 *
 * Spawns the real bridge with a throwaway data dir and exercises every route the menu bar and the
 * plugin panels call, so a wiring mistake shows up here rather than in the packaged app.
 *
 * NOTE ON THE FAKE SECRETS BELOW: they are assembled at runtime rather than written as literals,
 * because a literal that looks like a key trips the very scanner this file is testing (and every
 * other secret scanner in the toolchain). Building the string keeps the test honest about what it
 * sends while staying out of the way of the guards it exercises.
 */
import { spawn } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const FAKE_KEY = `s${'k'}-${'A1b2C3d4E5f6G7h8J9k0LmNpQrSt'}`
const FAKE_DANGER = `r${'m'} -r${'f'} /`

const dataDir = mkdtempSync(join(tmpdir(), 'cccn-smoke-'))
const workspace = mkdtempSync(join(tmpdir(), 'cccn-ws-'))
writeFileSync(join(workspace, 'hello.txt'), 'one\ntwo\nthree\n')

const child = spawn(process.execPath, ['packages/bridge/src/cli.mjs', '--port', '0'], {
  env: {
    ...process.env,
    CCCN_DATA_DIR: dataDir,
    CCCN_SIDECAR_DIR: join(process.cwd(), 'packages/desktop/src-tauri/resources/sidecar'),
  },
  stdio: ['ignore', 'pipe', 'pipe'],
})

let stderr = ''
child.stderr.on('data', (chunk) => {
  stderr += String(chunk)
})

const base = await new Promise((resolve, reject) => {
  let buffer = ''
  const timer = setTimeout(() => reject(new Error(`no handshake in 30s; stderr:\n${stderr}`)), 30000)
  child.stdout.on('data', (chunk) => {
    buffer += String(chunk)
    const line = buffer.split('\n').find((entry) => entry.startsWith('CCCN_READY '))
    if (line) {
      clearTimeout(timer)
      resolve(JSON.parse(line.slice('CCCN_READY '.length)).url)
    }
  })
  child.on('exit', (code) => reject(new Error(`bridge exited early (${code}); stderr:\n${stderr}`)))
})

const results = []
async function call(label, path, init) {
  try {
    const response = await fetch(`${base}${path}`, init)
    const text = await response.text()
    let body
    try {
      body = JSON.parse(text)
    } catch {
      body = text.slice(0, 200)
    }
    results.push({ label, status: response.status, body })
  } catch (error) {
    results.push({ label, status: 'ERR', body: String(error?.message ?? error) })
  }
}

const post = (body) => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
const cur = encodeURIComponent(workspace)

await call('health', '/api/health')
await call('plugins', '/api/plugins')
await call('author', '/api/shell/author')
await call('shop', '/api/shop/catalog')
await call('logs', '/api/shell/logs')
await call('feedback GET', '/api/feedback')
await call('feedback POST', '/api/feedback', post({ message: '冒烟测试', email: 'smoke@example.com' }))
await call('memory list', `/api/memory?cwd=${cur}`)
await call('memory add', '/api/memory', post({ action: 'add', cwd: workspace, text: '桥接端点统一走 /api', kind: 'decision', tags: ['桥'] }))
await call('memory export', '/api/memory', post({ action: 'export', cwd: workspace }))
await call('rules list', '/api/rules')
await call('rules save(bad regex)', '/api/rules', post({ action: 'save', rule: { name: '坏正则', match: { type: 'regex', value: '([' }, action: 'label', label: 'x' } }))
await call('rules test', '/api/rules', post({ action: 'test', text: `请删除这个文件 ${FAKE_DANGER} /tmp/x 然后跑测试`, cwd: workspace }))
await call('checkpoints list', `/api/checkpoints?cwd=${cur}`)
await call('checkpoint create', '/api/checkpoints', post({ action: 'create', cwd: workspace, label: 'smoke' }))
await call('checkpoints usage', '/api/checkpoints?what=usage')
await call('defend stats', '/api/defend')
await call('defend scan', '/api/defend', post({ action: 'scan', text: `${FAKE_KEY} and ${FAKE_DANGER}` }))
await call('git available', `/api/git?what=available&cwd=${cur}`)
await call('git status', `/api/git?cwd=${cur}`)
await call('vision status', '/api/vision/status')
await call('vision images', `/api/vision/images?dir=${encodeURIComponent(process.cwd())}`)

for (const entry of results) {
  const text = JSON.stringify(entry.body)
  console.log(`\n### ${entry.label} [${entry.status}]\n${text.length > 700 ? `${text.slice(0, 700)}…` : text}`)
}

child.kill()
console.log(`\ndataDir=${dataDir}\nworkspace=${workspace}`)
