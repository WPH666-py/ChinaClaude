/**
 * Trae 接入（MCP 方向）：配置片段必须是可粘贴、可撤销的，而不是我们替用户写进编辑器配置。
 *
 * The machine-dependent parts (whether Trae's settings file exists, what the workspace-MCP switch is set
 * to) are reported, not asserted; the deterministic parts (the snippet's shape, the steps, the explicit
 * limit that this is the OPPOSITE direction from a model proxy) are pinned here.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { finish, makeCheck } from './harness.mjs'
import { traeMcpIntegration } from '../src/trae.mjs'

const results = []
const check = makeCheck(results)
const workspace = mkdtempSync(join(tmpdir(), 'cccn-trae-'))

try {
  {
    const entry = join(workspace, 'mcp.mjs')
    writeFileSync(entry, '// stand-in for the MCP server\n', 'utf8')

    const info = traeMcpIntegration({ nodePath: 'C:\\node\\node.exe', entryPath: entry })
    check('integration: ok', info.ok === true)
    check('integration: direction is trae-as-client', info.direction === 'trae-as-mcp-client')
    check('integration: server entry reported', info.serverEntry === entry, String(info.serverEntry))
    const server = info.snippet?.mcpServers?.['cccn-office']
    check('snippet: uses the injected node path', server?.command === 'C:\\node\\node.exe', JSON.stringify(server?.command))
    check('snippet: runs the MCP entry', Array.isArray(server?.args) && server.args[0] === entry, JSON.stringify(server?.args))
    check('snippet: workspace placeholder is explicit', String(server?.env?.CCCN_MCP_ROOT).includes('<'), JSON.stringify(server?.env))
    check('integration: three paste steps', Array.isArray(info.steps) && info.steps.length === 3)
    check('integration: states the limitation', String(info.limits).includes('不是') && String(info.limits).includes('/api/connectors/proxy'))
    check('integration: settings state is a fact or null', info.workspaceMcpEnabled === null || typeof info.workspaceMcpEnabled === 'boolean')
    check('integration: settings path is masked', info.settingsPath === null || !String(info.settingsPath).includes('C:\\Users'), String(info.settingsPath))
  }

  {
    const missing = traeMcpIntegration({ nodePath: 'C:\\node\\node.exe', entryPath: join(workspace, 'nope.mjs') })
    check('integration: missing entry yields no snippet', missing.ok === true && missing.snippet === null)
  }
} catch (error) {
  check('suite ran without throwing', false, String(error?.stack ?? error))
} finally {
  rmSync(workspace, { recursive: true, force: true })
}

finish(results, 8000)
