/**
 * 按轮差异：快照时机、第一张前像优先、增/删/改的三种形态。
 *
 * The snapshot lives on disk under the data root, so each case gets its own throwaway root; a shared one
 * would let one case's "first edit wins" rule suppress the next case's snapshot.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dataRoot = mkdtempSync(join(tmpdir(), 'cccn-turns-'))
process.env.CCCN_DATA_DIR = dataRoot

const { finish, makeCheck } = await import('./harness.mjs')
const turns = await import('../src/turns.mjs')

const results = []
const check = makeCheck(results)
const workspace = mkdtempSync(join(tmpdir(), 'cccn-turns-ws-'))

try {
  const file = join(workspace, 'a.txt')
  writeFileSync(file, 'one\ntwo\n')

  {
    const first = turns.recordBefore({ sessionId: 's1', turn: 1, cwd: workspace, path: 'a.txt' })
    check('record: existing file snapshots', first.ok === true && first.created !== true, JSON.stringify(first))
    writeFileSync(file, 'one\nTWO\nthree\n')
    const diff = turns.turnDiff({ sessionId: 's1', turn: 1 })
    const entry = diff.files?.[0]
    check('diff: modified status', entry?.status === 'modified', JSON.stringify(entry?.status))
    check('diff: counts added and removed', entry?.added === 2 && entry?.removed === 1, `${entry?.added}/${entry?.removed}`)
    check('diff: body shows both sides', String(entry?.diff).includes('+TWO') && String(entry?.diff).includes('-two'), String(entry?.diff).slice(0, 80))
  }

  {
    // Second edit in the SAME turn must not replace the pre-image; otherwise the diff would only show
    // the last edit and hide everything the turn did before it.
    const second = turns.recordBefore({ sessionId: 's1', turn: 1, cwd: workspace, path: 'a.txt' })
    check('record: first pre-image wins', second.ok === true && second.skipped === true, JSON.stringify(second))
  }

  {
    const created = join(workspace, 'new.txt')
    turns.recordBefore({ sessionId: 's1', turn: 2, cwd: workspace, path: 'new.txt' })
    writeFileSync(created, 'brand new\nline two\n')
    const diff = turns.turnDiff({ sessionId: 's1', turn: 2 })
    const entry = diff.files?.[0]
    check('diff: created file is 新增', entry?.status === 'added' && entry?.added >= 1, JSON.stringify(entry?.status))
  }

  {
    const doomed = join(workspace, 'doomed.txt')
    writeFileSync(doomed, 'bye\n')
    turns.recordBefore({ sessionId: 's1', turn: 3, cwd: workspace, path: 'doomed.txt' })
    rmSync(doomed)
    const diff = turns.turnDiff({ sessionId: 's1', turn: 3 })
    check('diff: deleted file is 删除', diff.files?.[0]?.status === 'deleted', JSON.stringify(diff.files?.[0]?.status))
  }

  {
    const big = join(workspace, 'big.bin')
    writeFileSync(big, Buffer.alloc(4 * 1024 * 1024 + 16, 1))
    const recorded = turns.recordBefore({ sessionId: 's2', turn: 1, cwd: workspace, path: 'big.bin' })
    check('record: oversized file is marked, not copied', recorded.ok === true && recorded.tooBig === true, JSON.stringify(recorded))
    const diff = turns.turnDiff({ sessionId: 's2', turn: 1 })
    check('diff: oversized file is skipped with a reason', diff.files?.[0]?.status === 'skipped' && String(diff.files?.[0]?.reason).includes('MB'), JSON.stringify(diff.files?.[0]))
  }

  {
    const list = turns.listTurns({ sessionId: 's1' })
    check('list: turns are newest first', list.turns.length >= 3 && list.turns[0].turn > list.turns[1].turn, JSON.stringify(list.turns))
    check('list: unknown session is empty', turns.listTurns({ sessionId: 'nope' }).turns.length === 0)
  }
} catch (error) {
  check('suite ran without throwing', false, String(error?.stack ?? error))
} finally {
  rmSync(workspace, { recursive: true, force: true })
  rmSync(dataRoot, { recursive: true, force: true })
}

finish(results, 10000)
