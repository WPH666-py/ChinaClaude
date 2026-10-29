/**
 * WorkBuddy CLI 路由：请求扁平化、CLI 调用、Anthropic 形状回转、以及「未登录」这条用户能自修的失败。
 *
 * The CLI is real (the vendor ships it); this suite drives a FAKE one so it never costs a model call and
 * never depends on the machine's login state. What it pins down is the contract: what prompt the CLI is
 * given, how its stdout becomes an Anthropic message, that streaming is a well-formed SSE sequence, and
 * that "Authentication required" becomes `unauthenticated` rather than a generic failure.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { finish, makeCheck } from './harness.mjs'
import { askWorkBuddy, discoverWorkBuddyCli, flattenRequest, openCliLogin, toAnthropicResponse, toAnthropicSse, workbuddyStatus } from '../src/workbuddy.mjs'

const results = []
const check = makeCheck(results)
const workspace = mkdtempSync(join(tmpdir(), 'cccn-wb-'))

const okCli = join(workspace, 'fake-ok.mjs')
writeFileSync(okCli, `process.stdout.write(JSON.stringify({ result: '这是 CLI 的回答' }))\n`, 'utf8')
const authCli = join(workspace, 'fake-auth.mjs')
writeFileSync(authCli, `process.stderr.write('Authentication required. Please use /login')\nprocess.exit(1)\n`, 'utf8')
/**
 * The real CLI's measured behaviour: exit code 0, empty stdout, the auth sentence on stderr. A test that
 * only covers the exit-1 case would have shipped "success with an empty answer".
 */
const authExitZeroCli = join(workspace, 'fake-auth-zero.mjs')
writeFileSync(authExitZeroCli, `process.stderr.write('Authentication required. Please use /login')\n`, 'utf8')
const emptyCli = join(workspace, 'fake-empty.mjs')
writeFileSync(emptyCli, `process.stdout.write(JSON.stringify({ result: '' }))\n`, 'utf8')

try {
  {
    const flat = flattenRequest({
      system: '你是助手',
      messages: [
        { role: 'user', content: [{ type: 'text', text: '你好' }] },
        { role: 'assistant', content: [{ type: 'text', text: '你好，有什么可以帮你' }] },
        { role: 'user', content: [{ type: 'text', text: '写一句问候' }] },
      ],
    })
    check('flatten: system prompt first', flat.startsWith('System:\n你是助手'), flat.slice(0, 40))
    check('flatten: both roles present', flat.includes('User:\n你好') && flat.includes('Assistant:\n你好，有什么可以帮你'))
    check('flatten: last user turn last', flat.trimEnd().endsWith('User:\n写一句问候'), flat.slice(-30))
    check('flatten: empty request is empty', flattenRequest({}) === '')
  }

  {
    const answer = await askWorkBuddy({ prompt: '你好', cliPath: okCli })
    check('ask: ok', answer.ok === true, answer.error)
    check('ask: parses the json result field', answer.text === '这是 CLI 的回答', answer.text)
  }

  {
    const answer = await askWorkBuddy({ prompt: '你好', cliPath: authCli })
    check('ask: unauthenticated is its own code', answer.ok === false && answer.code === 'unauthenticated', JSON.stringify(answer))
    check('ask: tells the user to log in', String(answer.error).includes('/login'), answer.error)

    const exitZero = await askWorkBuddy({ prompt: '你好', cliPath: authExitZeroCli })
    check(
      'ask: exit 0 with the auth sentence is still unauthenticated',
      exitZero.ok === false && exitZero.code === 'unauthenticated',
      JSON.stringify(exitZero),
    )

    const empty = await askWorkBuddy({ prompt: '你好', cliPath: emptyCli })
    check('ask: empty answer is a failure, not a blank success', empty.ok === false && empty.code === 'empty', JSON.stringify(empty))
  }

  {
    const missing = await askWorkBuddy({ prompt: '你好', cliPath: join(workspace, 'nope.mjs') })
    check('ask: missing CLI is a failure, not a crash', missing.ok === false, JSON.stringify(missing))
    const empty = await askWorkBuddy({ prompt: '   ', cliPath: okCli })
    check('ask: empty prompt refused', empty.ok === false)
  }

  {
    const response = toAnthropicResponse({ text: '回答', model: 'deepseek-v4' })
    check('response: anthropic shape', response.type === 'message' && response.role === 'assistant' && response.content[0].text === '回答')
    check('response: keeps the model name', response.model === 'deepseek-v4')
    const sse = toAnthropicSse({ text: '回答', model: 'deepseek-v4' })
    const events = [...sse.matchAll(/^event: (.+)$/gm)].map((match) => match[1])
    check('sse: event order', events.join(',') === 'message_start,content_block_start,content_block_delta,content_block_stop,message_delta,message_stop', events.join(','))
    check('sse: carries the text delta', sse.includes('"type":"text_delta","text":"回答"'))
    check('sse: frames end with a blank line', sse.endsWith('\n\n'))
  }

  {
    const status = workbuddyStatus()
    check('status: answers', status.ok === true && typeof status.available === 'boolean')
    check('status: missing CLI has a hint', status.available ? status.cli !== null : String(status.hint).includes('CCCN_CBC_CLI'))
    check('status: reports how the CLI was found', !status.available || typeof status.source === 'string', String(status.source))
  }

  {
    // 发现逻辑：显式覆盖必须胜出且带来源，面板才能解释「为什么选了这个路径」。
    const previous = process.env.CCCN_CBC_CLI
    process.env.CCCN_CBC_CLI = okCli
    const found = discoverWorkBuddyCli({ refresh: true })
    check('discovery: env override wins and is labelled', found.cli === okCli && found.source === 'env', JSON.stringify(found))
    // 不要真弹窗口：把覆盖指向不存在的 CLI，验证「没有 CLI 时给出可执行的拒绝」。
    process.env.CCCN_CBC_CLI = join(workspace, 'no-such-cli.mjs')
    discoverWorkBuddyCli({ refresh: true })
    const login = openCliLogin()
    check('login: refuses without spawning when there is no CLI', login.ok === false && typeof login.error === 'string', JSON.stringify(login).slice(0, 100))
    process.env.CCCN_CBC_CLI = okCli
    discoverWorkBuddyCli({ refresh: true })
    if (previous === undefined) delete process.env.CCCN_CBC_CLI
    else process.env.CCCN_CBC_CLI = previous
    discoverWorkBuddyCli({ refresh: true })
  }
} catch (error) {
  check('suite ran without throwing', false, String(error?.stack ?? error))
} finally {
  rmSync(workspace, { recursive: true, force: true })
}

finish(results, 10000)
