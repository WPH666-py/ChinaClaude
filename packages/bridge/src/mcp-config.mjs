/**
 * The `--mcp-config` file that tells `claude.exe` about the bundled Office tools.
 *
 * WHY A FILE RATHER THAN ARGUMENTS: the CLI takes MCP servers only as a JSON config (inline JSON or a
 * path). A file under the data root is inspectable when a tool does not show up — the first question in
 * that situation is "what did the CLI actually receive", and an argv string cannot answer it.
 *
 * WHY THE PATHS ARE ABSOLUTE AND WRITTEN HERE: the command has to be the runtime the app ships (a user
 * machine has no `node` on PATH) and the entry has to be the sidecar copy, not the checkout. Both are
 * only known at bridge start-up.
 */
import { existsSync } from 'node:fs'
import { writeFileSync } from 'node:fs'

import { dataSubFile } from './paths.mjs'

/**
 * A config file whose MCP server is pinned to ONE workspace.
 *
 * WHY PER SESSION: an MCP server is spawned with `process.cwd()` as its only idea of "the workspace",
 * and that depends on how the CLI happens to start it. Pinning the root in the server's own environment
 * removes the guess — a tool then confines paths to the session the user actually opened, and two
 * sessions in different projects cannot write into each other's trees.
 */
export function sessionMcpConfig(cwd) {
  const node = String(process.env.CCCN_MCP_NODE ?? '')
  const entry = String(process.env.CCCN_MCP_ENTRY ?? '')
  const root = String(cwd ?? '').trim()
  if (root === '' || node === '' || entry === '' || !existsSync(entry)) return null

  // One small file per workspace; the hash keeps the name stable so repeated sessions reuse it.
  let hash = 0
  for (const char of root) hash = (hash * 31 + char.charCodeAt(0)) >>> 0
  try {
    const file = dataSubFile('mcp', `session-${hash.toString(16)}.json`)
    const config = {
      mcpServers: {
        'cccn-office': {
          command: node,
          args: [entry],
          env: {
            CCCN_APP_VERSION: process.env.CCCN_APP_VERSION ?? '',
            CCCN_MCP_ROOT: root,
          },
        },
      },
    }
    writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`, 'utf8')
    return file
  } catch {
    // Falling back to "no Office tools in this session" beats failing the session itself.
    return null
  }
}

/**
 * Write the config and return its path, or null when this installation has no MCP server to offer.
 *
 * A null return is not an error: an older sidecar without `mcp.mjs` should leave sessions exactly as
 * they were instead of handing the CLI a config that points at a missing file.
 */
export function ensureMcpConfig({ nodePath, entryPath } = {}) {
  const node = String(nodePath ?? '')
  const entry = String(entryPath ?? '')
  if (node === '' || entry === '' || !existsSync(node) || !existsSync(entry)) return null

  try {
    const file = dataSubFile('mcp', 'office.json')
    const config = {
      mcpServers: {
        'cccn-office': {
          // `command` is executed by the CLI with no shell, so a path containing spaces is fine and must
          // NOT be quoted — quotes would become part of the executable name.
          command: node,
          args: [entry],
          env: {
            CCCN_APP_VERSION: process.env.CCCN_APP_VERSION ?? '',
          },
        },
      },
    }
    writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`, 'utf8')
    return file
  } catch {
    // A read-only or full disk must not stop the app from starting: without the config the Office tools
    // are simply absent, which `officeStatus()` reports as "未启用" instead of a crash.
    return null
  }
}
