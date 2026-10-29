/**
 * Office tools: does this installation actually expose them to the model?
 *
 * The interesting assertion is the parity one — `office.mjs` keeps its own list of tool names for the
 * panel, and that list must not drift from the server's actual surface. Importing `mcp.mjs` would start
 * a stdio server (it blocks on stdin), so the server's list is read from its SOURCE instead.
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { finish, makeCheck } from './harness.mjs'
import { OFFICE_TOOL_NAMES, OFFICE_TOOL_SUMMARY, officeStatus } from '../src/office.mjs'

const results = []
const check = makeCheck(results)

const here = dirname(fileURLToPath(import.meta.url))
const serverSource = readFileSync(join(here, '..', 'src', 'mcp.mjs'), 'utf8')

try {
  {
    const declared = [...serverSource.matchAll(/\n\s{4}name: '([a-z_]+)',/g)].map((match) => match[1])
    const unique = [...new Set(declared)].filter((name) => name !== 'cccn-office')
    check('parity: mcp.mjs declares nine tools', unique.length === 9, unique.join(','))
    check(
      'parity: office.mjs lists the same names',
      unique.sort().join(',') === [...OFFICE_TOOL_NAMES].sort().join(','),
      `${unique.sort().join(',')} vs ${[...OFFICE_TOOL_NAMES].sort().join(',')}`,
    )
    check('parity: every tool has a summary', OFFICE_TOOL_NAMES.every((name) => String(OFFICE_TOOL_SUMMARY[name] ?? '') !== ''))
  }

  {
    const saved = process.env.CCCN_MCP_CONFIG
    delete process.env.CCCN_MCP_CONFIG
    const off = officeStatus()
    check('status: disabled when no config is exported', off.ok === true && off.enabled === false, String(off.configPath))
    check('status: says why', String(off.hint).includes('不可用'), off.hint)
    if (saved !== undefined) process.env.CCCN_MCP_CONFIG = saved
  }

  {
    // Point at the config the bridge writes for THIS checkout: the dev bridge hands the CLI the same file.
    const previous = process.env.CCCN_MCP_CONFIG
    process.env.CCCN_MCP_CONFIG = join(here, 'fixtures-office-mcp.json')
    const missing = officeStatus()
    check('status: a missing config file is not enabled', missing.enabled === false)
    if (previous === undefined) delete process.env.CCCN_MCP_CONFIG
    else process.env.CCCN_MCP_CONFIG = previous
  }
} catch (error) {
  check('suite ran without throwing', false, String(error?.stack ?? error))
}

finish(results)
