#!/usr/bin/env node
/**
 * The bundled MCP server: Office file tools for the model that `claude.exe` runs.
 *
 * WHY A SEPARATE PROCESS (MCP) INSTEAD OF BRIDGE ENDPOINTS: the bridge already has an HTTP surface for
 * the UI, but the model can only reach what the CLI exposes as tools. MCP is the CLI's own extension
 * point, so shipping a stdio server is the only way "让模型真的去写 xlsx" can work without patching the
 * CLI. It also keeps the tool surface auditable in one file.
 *
 * WHY IT CONFINDS PATHS TO `process.cwd()`: the CLI spawns this server with the session's working
 * directory, and a model-supplied path is not a trusted input. Every path is resolved and checked
 * against the workspace root (realpath on both sides) exactly like `workbench.mjs` does — a tool that
 * can write anywhere on disk is not made safer by the model being polite.
 *
 * PROTOCOL: JSON-RPC 2.0, one JSON object per line on stdio (MCP's stdio transport). Only what this
 * server needs is implemented: initialize, tools/list, tools/call, ping, and notification silence.
 */
import { readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import { createInterface } from 'node:readline'

import { createDocx, createPptx, createXlsx, readDocx, readPptx, readXlsx, updateDocx, updatePptx, updateXlsx } from './ooxml.mjs'

const SERVER_NAME = 'cccn-office'
const SERVER_VERSION = process.env.CCCN_APP_VERSION ?? '0.0.0'
const PROTOCOL_VERSION = '2024-11-05'

/** The session workspace. `CCCN_MCP_ROOT` lets a test pin it; production uses the CLI's cwd. */
function workspaceRoot() {
  const pinned = String(process.env.CCCN_MCP_ROOT ?? '').trim()
  try {
    return realpathSync(pinned !== '' ? pinned : process.cwd())
  } catch {
    return process.cwd()
  }
}

/**
 * Resolve a tool-supplied path inside the workspace, or refuse.
 *
 * Both sides go through `realpath` so a symlink cannot be used to step outside; a file that does not
 * exist yet (the create case) is checked by resolving its parent, which is where it would be written.
 */
function insideWorkspace(target) {
  const raw = String(target ?? '').trim()
  if (raw === '') throw new Error('缺少文件路径')
  if (isAbsolute(raw)) throw new Error(`路径必须是工作区内的相对路径，收到的是：${raw}`)
  const root = workspaceRoot()
  const candidate = resolve(root, raw)
  let probe = candidate
  try {
    probe = realpathSync(candidate)
  } catch {
    // Not created yet: the closest existing ancestor is what decides where this lands.
    let parent = resolve(candidate, '..')
    for (let depth = 0; depth < 40; depth++) {
      try {
        probe = resolve(realpathSync(parent), relative(parent, candidate))
        break
      } catch {
        const up = resolve(parent, '..')
        if (up === parent) break
        parent = up
      }
    }
  }
  if (probe !== root && !probe.startsWith(root.endsWith(sep) ? root : root + sep)) {
    throw new Error('路径越出了工作区，已拒绝')
  }
  return { absolute: candidate, relative: relative(root, candidate).split(sep).join('/') }
}

function readOfficeFile(path) {
  const at = insideWorkspace(path)
  let stats
  try {
    stats = statSync(at.absolute)
  } catch {
    throw new Error(`文件不存在：${at.relative}`)
  }
  if (!stats.isFile()) throw new Error(`不是文件：${at.relative}`)
  return { buffer: readFileSync(at.absolute), at }
}

function writeOfficeFile(path, buffer) {
  const at = insideWorkspace(path)
  writeFileSync(at.absolute, buffer)
  return { at, bytes: buffer.length }
}

const TOOLS = [
  {
    name: 'word_create',
    description:
      '创建 Word (.docx)：可选标题、段落列表（支持项目符号）、以及一张表格。路径必须位于当前工作区内，overwrite 默认 false。',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '工作区内的相对路径，例如 report.docx' },
        title: { type: 'string', description: '文档标题（Heading 1）' },
        paragraphs: {
          type: 'array',
          description: '段落；字符串或 { text, bullet }',
          items: {
            oneOf: [
              { type: 'string' },
              { type: 'object', properties: { text: { type: 'string' }, bullet: { type: 'boolean' } }, required: ['text'] },
            ],
          },
        },
        table: {
          type: 'object',
          description: '一张表格：headers + rows',
          properties: {
            headers: { type: 'array', items: { type: 'string' } },
            rows: { type: 'array', items: { type: 'array', items: { type: 'string' } } },
          },
        },
        overwrite: { type: 'boolean', description: '为 true 时覆盖已存在的文件' },
      },
      required: ['path'],
    },
  },
  {
    name: 'word_read',
    description: '读取 Word (.docx) 文本；format=markdown 时保留段落结构与表格。',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        format: { type: 'string', enum: ['text', 'markdown'], description: '默认 text' },
      },
      required: ['path'],
    },
  },
  {
    name: 'word_update',
    description: '在已有 Word 文档末尾追加段落和/或表格，返回新的文件。',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        paragraphs: { type: 'array', items: { oneOf: [{ type: 'string' }, { type: 'object', properties: { text: { type: 'string' }, bullet: { type: 'boolean' } }, required: ['text'] }] } },
        table: {
          type: 'object',
          properties: { headers: { type: 'array', items: { type: 'string' } }, rows: { type: 'array', items: { type: 'array', items: { type: 'string' } } } },
        },
      },
      required: ['path'],
    },
  },
  {
    name: 'excel_create',
    description: '创建 Excel (.xlsx)：多工作表、单元格网格；以 = 开头的字符串会写成真正的公式。',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        sheets: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              name: { type: 'string' },
              rows: { type: 'array', items: { type: 'array', items: { oneOf: [{ type: 'string' }, { type: 'number' }, { type: 'boolean' }, { type: 'null' }, { type: 'object' }] } } },
            },
            required: ['name', 'rows'],
          },
        },
        overwrite: { type: 'boolean' },
      },
      required: ['path', 'sheets'],
    },
  },
  {
    name: 'excel_read',
    description: '读取 Excel (.xlsx) 的工作表与单元格；公式返回缓存值（拿不到时返回 =公式 文本）。',
    inputSchema: {
      type: 'object',
      properties: { path: { type: 'string' }, sheet: { type: 'string', description: '只读某个工作表（可选）' } },
      required: ['path'],
    },
  },
  {
    name: 'excel_update',
    description: '修改 Excel：按名称替换/新建工作表，或按 A1 地址写单元格。',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        sheets: { type: 'array', items: { type: 'object' } },
        cells: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              sheet: { type: 'string' },
              address: { type: 'string', description: '例如 B2' },
              value: { oneOf: [{ type: 'string' }, { type: 'number' }, { type: 'boolean' }, { type: 'null' }] },
              formula: { type: 'string' },
            },
            required: ['sheet', 'address'],
          },
        },
      },
      required: ['path'],
    },
  },
  {
    name: 'ppt_create',
    description: '创建 16:9 PowerPoint (.pptx)：每页一个标题 + 若干要点。',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        slides: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              title: { type: 'string' },
              bullets: { type: 'array', items: { type: 'string' } },
            },
            required: ['title'],
          },
        },
        overwrite: { type: 'boolean' },
      },
      required: ['path', 'slides'],
    },
  },
  {
    name: 'ppt_read',
    description: '读取 PowerPoint (.pptx) 的每页标题与要点。',
    inputSchema: {
      type: 'object',
      properties: { path: { type: 'string' } },
      required: ['path'],
    },
  },
  {
    name: 'ppt_update',
    description: '向已有 PowerPoint 追加幻灯片（不改动原有页、主题与母版）。',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        slides: {
          type: 'array',
          items: {
            type: 'object',
            properties: { title: { type: 'string' }, bullets: { type: 'array', items: { type: 'string' } } },
            required: ['title'],
          },
        },
      },
      required: ['path', 'slides'],
    },
  },
]

/** Text answer for the model. One place, so every tool reports success the same way. */
function textResult(text) {
  return { content: [{ type: 'text', text }] }
}

function jsonResult(value) {
  return { content: [{ type: 'text', text: JSON.stringify(value) }] }
}

async function callTool(name, args) {
  switch (name) {
    case 'word_create': {
      const target = String(args.path ?? '')
      const at = insideWorkspace(target)
      if (args.overwrite !== true) {
        try {
          statSync(at.absolute)
          throw new Error(`文件已存在：${at.relative}（overwrite=true 才覆盖）`)
        } catch (problem) {
          if (problem instanceof Error && problem.message.startsWith('文件已存在')) throw problem
        }
      }
      const buffer = createDocx({ title: args.title, paragraphs: args.paragraphs, table: args.table })
      const written = writeOfficeFile(target, buffer)
      return textResult(`已创建 ${written.at.relative}（${Math.round(written.bytes / 1024)} KB）`)
    }
    case 'word_read': {
      const { buffer, at } = readOfficeFile(args.path)
      const doc = readDocx(buffer)
      if (args.format === 'markdown') {
        const lines = []
        if (doc.title) lines.push(`# ${doc.title}`)
        for (const paragraph of doc.paragraphs) lines.push(paragraph.bullet ? `- ${paragraph.text}` : paragraph.text)
        for (const table of doc.tables) {
          lines.push('', `| ${table.headers.join(' | ')} |`, `| ${table.headers.map(() => '---').join(' | ')} |`)
          for (const row of table.rows) lines.push(`| ${row.join(' | ')} |`)
        }
        return textResult(lines.join('\n'))
      }
      const lines = []
      if (doc.title) lines.push(doc.title)
      for (const paragraph of doc.paragraphs) lines.push(paragraph.bullet ? `- ${paragraph.text}` : paragraph.text)
      return textResult(`${lines.join('\n')}\n\n（${at.relative}，${doc.tables.length} 张表）`)
    }
    case 'word_update': {
      const { buffer, at } = readOfficeFile(args.path)
      const next = updateDocx(buffer, { paragraphs: args.paragraphs, table: args.table })
      const written = writeOfficeFile(args.path, next)
      return textResult(`已更新 ${written.at.relative}（${Math.round(written.bytes / 1024)} KB，原 ${Math.round(buffer.length / 1024)} KB）`)
    }
    case 'excel_create': {
      const target = String(args.path ?? '')
      const at = insideWorkspace(target)
      if (args.overwrite !== true) {
        try {
          statSync(at.absolute)
          throw new Error(`文件已存在：${at.relative}（overwrite=true 才覆盖）`)
        } catch (problem) {
          if (problem instanceof Error && problem.message.startsWith('文件已存在')) throw problem
        }
      }
      const buffer = createXlsx({ sheets: args.sheets })
      const written = writeOfficeFile(target, buffer)
      return textResult(`已创建 ${written.at.relative}（${Math.round(written.bytes / 1024)} KB）`)
    }
    case 'excel_read': {
      const { buffer } = readOfficeFile(args.path)
      const book = readXlsx(buffer)
      const sheets = args.sheet ? book.sheets.filter((sheet) => sheet.name === args.sheet) : book.sheets
      if (sheets.length === 0) throw new Error(`没有这个工作表：${String(args.sheet)}`)
      return jsonResult({ sheets })
    }
    case 'excel_update': {
      const { buffer } = readOfficeFile(args.path)
      const next = updateXlsx(buffer, { sheets: args.sheets, cells: args.cells })
      const written = writeOfficeFile(args.path, next)
      return textResult(`已更新 ${written.at.relative}（${Math.round(written.bytes / 1024)} KB）`)
    }
    case 'ppt_create': {
      const target = String(args.path ?? '')
      const at = insideWorkspace(target)
      if (args.overwrite !== true) {
        try {
          statSync(at.absolute)
          throw new Error(`文件已存在：${at.relative}（overwrite=true 才覆盖）`)
        } catch (problem) {
          if (problem instanceof Error && problem.message.startsWith('文件已存在')) throw problem
        }
      }
      const buffer = createPptx({ slides: args.slides })
      const written = writeOfficeFile(target, buffer)
      return textResult(`已创建 ${written.at.relative}（${Math.round(written.bytes / 1024)} KB，${(args.slides ?? []).length} 页）`)
    }
    case 'ppt_read': {
      const { buffer } = readOfficeFile(args.path)
      const deck = readPptx(buffer)
      return jsonResult(deck)
    }
    case 'ppt_update': {
      const { buffer } = readOfficeFile(args.path)
      const next = updatePptx(buffer, { slides: args.slides })
      const written = writeOfficeFile(args.path, next)
      return textResult(`已追加 ${(args.slides ?? []).length} 页到 ${written.at.relative}（${Math.round(written.bytes / 1024)} KB）`)
    }
    default:
      throw new Error(`未知工具：${name}`)
  }
}

/** One JSON-RPC request → one response object, or null for notifications. */
async function handle(message) {
  const { id, method, params } = message ?? {}
  const isNotification = id === undefined || id === null

  if (method === 'initialize') {
    return {
      jsonrpc: '2.0',
      id,
      result: {
        // Echo the client's version when it names one: the CLI's client is the one that has to accept it.
        protocolVersion: params?.protocolVersion ?? PROTOCOL_VERSION,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
      },
    }
  }

  if (method === 'ping') return { jsonrpc: '2.0', id, result: {} }

  if (method === 'tools/list') {
    return { jsonrpc: '2.0', id, result: { tools: TOOLS } }
  }

  if (method === 'tools/call') {
    const name = String(params?.name ?? '')
    try {
      const result = await callTool(name, params?.arguments ?? {})
      return { jsonrpc: '2.0', id, result }
    } catch (problem) {
      return {
        jsonrpc: '2.0',
        id,
        result: {
          content: [{ type: 'text', text: `工具执行失败：${problem instanceof Error ? problem.message : String(problem)}` }],
          isError: true,
        },
      }
    }
  }

  if (isNotification) return null
  return { jsonrpc: '2.0', id, error: { code: -32601, message: `未实现的方法：${String(method)}` } }
}

/**
 * Serve stdio until the CLI closes the pipe.
 *
 * Answers are written as single lines even while requests are in flight: JSON-RPC ids make them
 * self-describing, and MCP clients dispatch by id.
 */
const rl = createInterface({ input: process.stdin })
rl.on('line', (line) => {
  const text = line.trim()
  if (text === '') return
  let message
  try {
    message = JSON.parse(text)
  } catch {
    // A malformed line cannot be traced to an id, so JSON-RPC's parse-error shape is the only correct answer.
    process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'JSON 解析失败' } })}\n`)
    return
  }
  void handle(message)
    .then((answer) => {
      if (answer) process.stdout.write(`${JSON.stringify(answer)}\n`)
    })
    .catch((problem) => {
      if (message?.id != null) {
        process.stdout.write(
          `${JSON.stringify({ jsonrpc: '2.0', id: message.id, error: { code: -32603, message: String(problem?.message ?? problem) } })}\n`,
        )
      }
    })
})

rl.on('close', () => process.exit(0))
