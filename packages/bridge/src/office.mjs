/**
 * 办公工具（dsh-office-tools 的移植）：状态查询。
 *
 * WHY THIS IS A STATUS MODULE AND NOT A TOOL IMPLEMENTATION: the tools themselves live in `mcp.mjs`,
 * which the CLI spawns as a child process. The bridge cannot call them directly — it can only say
 * whether the installation handed the CLI a usable MCP config, and what the tool surface is. Reporting
 * "已内置" without that distinction would repeat the mistake of promising a capability that only works
 * when a second process starts correctly.
 */
import { existsSync, readFileSync } from 'node:fs'

/** Mirrors the `name` fields in `mcp.mjs`; `test/office.mjs` asserts the two lists stay equal. */
export const OFFICE_TOOL_NAMES = [
  'word_create',
  'word_read',
  'word_update',
  'excel_create',
  'excel_read',
  'excel_update',
  'ppt_create',
  'ppt_read',
  'ppt_update',
]

/** One line per tool, enough for the panel to explain what the model can now do. */
export const OFFICE_TOOL_SUMMARY = {
  word_create: '创建 .docx：标题、段落（含项目符号）、一张表格',
  word_read: '读取 .docx：纯文本或 Markdown（保留段落与表格）',
  word_update: '在 .docx 末尾追加段落 / 表格',
  excel_create: '创建 .xlsx：多工作表、单元格网格、以 = 开头的真公式',
  excel_read: '读取 .xlsx：工作表与单元格，公式给缓存值',
  excel_update: '修改 .xlsx：按名称替换工作表，或按 A1 地址写单元格',
  ppt_create: '创建 16:9 .pptx：每页标题 + 要点',
  ppt_read: '读取 .pptx：每页标题与要点',
  ppt_update: '向 .pptx 追加幻灯片（保留原有页与母版）',
}

/**
 * What this installation can honestly claim about Office tools.
 *
 * `enabled` means the bridge wrote an MCP config AND the entry file exists — not that a session has
 * loaded it. The panel says so in those words; `sessionsLoaded` (when a session reports its init frame)
 * is the only proof of the latter, and it is per session, not a setting.
 */
export function officeStatus() {
  const configPath = String(process.env.CCCN_MCP_CONFIG ?? '').trim()
  const configExists = configPath !== '' && existsSync(configPath)

  let server = null
  let configError = null
  if (configExists) {
    try {
      const parsed = JSON.parse(readFileSync(configPath, 'utf8'))
      server = parsed?.mcpServers?.['cccn-office'] ?? null
    } catch (error) {
      configError = `MCP 配置无法解析：${String(error?.message ?? error)}`
    }
  }

  return {
    ok: true,
    enabled: configExists && server !== null,
    configPath: configExists ? configPath : null,
    configError,
    server: server
      ? {
          name: 'cccn-office',
          command: String(server.command ?? ''),
          args: Array.isArray(server.args) ? server.args : [],
        }
      : null,
    tools: OFFICE_TOOL_NAMES.map((name) => ({ name, summary: OFFICE_TOOL_SUMMARY[name] ?? '' })),
    hint: configExists
      ? '在对话里直接让模型「新建一个 report.docx / budget.xlsx」，它会调用这些工具；文件写在工作区内。'
      : '这个安装没有随包携带 MCP 服务（旧版 sidecar 或缺文件），Office 工具不可用。',
  }
}
