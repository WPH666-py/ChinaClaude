/**
 * Assert that the BUILT app can find its sidecar the way the installer lays it out.
 *
 * This exists because the shell used to look in `<exe>/sidecar` while `bundle.resources` puts the
 * runtime at `<exe>/resources/sidecar` — the release then ran on the build machine (where a
 * compile-time checkout path happened to exist) and died silently everywhere else. A build is not
 * done until that gap is closed, so `pnpm build` runs this after `tauri build`.
 *
 * Checks, in order:
 *   1. the release exe exists
 *   2. `<exe dir>/resources/sidecar/bridge/cli.mjs` exists (what the bundler ships)
 *   3. `exe --self-check` reports ok AND candidate `resource_dir/resources/sidecar`
 *      (any other candidate means the exe is running off a dev path, not the packaged layout)
 *      AND the bridge reaches its handshake — Node rejecting the verbatim `\\?\` path form passes
 *      every layout check and still leaves the user with an error dialog instead of a window
 *   4. if a generated NSIS script is present, it writes the runtime under `resources\sidecar`
 *   5. if an MSI was produced, it carries the runtime AND the WebView2 offline installer
 *
 * Exit code 0 = the bundle is shippable; 1 = do not ship it.
 */
import { execFileSync } from 'node:child_process'
import { closeSync, existsSync, openSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, normalize, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const desktopDir = resolve(join(here, '..'))
const tauriDir = join(desktopDir, 'src-tauri')
const targetDir = process.env.CARGO_TARGET_DIR
  ? resolve(process.env.CARGO_TARGET_DIR)
  : join(tauriDir, 'target')

const exe = join(targetDir, 'release', 'claude-code-cn.exe')
const exeDir = dirname(exe)
const installedSidecar = join(exeDir, 'resources', 'sidecar')
const EXPECTED_CANDIDATE = 'resource_dir/resources/sidecar'

let failures = 0
const pass = (message) => process.stdout.write(`  PASS  ${message}\n`)
const fail = (message) => {
  failures += 1
  process.stdout.write(`  FAIL  ${message}\n`)
}

process.stdout.write('=== 1. release binary ===\n')
if (!existsSync(exe)) {
  fail(`release binary missing: ${exe}`)
  process.stdout.write(`\n${failures} check(s) failed\n`)
  process.exit(1)
}
pass(`${exe} (${Math.round(statSync(exe).size / 1024 / 1024)} MB)`)

process.stdout.write('=== 2. installed resource layout ===\n')
const entry = join(installedSidecar, 'bridge', 'cli.mjs')
if (existsSync(entry)) pass(`sidecar staged at ${installedSidecar}`)
else fail(`missing ${entry} — bundle.resources did not stage the runtime next to the exe`)

process.stdout.write('=== 3. shell resolves the packaged layout ===\n')
// Output goes through a FILE, not a pipe: a GUI-subsystem exe inherits whatever handles it is given,
// and capturing through `stdio: 'pipe'` is rejected (EPERM) in confined environments. A file handle
// also keeps the Chinese error text intact.
const reportFile = join(tmpdir(), `cccn-self-check-${process.pid}.json`)
let report = null
let exitCode = 0
try {
  const fd = openSync(reportFile, 'w')
  try {
    execFileSync(exe, ['--self-check'], { stdio: ['ignore', fd, fd], timeout: 30000 })
  } finally {
    closeSync(fd)
  }
} catch (error) {
  // Exit code 1 is a normal "layout not resolvable"; the JSON payload is still in the file.
  exitCode = typeof error.status === 'number' ? error.status : -1
}
try {
  const line = readFileSync(reportFile, 'utf8').trim().split('\n').filter(Boolean).pop()
  report = JSON.parse(line)
} catch {
  fail(`--self-check produced no JSON (exit ${exitCode})`)
}
rmSync(reportFile, { force: true })

if (report) {
  if (report.ok !== true) fail(`--self-check failed: ${report.error ?? 'unknown error'}`)
  else pass(`sidecar = ${report.sidecar}`)

  if (report.candidate === EXPECTED_CANDIDATE) pass(`candidate = ${report.candidate}`)
  else
    fail(
      `candidate = ${report.candidate ?? '(none)'}, expected ${EXPECTED_CANDIDATE} — ` +
        'the exe is resolving a dev checkout, not the installed layout'
    )

  if (report.ok === true && normalize(report.sidecar) === normalize(installedSidecar)) {
    pass('resolved directory is the installed one')
  } else if (report.ok === true) {
    fail(`resolved ${report.sidecar}, expected ${installedSidecar}`)
  }

  if (report.node === true) pass('node.exe present in the resolved directory')
  else if (report.ok === true) fail('node.exe missing from the resolved directory')

  // Layout is not enough. The 0.2.2 bug that mattered was Node refusing the verbatim path the
  // shell hands it (`\\?\C:\...`), which passes every check above and still shows an error dialog
  // instead of a window. Only the real handshake proves the app can start.
  if (report.bridgeReady === true) pass('bridge reported ready from the installed layout')
  else
    fail(
      `bridge did not report ready: ${report.bridgeError ?? 'no detail'} — ` +
        'an installed copy would show a startup error instead of a window'
    )
}

process.stdout.write('=== 4. installer script layout ===\n')
const nsisRoot = join(targetDir, 'release', 'nsis')
const nsisScript = existsSync(nsisRoot)
  ? readdirSync(nsisRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => join(nsisRoot, entry.name, 'installer.nsi'))
      .find((path) => existsSync(path))
  : undefined

if (!nsisScript) {
  process.stdout.write('  SKIP  no generated installer.nsi (use `tauri build`, not --no-bundle)\n')
} else {
  const script = readFileSync(nsisScript, 'utf8')
  if (script.includes('resources\\sidecar\\node.exe')) {
    pass(`${nsisScript} installs the runtime under resources\\sidecar`)
  } else {
    fail(`${nsisScript} does not install the runtime under resources\\sidecar`)
  }
}

process.stdout.write('=== 5. MSI installer payload ===\n')
const msiRoot = join(targetDir, 'release', 'bundle', 'msi')
// Newest, not first: the bundle directory accumulates every installer this checkout ever produced, and
// validating last release's MSI while this build ships a different one is a check that passes for the
// wrong artefact (it did exactly that once: 0.2.2's MSI "verified" the 0.3.0 build).
const msi = existsSync(msiRoot)
  ? readdirSync(msiRoot)
      .filter((name) => name.endsWith('.msi'))
      .map((name) => ({ name, at: statSync(join(msiRoot, name)).mtimeMs }))
      .sort((left, right) => right.at - left.at)[0]?.name
  : undefined

if (!msi) {
  process.stdout.write('  SKIP  no .msi produced (bundle.targets does not include "msi")\n')
} else {
  pass(`${msi} (${((statSync(join(msiRoot, msi)).size / 1024 / 1024) | 0)} MB)`)

  // The WiX source is generated before the MSI is linked, so it is the cheapest way to prove the
  // payload WITHOUT installing: the sidecar has to be a file of the package, not something the
  // installer downloads afterwards.
  const wixRoot = join(targetDir, 'release', 'wix')
  const wxs = existsSync(wixRoot)
    ? readdirSync(wixRoot, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => join(wixRoot, entry.name, 'main.wxs'))
        .find((path) => existsSync(path))
    : undefined

  if (!wxs) {
    process.stdout.write(`  SKIP  no generated main.wxs at ${wixRoot}\n`)
  } else {
    const source = readFileSync(wxs, 'utf8')
    for (const file of ['resources\\sidecar\\node.exe', 'resources\\sidecar\\claude.exe']) {
      if (source.includes(file)) pass(`MSI carries ${file}`)
      else fail(`MSI does not carry ${file} — a fresh machine would install without a runtime`)
    }
    if (source.includes('MicrosoftEdgeWebView2RuntimeInstallerX64.exe')) {
      pass('MSI embeds the WebView2 offline installer')
    } else {
      fail('MSI does not embed WebView2 — machines without the runtime would show a blank window')
    }
  }
}

if (failures > 0) {
  process.stdout.write(`\n${failures} check(s) failed — do NOT ship this bundle\n`)
  process.exit(1)
}
process.stdout.write('\nPASS: bundle layout matches what the shell resolves\n')
