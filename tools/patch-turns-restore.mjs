import { readFileSync, writeFileSync } from 'node:fs'

let text = readFileSync('packages/bridge/src/turns.mjs', 'utf8').replace(/\r\n/g, '\n')

// 需要 copyFileSync / unlinkSync
text = text.replace(
  "import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'",
  "import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs'",
)

const appended = `

/**
 * 撤回时用：列出这段会话里「某条消息之后」被工具改过的文件。
 *
 * WHY BY TIMESTAMP AND NOT BY TURN NUMBER: 会话记录（CLI 写的）和快照目录（桥写的）在重启后各自独立编号，
 * 而事件里的时间戳是两边都有的、且不会重排的东西。用 since 圈定「这条消息之后」既覆盖同一轮的多处写入，
 * 也覆盖被拆成多轮追加的情况。
 *
 * later = 之后有多轮改过同一个文件：还原到最早的快照会连带丢掉那些改动，所以必须让用户看见并自己选。
 */
export function previewTurnFiles({ sessionId, since = 0 } = {}) {
  const safeSession = String(sessionId ?? '').replace(/[^A-Za-z0-9-]/g, '')
  const root = dataSubDir(join('turns', safeSession))
  if (!existsSync(root)) return { ok: true, files: [] }

  const turns = readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && /^\\d+$/.test(entry.name))
    .map((entry) => Number(entry.name))
    .sort((a, b) => a - b)

  /** absolute → 最早的一条记录（同一次消息之后的第一份前像才是「原本的样子」）。 */
  const byFile = new Map()
  for (const turn of turns) {
    const index = readIndex(sessionId, turn)
    for (const entry of index.files) {
      if (!entry?.absolute) continue
      if (since > 0 && Number(entry.at ?? 0) < since) continue
      const previous = byFile.get(entry.absolute)
      if (!previous) {
        byFile.set(entry.absolute, {
          path: entry.path,
          absolute: entry.absolute,
          created: entry.created === true,
          tooBig: entry.tooBig === true,
          before: entry.before ?? null,
          touches: 1,
        })
      } else {
        previous.touches += 1
      }
    }
  }

  const files = [...byFile.values()].map((file) => ({
    ...file,
    later: file.touches > 1,
  }))
  return { ok: true, files }
}

/**
 * 把选中的文件写回撤回之前的样子。
 *
 * 顺序是「先备份、再覆盖」：任何一步失败都必须留下当前内容，否则一次还原失败会同时丢掉新旧两份。
 * created 的文件在撤回后应当不存在 —— 还原即删除，删除前同样先备份成 .rollback-bak。
 */
export function restoreTurnFiles({ sessionId, since = 0, paths = [] } = {}) {
  const wanted = new Set((Array.isArray(paths) ? paths : []).map(String))
  if (wanted.size === 0) return { ok: true, restored: [], skipped: [] }

  const preview = previewTurnFiles({ sessionId, since })
  if (!preview.ok) return preview

  const restored = []
  const skipped = []
  for (const file of preview.files) {
    if (!wanted.has(file.absolute)) continue
    if (file.tooBig || (!file.created && !file.before)) {
      skipped.push({ path: file.path, reason: '没有可用快照（文件过大或未记录）' })
      continue
    }
    const backup = \`\${file.absolute}.rollback-bak\`
    try {
      if (file.created) {
        if (existsSync(file.absolute)) {
          copyFileSync(file.absolute, backup)
          unlinkSync(file.absolute)
        }
        restored.push({ path: file.path, action: 'deleted', backup })
        continue
      }
      if (existsSync(file.absolute)) copyFileSync(file.absolute, backup)
      mkdirSync(join(file.absolute, '..'), { recursive: true })
      copyFileSync(file.before, file.absolute)
      restored.push({ path: file.path, action: 'restored', backup: existsSync(backup) ? backup : null })
    } catch (error) {
      skipped.push({ path: file.path, reason: error instanceof Error ? error.message : String(error) })
    }
  }
  return { ok: true, restored, skipped }
}
`

if (text.includes('export function previewTurnFiles')) throw new Error('already patched')
writeFileSync('packages/bridge/src/turns.mjs', text + appended, 'utf8')
console.log('turns restore added')
