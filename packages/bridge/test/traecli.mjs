/**
 * TRAE CLI 路由：发现、登录状态、无头调用与未登录映射。
 *
 * The CLI is installed on this machine (`traecli 0.209.1`, user scope) but not logged in, so the suite
 * drives a FAKE `traecli.cmd` that speaks the same two commands (`login status`, `exec ... -o FILE`). That
 * keeps every assertion about OUR translation honest without spending a real login or a model call.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { finish, makeCheck } from './harness.mjs'
import { askTrae, discoverTraeCli, flattenAnthropicRequest, traeCliStatus, traeLoginStatus } from '../src/traecli.mjs'

const results = []
const check = makeCheck(results)
const workspace = mkdtempSync(join(tmpdir(), 'cccn-traecli-'))

function makeFake(name, source) {
  const script = join(workspace, `${name}.mjs`)
  writeFileSync(script, source, 'utf8')
  const shim = join(workspace, `${name}.cmd`)
  writeFileSync(shim, `@echo off\r\nnode "%~dp0${name}.mjs" %*\r\n`, 'utf8')
  return shim
}

/** Writes the last message to `-o`, prints one JSONL event, exits 0. */
const okShim = makeFake(
  'ok',
  `import { writeFileSync } from 'node:fs'
const args = process.argv.slice(2)
const at = args.indexOf('-o')
if (at >= 0) writeFileSync(args[at + 1], '这是 TRAE CLI 的回答', 'utf8')
process.stdout.write(JSON.stringify({ type: 'message', text: 'event' }) + '\\n')
`,
)

const loggedOutShim = makeFake(
  'loggedout',
  `const args = process.argv.slice(2)
if (args[0] === 'login') { process.stderr.write('Not logged in\\n'); process.exit(1) }
process.stderr.write('Not logged in\\n'); process.exit(1)
`,
)

try {
  {
    const flat = flattenAnthropicRequest({
      system: '你是助手',
      messages: [
        { role: 'user', content: [{ type: 'text', text: '你好' }] },
        { role: 'assistant', content: [{ type: 'text', text: '你好' }] },
        { role: 'user', content: [{ type: 'text', text: '继续' }] },
      ],
    })
    check('flatten: keeps both roles', flat.includes('User:\n你好') && flat.includes('Assistant:\n你好'), flat.slice(0, 40))
    check('flatten: last turn is last', flat.trimEnd().endsWith('User:\n继续'))
  }

  {
    const answer = await askTrae({ prompt: '你好', cliPath: okShim })
    check('ask: reads the last-message file', answer.ok === true && answer.text === '这是 TRAE CLI 的回答', JSON.stringify(answer).slice(0, 120))
  }

  {
    const answer = await askTrae({ prompt: '你好', cliPath: loggedOutShim })
    check('ask: not logged in maps to unauthenticated', answer.ok === false && answer.code === 'unauthenticated', JSON.stringify(answer))
    check('ask: login hint is actionable', String(answer.error).includes('traecli login'), answer.error)

    const login = await traeLoginStatus({ cliPath: loggedOutShim })
    check('login status: reports not logged in', login.available === true && login.loggedIn === false, JSON.stringify(login))

    const missing = await askTrae({ prompt: '你好', cliPath: join(workspace, 'nope.cmd') })
    check('ask: missing CLI is a failure', missing.ok === false, JSON.stringify(missing))
    const empty = await askTrae({ prompt: '  ', cliPath: okShim })
    check('ask: empty prompt refused', empty.ok === false)
  }

  {
    // Discovery is machine-dependent (installed here, maybe not elsewhere); assert the SHAPE and that a
    // missing CLI does not pretend to be available.
    const found = discoverTraeCli({ refresh: true })
    check('discovery: shape', typeof found.cli === 'string' || found.cli === null)
    const status = traeCliStatus()
    check('status: available matches discovery', status.available === (found.cli !== null))
    check('status: missing CLI points at the official installer', status.available || String(status.hint).includes('install_v2.ps1'))
  }
} catch (error) {
  check('suite ran without throwing', false, String(error?.stack ?? error))
} finally {
  rmSync(workspace, { recursive: true, force: true })
}

finish(results, 12000)
