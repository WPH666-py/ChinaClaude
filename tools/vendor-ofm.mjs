/**
 * Copies the Our Free Model standalone runtime (MIT, https://github.com/Ebony-Vinyl/dsh-our-free-model)
 * into vendor/ofm-runtime so prepare-sidecar.mjs can ship it as a bundled local service.
 *
 * Only the ESM files that the service actually imports are copied — the React frontend, the Vite
 * config and the TypeScript sources stay out. The full module graph is ~0.8 MB.
 *
 * Usage: node tools/vendor-ofm.mjs <sourceRoot>
 */
import fs from 'node:fs'
import path from 'node:path'

const sourceRoot = path.resolve(process.argv[2] ?? '')
if (!sourceRoot || !fs.existsSync(sourceRoot)) {
  console.error('usage: node tools/vendor-ofm.mjs <path to dsh-our-free-model checkout>')
  process.exit(2)
}

const targetRoot = path.resolve('vendor/ofm-runtime')
fs.rmSync(targetRoot, { recursive: true, force: true })

const KEEP_DIRS = ['packages/standalone', 'src', 'catalog']
const KEEP_EXT = new Set(['.mjs', '.js', '.json', '.html', '.css', '.svg'])
// `web/` holds the prebuilt management assets the service serves at / — the service refuses to
// start without `web/index.html`, so it ships. `frontend/` (TSX sources) is what we drop.
const SKIP_NAMES = new Set([
  'node_modules',
  'frontend',
  'tsconfig.json',
  'vite.config.mjs',
  'package-lock.json',
  'components.json',
])

let copied = 0
let bytes = 0

function copyDir(from, to) {
  fs.mkdirSync(to, { recursive: true })
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    if (SKIP_NAMES.has(entry.name)) continue
    const source = path.join(from, entry.name)
    const destination = path.join(to, entry.name)
    if (entry.isDirectory()) {
      copyDir(source, destination)
      continue
    }
    if (!KEEP_EXT.has(path.extname(entry.name))) continue
    fs.copyFileSync(source, destination)
    copied += 1
    bytes += fs.statSync(destination).size
  }
}

for (const dir of KEEP_DIRS) {
  const source = path.join(sourceRoot, dir)
  if (fs.existsSync(source)) copyDir(source, path.join(targetRoot, dir))
}

for (const file of ['LICENSE', 'README.md', 'package.json']) {
  const source = path.join(sourceRoot, file)
  if (fs.existsSync(source)) {
    fs.copyFileSync(source, path.join(targetRoot, file))
    copied += 1
    bytes += fs.statSync(path.join(targetRoot, file)).size
  }
}

fs.writeFileSync(
  path.join(targetRoot, 'ORIGIN.md'),
  [
    '# Our Free Model standalone runtime (vendored)',
    '',
    'Source: https://github.com/Ebony-Vinyl/dsh-our-free-model',
    'Package: packages/standalone (MIT)',
    '',
    'ChinaClaude ships this runtime so the "our-free-model" models can be imported without',
    'installing DSH: the bridge starts `node packages/standalone/cli.mjs` as a local service,',
    'then talks to it over http://127.0.0.1:<port>/v1 with the key the service writes to its',
    'own data directory.',
    '',
    'Only runtime files are copied: ESM modules, the bundled catalog and the prebuilt `web/`',
    'assets the service serves. The React/TypeScript sources and the Vite config are excluded.',
  ].join('\n') + '\n'
)

console.log(`vendored ${copied} files, ${(bytes / 1048576).toFixed(2)} MB -> ${targetRoot}`)
