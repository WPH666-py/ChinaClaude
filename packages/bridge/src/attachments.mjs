/**
 * Attachments: files the user hands to the conversation.
 *
 * Claude Code reads files by PATH, so an "attachment" here is not an upload protocol — it is a way
 * to get bytes from the webview onto disk and put that path into the prompt. The bridge is the one
 * that writes, because a webview cannot: `<input type="file">` yields a File object, and in a
 * browser there is no real path behind it. Uploading the bytes and getting a path back is the only
 * approach that behaves identically under `vite dev` and inside the Tauri webview, which is the
 * same rule the directory picker follows.
 *
 * WHY NOT WRITE INTO THE WORKSPACE: attachments are not the user's files. Dropping them into the
 * project would show up in git status and could be picked up by the agent's own searches, so they
 * live in a per-user directory outside any workspace.
 */
import { mkdirSync, writeFileSync, existsSync, readdirSync, statSync, rmSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join, extname } from 'node:path'
import { randomUUID } from 'node:crypto'

/** Hard ceiling per file. Generous for images, small enough that a mistake cannot fill a disk. */
const MAX_BYTES = 24 * 1024 * 1024

/** Only extensions we can name from the payload; anything else is stored as `.bin`. */
const ALLOWED_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.svg', '.pdf', '.txt', '.md', '.json',
  '.csv', '.log', '.yml', '.yaml', '.xml', '.html', '.css', '.js', '.mjs', '.cjs', '.ts', '.tsx',
  '.py', '.rb', '.go', '.rs', '.java', '.c', '.h', '.cpp', '.sh', '.ps1', '.sql', '.toml', '.ini',
])

/**
 * Where attachments live.
 *
 * `CCCN_ATTACHMENTS_DIR` overrides (used by tests so they do not write into the real home), else a
 * per-user directory beside the app's other state.
 */
export function attachmentsRoot() {
  const override = process.env.CCCN_ATTACHMENTS_DIR
  if (override && override.trim()) return override.trim()
  try {
    return join(homedir(), '.claude-code-cn', 'attachments')
  } catch {
    // A profile with no resolvable home still deserves a working attach button.
    return join(tmpdir(), 'claude-code-cn-attachments')
  }
}

/**
 * Reduce a client-supplied filename to something safe to place on disk.
 *
 * The client's name is NEVER used to build the path: only its extension survives, and the basename
 * is regenerated. That removes traversal (`../../x`), reserved device names on Windows (`CON`,
 * `NUL`) and collisions in one step, rather than filtering for known-bad patterns.
 */
function safeExtension(name) {
  const raw = extname(String(name ?? '')).toLowerCase()
  // Also guards against a name like "a.PNG " or one carrying separators.
  if (!raw || raw.length > 8 || /[^a-z0-9.]/.test(raw)) return '.bin'
  return ALLOWED_EXTENSIONS.has(raw) ? raw : '.bin'
}

/** Decode a `data:<mime>;base64,<payload>` URL, or a bare base64 string. */
function decodePayload(dataUrl) {
  const text = String(dataUrl ?? '')
  const comma = text.indexOf(',')
  const isDataUrl = text.startsWith('data:')
  const base64 = isDataUrl && comma >= 0 ? text.slice(comma + 1) : text
  if (!base64) return null
  const buffer = Buffer.from(base64, 'base64')
  if (buffer.length === 0) return null
  return buffer
}

/**
 * Store one uploaded file and return the absolute path to hand to the agent.
 *
 * @returns {{ok:true, path:string, bytes:number, name:string}|{ok:false, error:string, name:string}}
 */
export function saveAttachment(file) {
  const originalName = typeof file?.name === 'string' ? file.name : 'attachment'
  const buffer = decodePayload(file?.dataUrl)
  if (!buffer) return { ok: false, error: '内容为空或不是有效的 base64', name: originalName }
  if (buffer.length > MAX_BYTES) {
    return { ok: false, error: `超过单文件上限 ${(MAX_BYTES / 1024 / 1024).toFixed(0)} MB`, name: originalName }
  }

  const root = attachmentsRoot()
  try {
    mkdirSync(root, { recursive: true })
  } catch (error) {
    return { ok: false, error: `无法创建附件目录：${String(error?.message ?? error)}`, name: originalName }
  }

  // Keep the readable part of the original name for the human, regenerate the unique part.
  const stem = originalName
    .replace(/\.[^.]*$/, '')
    .replace(/[^a-zA-Z0-9\u4e00-\u9fff_-]/g, '-')
    .slice(0, 40) || 'file'
  const target = join(root, `${stem}-${randomUUID().slice(0, 8)}${safeExtension(originalName)}`)

  try {
    writeFileSync(target, buffer)
  } catch (error) {
    return { ok: false, error: `写入失败：${String(error?.message ?? error)}`, name: originalName }
  }
  return { ok: true, path: target, bytes: buffer.length, name: originalName }
}

/** Store a batch. A per-file failure does not discard the ones that worked. */
export function saveAttachments(files) {
  const list = Array.isArray(files) ? files : []
  if (list.length === 0) return { ok: false, error: 'files 为空', results: [] }
  const results = list.map((file) => saveAttachment(file))
  return { ok: results.some((entry) => entry.ok), root: attachmentsRoot(), results }
}

/** Total size and count, so the UI can offer to clean up rather than growing without bound. */
export function attachmentsUsage() {
  const root = attachmentsRoot()
  if (!existsSync(root)) return { root, files: 0, bytes: 0 }
  let files = 0
  let bytes = 0
  for (const entry of readdirSync(root)) {
    try {
      const info = statSync(join(root, entry))
      if (info.isFile()) {
        files++
        bytes += info.size
      }
    } catch {
      /* skip unreadable entries */
    }
  }
  return { root, files, bytes }
}

/** Delete every stored attachment. Explicit, because it is the only destructive operation here. */
export function clearAttachments() {
  const root = attachmentsRoot()
  if (!existsSync(root)) return { ok: true, removed: 0, root }
  let removed = 0
  for (const entry of readdirSync(root)) {
    try {
      rmSync(join(root, entry), { force: true })
      removed++
    } catch {
      /* keep going: one locked file must not abort the cleanup */
    }
  }
  return { ok: true, removed, root }
}
