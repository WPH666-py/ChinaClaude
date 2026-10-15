/**
 * Sessions that survive a restart of the app.
 *
 * WHY THIS EXISTS: the conversation list and every event were kept only in the bridge process's
 * memory, and the bridge is killed when the app closes — so quitting and reopening showed an empty
 * sidebar even though the user had a whole conversation a moment earlier. This is the disk copy: a
 * small JSON snapshot of each session, rewritten as the conversation changes and read back on
 * startup.
 *
 * WHAT IS STORED: identity, endpoint, model, and the event log the SSE stream replays. NO
 * CREDENTIALS — `toSnapshot()` strips them — so a restored session re-resolves its key from the
 * shared model list the first time the user continues it (see `keyForBaseUrl` in models.mjs).
 *
 * The file lives beside the other feature state (`models.json`, `remote.json`, `wechat.json`) under
 * the data root, so it is removed by the same cleanup a user already understands.
 */
import { readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dataFile } from './paths.mjs'

/** How many sessions survive a restart; anything older is dropped, newest first. */
const MAX_SESSIONS = 30
/** How many trailing events are kept per session — deep enough to restore context, bounded so the file stays small. */
const MAX_HISTORY = 2000

function file() {
  return dataFile('sessions.json')
}

/**
 * The last saved snapshots, newest first, or an empty list.
 *
 * A missing or corrupt file degrades to "nothing to restore" rather than throwing: a bad snapshot
 * must never stop the app from starting.
 */
export function readSessions() {
  try {
    const parsed = JSON.parse(readFileSync(file(), 'utf8'))
    if (!parsed || !Array.isArray(parsed.sessions)) return []
    return parsed.sessions.filter((session) => session && typeof session.id === 'string')
  } catch {
    return []
  }
}

/**
 * Replace the snapshot with this run's sessions.
 *
 * Written through a temp file + rename so a crash mid-write leaves the previous good snapshot in
 * place instead of a truncated one. Failures are swallowed: a snapshot that cannot be written must
 * never break the session it is describing.
 */
export function writeSessions(list) {
  const trimmed = (Array.isArray(list) ? list : []).slice(0, MAX_SESSIONS).map((session) => ({
    ...session,
    history: Array.isArray(session?.history) ? session.history.slice(-MAX_HISTORY) : [],
  }))
  const payload = { version: 1, updatedAt: Date.now(), sessions: trimmed }
  const target = file()
  const temp = `${target}.tmp`
  try {
    writeFileSync(temp, JSON.stringify(payload), 'utf8')
    renameSync(temp, target)
  } catch {
    /* best effort */
  }
}
