/**
 * MCP server: protocol shape and the Office tools it exposes.
 *
 * WHY THIS SUITE TALKS THE REAL PROTOCOL OVER stdio: the failure that matters here is not "the function
 * computes X" — it is "the CLI asks for tools and gets nothing", which only shows up when the server is
 * started the way the CLI starts it (a child process, JSON-RPC lines on stdin/stdout). The tools' file
 * format is covered separately by `ooxml.mjs`; this suite checks that the surface and the confinement
 * hold end to end.
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { finish, makeCheck } from './harness.mjs'

const results = []
const check = makeCheck(results)

const here = dirname(fileURLToPath(import.meta.url))
const server = join(here, '..', 'src', 'mcp.mjs')
const workspace = mkdtempSync(join(tmpdir(), 'cccn-mcp-'))

const child = spawn(process.execPath, [server], {
  cwd: workspace,
  // `CCCN_MCP_ROOT` pins the workspace: in production the CLI's cwd is the session's directory, and this
  // suite must not write into the checkout it runs from.
  env: { ...process.env, CCCN_MCP_ROOT: workspace },
  stdio: ['pipe', 'pipe', 'pipe'],
  windowsHide: true,
})

let nextId = 1
const pending = new Map()
let buffer = ''

child.stdout.setEncoding('utf8')
child.stdout.on('data', (chunk) => {
  buffer += chunk
  let index = buffer.indexOf('\n')
  while (index >= 0) {
    const line = buffer.slice(0, index).trim()
    buffer = buffer.slice(index + 1)
    if (line !== '') {
      try {
        const message = JSON.parse(line)
        const waiter = pending.get(message.id)
        if (waiter) {
          pending.delete(message.id)
          waiter(message)
        }
      } catch {
        // A non-JSON line is a protocol bug; the request timeout will report it.
      }
    }
    index = buffer.indexOf('\n')
  }
})

function request(method, params, timeoutMs = 8000) {
  const id = nextId++
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id)
      reject(new Error(`${method} 超时`))
    }, timeoutMs)
    pending.set(id, (message) => {
      clearTimeout(timer)
      resolve(message)
    })
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
  })
}

try {
  {
    const answer = await request('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'cccn-test', version: '0' } })
    check('initialize: answers the protocol version', answer.result?.protocolVersion === '2024-11-05', JSON.stringify(answer.result ?? answer.error))
    check('initialize: names the server', answer.result?.serverInfo?.name === 'cccn-office', String(answer.result?.serverInfo?.name))
    check('initialize: declares the tools capability', answer.result?.capabilities?.tools !== undefined)
  }

  {
    const answer = await request('tools/list', {})
    const names = (answer.result?.tools ?? []).map((tool) => tool.name).sort()
    check('tools/list: nine tools', names.length === 9, names.join(','))
    check(
      'tools/list: word + excel + ppt families',
      names.filter((name) => name.startsWith('word_')).length === 3 &&
        names.filter((name) => name.startsWith('excel_')).length === 3 &&
        names.filter((name) => name.startsWith('ppt_')).length === 3,
      names.join(','),
    )
    const tool = (answer.result?.tools ?? []).find((entry) => entry.name === 'word_create')
    check('tools/list: schema requires path', (tool?.inputSchema?.required ?? []).includes('path'))
  }

  {
    const created = await request('tools/call', {
      name: 'word_create',
      arguments: { path: 'report.docx', title: '季度报告', paragraphs: ['第一段', { text: '要点一', bullet: true }] },
    })
    const text = created.result?.content?.[0]?.text ?? ''
    check('word_create: reports success', created.result?.isError !== true, text)
    check('word_create: writes into the workspace', existsSync(join(workspace, 'report.docx')))

    const read = await request('tools/call', { name: 'word_read', arguments: { path: 'report.docx', format: 'markdown' } })
    const body = read.result?.content?.[0]?.text ?? ''
    check('word_read: sees the title', body.includes('季度报告'), body.slice(0, 80))
    check('word_read: sees the bullet', body.includes('- 要点一'), body.slice(0, 120))

    const again = await request('tools/call', { name: 'word_create', arguments: { path: 'report.docx', title: 'x' } })
    check('word_create: refuses to overwrite by default', again.result?.isError === true, again.result?.content?.[0]?.text)
  }

  {
    const created = await request('tools/call', {
      name: 'excel_create',
      arguments: {
        path: 'budget.xlsx',
        sheets: [
          { name: '总表', rows: [['项目', '金额'], ['差旅', 1200], ['合计', { formula: 'SUM(B2:B2)', value: 1200 }]] },
          { name: '明细', rows: [['a', 1]] },
        ],
      },
    })
    check('excel_create: reports success', created.result?.isError !== true, created.result?.content?.[0]?.text)
    const read = await request('tools/call', { name: 'excel_read', arguments: { path: 'budget.xlsx' } })
    const payload = JSON.parse(read.result?.content?.[0]?.text ?? '{}')
    check('excel_read: both sheets', (payload.sheets ?? []).length === 2, JSON.stringify((payload.sheets ?? []).map((sheet) => sheet.name)))
    const cell = payload.sheets?.[0]?.rows?.[1]?.[1]
    check('excel_read: number survives', cell?.value === 1200, JSON.stringify(cell))
    const formula = payload.sheets?.[0]?.rows?.[2]?.[1]
    check('excel_read: formula is reported', String(formula?.formula ?? '').includes('SUM'), JSON.stringify(formula))
  }

  {
    const created = await request('tools/call', {
      name: 'ppt_create',
      arguments: { path: 'deck.pptx', slides: [{ title: '封面', bullets: ['一', '二'] }, { title: '第二页' }] },
    })
    check('ppt_create: reports success', created.result?.isError !== true, created.result?.content?.[0]?.text)
    check('ppt_create: writes the file', existsSync(join(workspace, 'deck.pptx')))
    const read = await request('tools/call', { name: 'ppt_read', arguments: { path: 'deck.pptx' } })
    const deck = JSON.parse(read.result?.content?.[0]?.text ?? '{}')
    check('ppt_read: two slides', (deck.slides ?? []).length === 2, JSON.stringify(deck.slides))
    check('ppt_read: title and bullets', deck.slides?.[0]?.title === '封面' && (deck.slides?.[0]?.bullets ?? []).length === 2)

    const appended = await request('tools/call', { name: 'ppt_update', arguments: { path: 'deck.pptx', slides: [{ title: '第三页', bullets: ['新'] }] } })
    check('ppt_update: reports success', appended.result?.isError !== true, appended.result?.content?.[0]?.text)
    const after = await request('tools/call', { name: 'ppt_read', arguments: { path: 'deck.pptx' } })
    const grown = JSON.parse(after.result?.content?.[0]?.text ?? '{}')
    check('ppt_update: keeps old slides and appends', (grown.slides ?? []).length === 3 && grown.slides?.[2]?.title === '第三页', JSON.stringify(grown.slides?.map((slide) => slide.title)))
  }

  {
    const escape = await request('tools/call', { name: 'word_create', arguments: { path: '../escape.docx' } })
    check('confinement: .. is refused', escape.result?.isError === true, escape.result?.content?.[0]?.text)
    const absolute = await request('tools/call', { name: 'word_create', arguments: { path: 'C:\\Windows\\x.docx' } })
    check('confinement: absolute path refused', absolute.result?.isError === true)
    check('confinement: nothing written outside', !existsSync(join(workspace, '..', 'escape.docx')))
  }

  {
    const unknown = await request('tools/call', { name: 'nope', arguments: {} })
    check('unknown tool is an error result', unknown.result?.isError === true)
    const bogus = await request('does/not/exist', {})
    check('unknown method is a JSON-RPC error', bogus.error?.code === -32601, JSON.stringify(bogus.error))
  }
} catch (error) {
  check('suite ran without throwing', false, String(error?.stack ?? error))
} finally {
  child.kill()
  setTimeout(() => rmSync(workspace, { recursive: true, force: true }), 200).unref?.()
}

finish(results, 8000)
