/**
 * Update checking and installation.
 *
 * WHY THIS IS HAND-ROLLED RATHER THAN `tauri-plugin-updater`: that plugin needs a signing keypair and
 * a `latest.json` manifest published beside every release, and its endpoint is a single URL. This app
 * has to work from a network where github.com is frequently unreachable — the whole project exists
 * because of that — so the useful property is being able to try SEVERAL sources and take whichever
 * answers, without reissuing a signing key when one of them changes.
 *
 * INTEGRITY. GitHub's release API returns a `digest` (`sha256:...`) for every uploaded asset, so the
 * download can be verified without any key material. Gitee returns no digest — see `GITEE_LIMITS` —
 * so a source that cannot supply one is downloaded over TLS and reported as unverified rather than
 * being silently treated as trusted.
 *
 * NOTHING HERE BLOCKS STARTUP. Every network call is bounded and every failure is returned as data,
 * never thrown: a machine that cannot reach either host must still open the app at full speed.
 */
import { createHash } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import { mkdir, rm, stat } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'

/**
 * What Gitee can and cannot do, measured against its own documentation rather than assumed:
 *
 *   - the releases API is public and needs NO token (verified: HTTP 200 on a public repo);
 *   - a release attachment is capped at **100 MB** (200 MB for GVP projects), 1 GB per repository.
 *
 * The installer was ~230 MB while it embedded the WebView2 OFFLINE runtime — well over that cap, so
 * Gitee could report a version but never serve the file. Switching the bundle to
 * `downloadBootstrapper` (the runtime is already present on Windows 11 and on any Windows 10 with
 * Edge) took it to roughly 80 MB, which fits. Sources stay a LIST regardless: one host being
 * unreachable is the normal case for this app, and the download URL must be free to come from a
 * different host than the version did.
 */
export const GITEE_LIMITS = { attachmentBytes: 100 * 1024 * 1024, repositoryBytes: 1024 * 1024 * 1024 }

/**
 * Sources are tried in order, and each carries its OWN owner/repo.
 *
 * That matters here: the Gitee namespace (`ph-wang`) is not the GitHub one (`WPH666-py`), and a
 * single "owner" field shared between hosts would have quietly queried a repository that does not
 * exist on one of them — a 404 that looks exactly like "no releases yet".
 */
export const DEFAULT_SOURCES = [
  // Gitee first: for users in China it is reachable when GitHub is not.
  { id: 'gitee', kind: 'gitee', owner: 'ph-wang', repo: 'ChinaClaude' },
  { id: 'github', kind: 'github', owner: 'WPH666-py', repo: 'ChinaClaude' },
]

const USER_AGENT = 'ChinaClaude-updater'
const CHECK_TIMEOUT_MS = 8000

/** `v1.2.3` / `1.2.3` / `1.2.3-beta.1` -> `[1,2,3]`, ignoring any pre-release suffix. */
export function parseVersion(text) {
  const match = String(text ?? '').trim().match(/^v?(\d+)\.(\d+)\.(\d+)/)
  if (!match) return null
  return [Number(match[1]), Number(match[2]), Number(match[3])]
}

/** True when `candidate` is strictly newer than `current`. Unparseable input is never "newer". */
export function isNewer(candidate, current) {
  const a = parseVersion(candidate)
  const b = parseVersion(current)
  if (!a || !b) return false
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] > b[i]
  }
  return false
}

/** The asset that is actually installable, from whatever names a host happens to use. */
function pickInstaller(assets) {
  if (!Array.isArray(assets)) return null
  return (
    assets.find((asset) => /-setup\.exe$/i.test(asset.name ?? '')) ??
    assets.find((asset) => /\.exe$/i.test(asset.name ?? '')) ??
    null
  )
}

async function getJson(url, headers) {
  const response = await fetch(url, {
    headers: { 'user-agent': USER_AGENT, ...headers },
    signal: AbortSignal.timeout(CHECK_TIMEOUT_MS),
  })
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}`)
  return await response.json()
}

/** GitHub: `/releases/latest`, whose assets carry a `digest` we can verify against. */
async function readGithub(source) {
  const release = await getJson(`https://api.github.com/repos/${source.owner}/${source.repo}/releases/latest`, {
    accept: 'application/vnd.github+json',
  })
  return {
    tag: release.tag_name,
    notes: release.body ?? '',
    page: release.html_url,
    assets: (release.assets ?? []).map((asset) => ({
      name: asset.name,
      url: asset.browser_download_url,
      size: asset.size,
      // "sha256:abc..." -> "abc..."; absent on older releases, hence the empty fallback.
      sha256: String(asset.digest ?? '').replace(/^sha256:/i, ''),
    })),
  }
}

/**
 * Gitee: same shape of answer, but `assets` there holds only the auto-generated source archives, so
 * uploaded attachments have to be requested separately. A repository with no attachments — which is
 * every Gitee repository that cannot host our 230 MB installer — simply yields none, and the caller
 * falls through to the next source for the download URL while still taking the version from here.
 */
async function readGitee(source) {
  const base = `https://gitee.com/api/v5/repos/${source.owner}/${source.repo}`
  const release = await getJson(`${base}/releases/latest`, { accept: 'application/json' })

  let assets = []
  try {
    const files = await getJson(`${base}/releases/${release.id}/attach_files`, { accept: 'application/json' })
    assets = (Array.isArray(files) ? files : []).map((file) => ({
      name: file.title ?? file.name ?? '',
      url: file.download_url ?? file.browser_download_url ?? '',
      size: file.size ?? null,
      sha256: '',
    }))
  } catch {
    // No attachments, or the endpoint is unavailable: the version is still usable.
  }

  return {
    tag: release.tag_name,
    notes: release.body ?? '',
    page: `https://gitee.com/${source.owner}/${source.repo}/releases/tag/${release.tag_name}`,
    assets,
  }
}

/**
 * Ask every source, newest wins.
 *
 * Every source is tried even when an earlier one already answered, because the sources carry
 * DIFFERENT things: Gitee is likelier to answer from China but cannot host the installer, so the
 * version may come from one host while the download URL comes from another.
 */
export async function checkForUpdate({ currentVersion, sources = DEFAULT_SOURCES } = {}) {
  const results = await Promise.all(
    sources.map(async (source) => {
      try {
        const release = source.kind === 'gitee' ? await readGitee(source) : await readGithub(source)
        return { source, release, error: null }
      } catch (error) {
        return { source, release: null, error: String(error?.message ?? error) }
      }
    }),
  )

  const answered = results.filter((entry) => entry.release)
  if (answered.length === 0) {
    return {
      ok: false,
      current: currentVersion,
      available: false,
      // Reported, not thrown: the UI must be able to say "could not check" without failing startup.
      errors: results.map((entry) => `${entry.source.id}: ${entry.error}`),
    }
  }

  // Newest tag across the sources, so a stale mirror cannot pin the app to an old version.
  const newest = answered.reduce(
    (best, entry) => (isNewer(entry.release.tag, best.release.tag) ? entry : best),
    answered[0],
  )

  /**
   * Among the sources reporting that same newest version, prefer one that can actually SUPPLY the
   * installer.
   *
   * This is the Gitee case exactly: it answers quickly from China and caps attachments at 100 MB, so
   * it can report the version while only GitHub can hand over the 230 MB file. Taking the first
   * source blindly — which is what "newest wins" alone does when the tags tie — would report an
   * update that the same screen then refuses to install.
   */
  const tied = answered.filter((entry) => entry.release.tag === newest.release.tag)
  const best = tied.find((entry) => pickInstaller(entry.release.assets)) ?? newest

  const installer = pickInstaller(best.release.assets)
  const available = isNewer(best.release.tag, currentVersion)
  return {
    ok: true,
    current: currentVersion,
    latest: best.release.tag,
    available,
    notes: best.release.notes,
    page: best.release.page,
    source: best.source.id,
    checked: results.filter((entry) => entry.release).map((entry) => entry.source.id),
    errors: results.filter((entry) => entry.error).map((entry) => `${entry.source.id}: ${entry.error}`),
    asset: installer
      ? { name: installer.name, url: installer.url, size: installer.size, sha256: installer.sha256 }
      : null,
    // An update can be KNOWN without being installable from here — Gitee caps attachments at 100 MB,
    // so if the only answering host is Gitee there may be a version but no file.
    installable: available && Boolean(installer?.url),
  }
}

/**
 * The subset of a check result that is safe to hand to the UI.
 *
 * A named function rather than an inline spread in the HTTP layer, so the guarantee is TESTABLE: the
 * download URL never leaves this process's own memory, which is what stops a page from nominating a
 * file for the bridge to fetch and then execute. `checkForUpdate` still returns the URL because the
 * server needs it to download — this is the boundary, applied deliberately at one place.
 */
export function publicCheckResult(result) {
  const { asset, ...rest } = result
  return {
    ...rest,
    asset: asset ? { name: asset.name, size: asset.size, sha256: asset.sha256 } : null,
  }
}

/** Where downloads land. Cleaned per attempt so a half-file can never be mistaken for a good one. */
function downloadPath(name) {
  const safe = String(name ?? 'update.exe').replace(/[^\w.\-]/g, '_')
  return join(tmpdir(), 'chinaclaude-update', safe)
}

/**
 * Streamed install manager.
 *
 * Progress is polled rather than pushed: the download is one long response and the UI only needs a
 * percentage, so a status endpoint is far less machinery than another event stream.
 */
export function createUpdateInstaller({ spawnImpl = spawn } = {}) {
  let state = { phase: 'idle', received: 0, total: 0, path: null, error: null, verified: null }

  async function download(asset) {
    if (!asset?.url) throw new Error('no download url')
    if (state.phase === 'downloading') throw new Error('a download is already running')

    state = { phase: 'downloading', received: 0, total: asset.size ?? 0, path: null, error: null, verified: null }
    const target = downloadPath(asset.name)

    try {
      await mkdir(join(tmpdir(), 'chinaclaude-update'), { recursive: true })
      await rm(target, { force: true })

      const response = await fetch(asset.url, {
        headers: { 'user-agent': USER_AGENT },
        redirect: 'follow',
        signal: AbortSignal.timeout(30 * 60 * 1000),
      })
      if (!response.ok || !response.body) throw new Error(`download failed: ${response.status}`)

      const total = Number(response.headers.get('content-length')) || asset.size || 0
      state.total = total

      const hash = createHash('sha256')
      const body = Readable.fromWeb(response.body)
      body.on('data', (chunk) => {
        hash.update(chunk)
        state.received += chunk.length
      })

      await pipeline(body, createWriteStream(target))

      /**
       * Verify when the host gave us a digest.
       *
       * GitHub does; Gitee does not. An unverifiable download is reported as `verified: null` rather
       * than `true` — the difference matters, because "we could not check this" and "we checked this
       * and it is correct" must not look the same to the person about to run it.
       */
      state.phase = 'verifying'
      const digest = hash.digest('hex')
      if (asset.sha256) {
        if (digest.toLowerCase() !== String(asset.sha256).toLowerCase()) {
          await rm(target, { force: true })
          state = { phase: 'error', received: 0, total: 0, path: null, error: `校验失败：期望 ${asset.sha256.slice(0, 16)}…，实际 ${digest.slice(0, 16)}…`, verified: false }
          return
        }
        state.verified = true
      } else {
        state.verified = null
      }

      state.phase = 'ready'
      state.path = target
      state.sha256 = digest
      state.size = (await stat(target)).size
    } catch (error) {
      await rm(target, { force: true }).catch(() => {})
      state = { phase: 'error', received: 0, total: 0, path: null, error: String(error?.message ?? error), verified: null }
    }
  }

  /**
   * Run the downloaded installer.
   *
   * `/S` is the NSIS silent switch, and for `installMode: currentUser` no elevation is needed. The
   * installer performs an IN-PLACE UPGRADE — it removes the previous version's files as part of
   * installing — which is why nothing here uninstalls first: doing that would leave a window with
   * nothing installed, and a failure inside it would take the app away rather than leave it older.
   */
  function install() {
    const target = state.path
    if (state.phase !== 'ready' || !target) throw new Error('nothing has been downloaded yet')
    const child = spawnImpl(target, ['/S'], { detached: true, stdio: 'ignore' })
    child.unref?.()
    state = { ...state, phase: 'installing' }
    return { started: true, path: target }
  }

  return {
    download,
    install,
    status: () => ({ ...state }),
    reset: () => {
      state = { phase: 'idle', received: 0, total: 0, path: null, error: null, verified: null }
      return state
    },
  }
}
