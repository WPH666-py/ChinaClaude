/**
 * 代码测试（qa-skills）：探测项目里有哪套测试命令，并按需跑一次。
 *
 * WHY DETECT INSTEAD OF ASK: the useful default is "run this project's own tests". Asking the user to
 * type a command turns a one-click check into a configuration chore, and a wrong guess here is cheap
 * (the command is echoed, and nothing runs until they press 运行).
 *
 * WHAT IT WILL NOT DO: no shell string interpolation of user input, no `npm install`, no watch mode.
 * A test runner that silently installs packages is a supply-chain surprise, not a test runner.
 */
import { spawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

/**
 * @param {string} cwd
 * @returns {{ ok: boolean, candidates: Array<{ id: string, label: string, command: string[], kind: string }> }}
 */
export function detectTests({ cwd } = {}) {
  const root = String(cwd ?? '')
  if (root === '' || !existsSync(root)) return { ok: false, error: '先打开一个工作目录', candidates: [] }

  const candidates = []
  const pkg = readJson(join(root, 'package.json'))
  if (pkg?.scripts && typeof pkg.scripts === 'object') {
    for (const name of ['test', 'test:unit', 'test:e2e']) {
      if (typeof pkg.scripts[name] === 'string' && pkg.scripts[name].trim() !== '') {
        candidates.push({
          id: `npm:${name}`,
          label: `npm run ${name}`,
          command: process.platform === 'win32' ? ['cmd', '/c', `npm run ${name}`] : ['npm', 'run', name],
          kind: 'node',
        })
      }
    }
  }
  if (existsSync(join(root, 'pyproject.toml')) || existsSync(join(root, 'pytest.ini')) || existsSync(join(root, 'tests'))) {
    candidates.push({ id: 'pytest', label: 'pytest', command: ['pytest', '-q'], kind: 'python' })
  }
  if (existsSync(join(root, 'go.mod'))) {
    candidates.push({ id: 'go', label: 'go test ./...', command: ['go', 'test', './...'], kind: 'go' })
  }
  if (existsSync(join(root, 'Cargo.toml'))) {
    candidates.push({ id: 'cargo', label: 'cargo test', command: ['cargo', 'test'], kind: 'rust' })
  }
  return { ok: true, cwd: root, candidates }
}

/**
 * Run one detected command with a hard timeout.
 *
 * The timeout is not decoration: `npm test` on a project with a watch-mode test script would otherwise
 * hold the bridge's request open until the app is closed.
 */
export function runTest({ cwd, command, timeoutMs = 180000 } = {}) {
  const root = String(cwd ?? '')
  const argv = Array.isArray(command) ? command.map(String) : []
  if (root === '' || argv.length === 0) return Promise.resolve({ ok: false, error: '缺少 cwd 或命令' })

  return new Promise((resolve) => {
    const started = Date.now()
    const child = spawn(argv[0], argv.slice(1), { cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    let output = ''
    const append = (chunk) => {
      output += String(chunk)
      // 只保留尾部：测试失败时的堆栈可能很长，但用户要的是最后一段。
      if (output.length > 200_000) output = output.slice(-200_000)
    }
    child.stdout?.on('data', append)
    child.stderr?.on('data', append)

    const timer = setTimeout(() => {
      try {
        child.kill()
      } catch {
        // Already gone.
      }
      resolve({ ok: false, timeout: true, output, ms: Date.now() - started, error: `超过 ${Math.round(timeoutMs / 1000)} 秒未结束，已终止` })
    }, Math.max(5000, Number(timeoutMs) || 180000))

    child.on('error', (error) => {
      clearTimeout(timer)
      resolve({ ok: false, error: `无法启动命令：${error.message}`, output })
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({ ok: code === 0, code, output, ms: Date.now() - started })
    })
  })
}
