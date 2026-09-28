#!/usr/bin/env node
/**
 * Bridge entry point.
 *
 * Prints a single machine-readable handshake line on stdout once listening, so the Tauri
 * shell can learn the effective port without guessing (port 0 = let the OS choose):
 *
 *   CCCN_READY {"port":43130,"url":"http://127.0.0.1:43130"}
 *
 * Credentials come from the environment (CCCN_AUTH_TOKEN) or --token, never from argv in
 * normal use, because argv is visible to other processes on the machine.
 */
import { createBridgeServer } from './server.mjs'
import { findBinary, createScanner } from './discovery.mjs'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

function parseArgs(argv) {
  const options = {
    port: Number(process.env.CCCN_PORT ?? 0) || 0,
    host: process.env.CCCN_HOST ?? '127.0.0.1',
    baseUrl: process.env.CCCN_BASE_URL ?? undefined,
    authToken: process.env.CCCN_AUTH_TOKEN ?? undefined,
    model: process.env.CCCN_MODEL ?? undefined,
    permissionMode: process.env.CCCN_PERMISSION_MODE ?? undefined,
    binary: process.env.CCCN_CLAUDE_BINARY ?? undefined,
    help: false,
  }

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    const next = () => argv[++i]
    switch (arg) {
      case '--port': options.port = Number(next()); break
      case '--host': options.host = next(); break
      case '--base-url': options.baseUrl = next(); break
      case '--token': options.authToken = next(); break
      case '--model': options.model = next(); break
      case '--permission-mode': options.permissionMode = next(); break
      case '--claude': options.binary = next(); break
      case '-h':
      case '--help': options.help = true; break
      default:
        if (arg.startsWith('--')) {
          process.stderr.write(`unknown option: ${arg}\n`)
          process.exit(2)
        }
    }
  }
  return options
}

const HELP = `claude-code-cn bridge

Usage: node src/cli.mjs [options]

  --port <n>               listen port; 0 (default) lets the OS choose
  --host <addr>            bind address (default 127.0.0.1)
  --base-url <url>         Anthropic-compatible endpoint
  --token <token>          relay bearer token (prefer CCCN_AUTH_TOKEN)
  --model <id>             default model for new sessions
  --permission-mode <mode> default permission mode
  --claude <path>          explicit claude.exe path (skips discovery)
  -h, --help               show this help

Environment: CCCN_PORT, CCCN_HOST, CCCN_BASE_URL, CCCN_AUTH_TOKEN, CCCN_MODEL,
             CCCN_PERMISSION_MODE, CCCN_CLAUDE_BINARY, CCCN_PACKAGED
`

const options = parseArgs(process.argv.slice(2))

if (options.help) {
  process.stdout.write(HELP)
  process.exit(0)
}

/**
 * Sidecar root: the directory holding `bridge/`, `skills/`, `node.exe` and — since the installer
 * ships it — `claude.exe`.
 *
 * Taken from the environment rather than derived from `import.meta.url`. In a packaged install
 * the bridge DOES live at `<resource>/sidecar/bridge/cli.mjs` so `..` would work, but in a
 * development checkout it resolves to `packages/bridge` — which made the inventory report every
 * component as missing while they were all present. The shell knows the true root, so it says so.
 *
 * Resolved BEFORE discovery because the same directory is where the bundled CLI lives.
 */
const sidecarRoot = process.env.CCCN_SIDECAR_DIR ?? join(dirname(fileURLToPath(import.meta.url)), '..')

/**
 * Directory to look in for a CLI shipped with the app.
 *
 * Defaults to the sidecar root. It used to be ONLY `CCCN_BUNDLE_DIR`, which the shell never sets —
 * so in an installed build the bundled-CLI candidate was skipped entirely and discovery fell
 * through to the machine's own installs or reported nothing at all. Two environment variables for
 * one directory was the trap; the explicit override is kept, the default is now real.
 */
const bundledDir = process.env.CCCN_BUNDLE_DIR ?? sidecarRoot

const discovered = options.binary ? { path: options.binary, source: 'flag' } : findBinary(bundledDir)

if (!discovered) {
  process.stderr.write(
    'bridge: could not locate claude.exe.\n' +
      'Install it (npm i -g @anthropic-ai/claude-code from a mirror) or pass --claude <path>.\n',
  )
  // Keep serving: the UI can still render discovery output and let the user set a path.
}

// The scanner answers `/api/discovery`, so it has to reflect the SAME binary the sessions run on:
// an explicit --claude/CCCN_CLAUDE_BINARY must show up there too, not just in the handshake.
const scanner = createScanner({
  bundledDir,
  ...(discovered ? { resolvedBinary: discovered } : {}),
})

/**
 * Bundled skills root.
 *
 * The sidecar stages skills at `<sidecar>/skills/.claude/skills/<name>/`, and the CLI discovers
 * them when that root is passed as `--add-dir`. Defaulting to the entry point's own directory
 * means a packaged install needs no configuration, while `CCCN_SKILLS_ROOT` lets a development
 * or custom layout override it.
 */
const skillsRoot =
  process.env.CCCN_SKILLS_ROOT ?? join(dirname(fileURLToPath(import.meta.url)), '..', 'skills')

const { server } = createBridgeServer({
  binary: discovered?.path ?? '',
  // Same directory the resolution above used, so `/api/discovery` reports the bundled CLI rather
  // than claiming one is missing that is sitting right there.
  bundledDir,
  ...(discovered ? { resolvedBinary: discovered } : {}),
  skillsRoot: existsSync(skillsRoot) ? skillsRoot : undefined,
  // Lets the inventory report whether a bundled file actually shipped, independently of
  // whether the runtime managed to load it.
  sidecarRoot: existsSync(sidecarRoot) ? sidecarRoot : undefined,
  defaults: {
    baseUrl: options.baseUrl,
    authToken: options.authToken,
    model: options.model,
    permissionMode: options.permissionMode,
  },
})

server.listen(options.port, options.host, () => {
  const address = server.address()
  const port = typeof address === 'object' && address ? address.port : options.port
  const url = `http://${options.host}:${port}`

  const scan = scanner.scan()
  const handshake = {
    port,
    url,
    binary: discovered?.path ?? null,
    binarySource: discovered?.source ?? null,
    baseUrl: options.baseUrl ?? scan.baseUrl ?? 'https://api.deepseek.com/anthropic',
    hasCredential: Boolean(options.authToken),
  }

  // Single line, prefixed, so the shell can parse it out of mixed logging.
  process.stdout.write(`CCCN_READY ${JSON.stringify(handshake)}\n`)
  process.stderr.write(`bridge: listening on ${url}\n`)
  if (!discovered) process.stderr.write('bridge: WARNING no claude.exe discovered\n')
})

const shutdown = () => {
  server.close(() => process.exit(0))
  setTimeout(() => process.exit(0), 3000).unref?.()
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)

/**
 * Parent watchdog.
 *
 * The Tauri shell kills this process on a graceful exit, but a force-kill (Task Manager,
 * a crash, a killed console) leaves this process orphaned and still holding the port. The
 * shell cannot defend against that, so the child defends itself: poll for the parent and
 * exit when it is gone.
 *
 * Disabled when there is no parent to watch (ppid <= 1) so running the bridge by hand in a
 * terminal — the documented development workflow — is unaffected.
 */
const parentPid = process.ppid
if (parentPid && parentPid > 1) {
  const parentGone = () => {
    try {
      // Signal 0 performs the permission/existence check without delivering anything.
      process.kill(parentPid, 0)
      return false
    } catch (error) {
      // EPERM means the process exists but is owned by someone else — still alive.
      return error?.code !== 'EPERM'
    }
  }

  const watchdog = setInterval(() => {
    if (parentGone()) {
      process.stderr.write(`bridge: parent ${parentPid} exited; shutting down\n`)
      clearInterval(watchdog)
      server.close(() => process.exit(0))
      setTimeout(() => process.exit(0), 1000).unref?.()
    }
  }, 2000)
  watchdog.unref?.()
}
