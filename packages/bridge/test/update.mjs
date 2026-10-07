/**
 * Update checker: version ordering, source fallback, and the two properties that matter most —
 * a page can never nominate a URL for this process to download and execute, and an unreachable
 * network is data rather than an exception.
 *
 * Offline by construction: `fetch` is stubbed, so this suite runs in milliseconds and cannot fail
 * because a release was or was not published today.
 *
 * Run: node packages/bridge/test/update.mjs
 */
import { makeCheck, finish } from './harness.mjs'
import { parseVersion, isNewer, checkForUpdate, createUpdateInstaller, publicCheckResult, GITEE_LIMITS } from '../src/update.mjs'

const results = []
const check = makeCheck(results)

const realFetch = globalThis.fetch
/** @type {Map<string, () => Response>} */
let routes = new Map()
let requested = []

function stubFetch() {
  routes = new Map()
  requested = []
  globalThis.fetch = async (url) => {
    const text = String(url)
    requested.push(text)
    for (const [pattern, handler] of routes) {
      if (text.includes(pattern)) return handler()
    }
    return new Response('not found', { status: 404, statusText: 'Not Found' })
  }
}

const json = (body) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })

function githubRelease({ tag, assets }) {
  routes.set('api.github.com', () =>
    json({
      tag_name: tag,
      body: 'notes for ' + tag,
      html_url: `https://github.com/o/r/releases/tag/${tag}`,
      assets,
    }),
  )
}

function giteeRelease({ tag, files = [] }) {
  routes.set('gitee.com/api/v5/repos/o/r/releases/latest', () => json({ id: 42, tag_name: tag, body: 'gitee notes' }))
  routes.set('attach_files', () => json(files))
}

// ---- version arithmetic ------------------------------------------------------

check('parses a v-prefixed version', JSON.stringify(parseVersion('v1.2.3')) === '[1,2,3]')
check('parses a bare version', JSON.stringify(parseVersion('1.2.3')) === '[1,2,3]')
check('ignores a pre-release suffix', JSON.stringify(parseVersion('v1.2.3-beta.1')) === '[1,2,3]')
check('rejects an unparseable version', parseVersion('nightly') === null)

check('a higher patch is newer', isNewer('v0.1.1', '0.1.0'))
check('a higher minor is newer', isNewer('v0.2.0', '0.1.0'))
check('a higher major is newer', isNewer('v1.0.0', '0.9.9'))
check('the same version is not newer', !isNewer('v0.1.0', '0.1.0'))
check('an older version is not newer', !isNewer('v0.1.0', '0.2.0'))
// Numeric, not lexicographic: string comparison would call "0.9.0" newer than "0.10.0".
check('double digits compare numerically', isNewer('v0.10.0', '0.9.0'))
// A garbage tag must never be treated as an update, or a mislabelled release would nag forever.
check('garbage is never newer', !isNewer('nightly', '0.1.0'))
check('garbage current never triggers an update', !isNewer('v9.9.9', 'unknown'))

// ---- source handling ---------------------------------------------------------

stubFetch()
githubRelease({
  tag: 'v0.2.0',
  assets: [
    { name: 'source.zip', browser_download_url: 'https://example.invalid/source.zip', size: 10, digest: null },
    { name: 'ChinaClaude-0.2.0-x64-setup.exe', browser_download_url: 'https://example.invalid/setup.exe', size: 999, digest: 'sha256:abc123' },
  ],
})
giteeRelease({ tag: 'v0.2.0', files: [] })

let result = await checkForUpdate({ currentVersion: '0.1.0', sources: [
  { id: 'gitee', kind: 'gitee', owner: 'o', repo: 'r' },
  { id: 'github', kind: 'github', owner: 'o', repo: 'r' },
] })

check('reports an available update', result.available === true, `${result.current} -> ${result.latest}`)
check('picks the installer, not some other exe or archive', result.asset?.name === 'ChinaClaude-0.2.0-x64-setup.exe', String(result.asset?.name))
check('strips the sha256: prefix from the digest', result.asset?.sha256 === 'abc123', String(result.asset?.sha256))
check('is installable when a source supplies a file', result.installable === true)
check('records which sources answered', JSON.stringify(result.checked) === '["gitee","github"]', JSON.stringify(result.checked))

/**
 * Both sources report the same tag, and only GitHub has the file. The version may come from either,
 * but the DOWNLOAD must come from the one that can serve it — otherwise the app announces an update
 * on one screen and refuses to install it on the next.
 */
check('the download comes from the source that has the file', result.source === 'github', String(result.source))

/**
 * The security property this whole API shape exists for: the page must not be able to point the
 * downloader at a file of its choosing. `checkForUpdate` keeps the URL (the server needs it), so the
 * assertion is on the redaction that crosses the HTTP boundary — which is where the guarantee lives.
 */
const published = publicCheckResult(result)
check('the URL never crosses into the page', published.asset?.url === undefined, JSON.stringify(published.asset))
check('but the digest does, so the download can be verified', published.asset?.sha256 === 'abc123')

// A source that cannot host the file still contributes its VERSION — that is the Gitee situation,
// where attachments are capped well below the installer's size.
stubFetch()
giteeRelease({ tag: 'v0.3.0', files: [] })
result = await checkForUpdate({ currentVersion: '0.1.0', sources: [{ id: 'gitee', kind: 'gitee', owner: 'o', repo: 'r' }] })
check('a version is reported even with no downloadable file', result.available === true && result.asset === null, `available=${result.available} asset=${result.asset}`)
check('and it is marked not installable rather than offered', result.installable === false)
check('the Gitee attachment cap is recorded as the reason it cannot host installers', GITEE_LIMITS.attachmentBytes === 100 * 1024 * 1024)

/**
 * The Gitee attachment list needs the NUMERIC release id — `/releases/latest/attach_files` 404s.
 * Calling the `latest` form made every Gitee release look like it had no files at all, so the app
 * silently fell back to the other source for the download. These two assertions guard the ADDRESS,
 * not just the parsing, because the address is what was wrong.
 */
stubFetch()
giteeRelease({
  tag: 'v0.4.0',
  files: [
    {
      id: 3335435,
      name: 'ChinaClaude_0.4.0_x64-setup.exe',
      size: 25622731,
      browser_download_url: 'https://gitee.com/o/r/releases/download/v0.4.0/ChinaClaude_0.4.0_x64-setup.exe',
    },
  ],
})
result = await checkForUpdate({ currentVersion: '0.1.0', sources: [{ id: 'gitee', kind: 'gitee', owner: 'o', repo: 'r' }] })
check(
  'gitee attachments are fetched by numeric release id',
  requested.some((u) => u.includes('/releases/42/attach_files')),
  JSON.stringify(requested.filter((u) => u.includes('attach'))),
)
check('and never via the /latest/ form that 404s', !requested.some((u) => u.includes('latest/attach_files')))
check('the gitee file size is parsed', result.asset?.size === 25622731, String(result.asset?.size))
check('so a gitee-only install is offered', result.available === true && result.installable === true)

/**
 * When the attachment endpoint is unavailable, the release's own `assets` still carries the file —
 * but in the same array as two auto-generated SOURCE archives that are not installers.
 */
stubFetch()
routes.set('gitee.com/api/v5/repos/o/r/releases/latest', () =>
  json({
    id: 42,
    tag_name: 'v0.5.0',
    body: '',
    assets: [
      {
        name: 'ChinaClaude_0.5.0_x64-setup.exe',
        browser_download_url: 'https://gitee.com/o/r/releases/download/v0.5.0/ChinaClaude_0.5.0_x64-setup.exe',
      },
      { name: 'v0.5.0.zip', browser_download_url: 'https://gitee.com/o/r/archive/refs/tags/v0.5.0.zip' },
      { name: 'v0.5.0.tar.gz', browser_download_url: 'https://gitee.com/o/r/archive/refs/tags/v0.5.0.tar.gz' },
    ],
  }),
)
result = await checkForUpdate({ currentVersion: '0.1.0', sources: [{ id: 'gitee', kind: 'gitee', owner: 'o', repo: 'r' }] })
check(
  'falls back to the release asset list when attach_files is unavailable',
  result.asset?.name === 'ChinaClaude_0.5.0_x64-setup.exe',
  String(result.asset?.name),
)
check('and never mistakes a source archive for an installer', result.installable === true && !result.asset.name.endsWith('.zip'))

// One unreachable source must not take the answer down with it.
stubFetch()
routes.set('api.github.com', () => json({ tag_name: 'v0.2.0', body: '', html_url: 'u', assets: [] }))
result = await checkForUpdate({ currentVersion: '0.1.0', sources: [
  { id: 'gitee', kind: 'gitee', owner: 'o', repo: 'r' }, // 404 by default
  { id: 'github', kind: 'github', owner: 'o', repo: 'r' },
] })
check('one unreachable source does not fail the check', result.ok === true && result.available === true)
check('the failure is reported rather than swallowed', result.errors.some((line) => line.startsWith('gitee:')), JSON.stringify(result.errors))

// All sources down: an ordinary outcome here, and it must be data.
stubFetch()
result = await checkForUpdate({ currentVersion: '0.1.0', sources: [{ id: 'github', kind: 'github', owner: 'o', repo: 'r' }] })
check('every source failing returns ok:false instead of throwing', result.ok === false && result.available === false)
check('and still reports the current version', result.current === '0.1.0')

// Newest wins across sources, so a stale mirror cannot pin the app to an old build.
stubFetch()
giteeRelease({ tag: 'v0.2.0', files: [] })
routes.set('api.github.com', () => json({ tag_name: 'v0.5.0', body: '', html_url: 'u', assets: [] }))
result = await checkForUpdate({ currentVersion: '0.1.0', sources: [
  { id: 'gitee', kind: 'gitee', owner: 'o', repo: 'r' },
  { id: 'github', kind: 'github', owner: 'o', repo: 'r' },
] })
check('the newest tag across sources wins', result.latest === 'v0.5.0', String(result.latest))

// Up to date.
stubFetch()
githubRelease({ tag: 'v0.1.0', assets: [{ name: 'x-setup.exe', browser_download_url: 'u', size: 1, digest: 'sha256:z' }] })
result = await checkForUpdate({ currentVersion: '0.1.0', sources: [{ id: 'github', kind: 'github', owner: 'o', repo: 'r' }] })
check('the current version is not an update', result.available === false && result.installable === false)

// ---- installer state machine -------------------------------------------------

const installer = createUpdateInstaller()
check('installer starts idle', installer.status().phase === 'idle')
let refused = false
try {
  installer.install()
} catch {
  refused = true
}
check('install refuses before anything was downloaded', refused)
check('download refuses a source with no url', await installer.download({}).then(() => false, () => true))

globalThis.fetch = realFetch
finish(results)
