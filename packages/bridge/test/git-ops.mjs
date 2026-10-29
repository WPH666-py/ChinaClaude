/**
 * Git port: the parts that can be proven on a machine WITHOUT git, plus a full round-trip when one is
 * installed.
 *
 * WHY THE SUITE IS SPLIT: this reference machine has no git binary, and a suite that silently reports
 * "0 checks passed" would be a lie. So the guardrail checks (input validation, confirm requirements, the
 * missing-repository sentence) always run — they are the ones that fire before git is involved — and the
 * mutation round-trip runs only when `gitAvailable()` finds a binary, printing an explicit SKIP otherwise.
 *
 * Nothing here touches a real repository: the mutation section builds its own throwaway repo under the
 * OS temp directory, with `-c user.email/-c user.name` so it never reads or writes global config.
 */
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { finish, makeCheck } from './harness.mjs'
import {
  gitAvailable,
  gitBranches,
  gitCheckout,
  gitDiscard,
  gitStage,
  gitStashList,
  gitStashSave,
  gitStashUse,
  gitStatus,
  gitUnstage,
} from '../src/gitpanel.mjs'

const results = []
const check = makeCheck(results)

const scratch = mkdtempSync(join(tmpdir(), 'cccn-git-'))
const notARepo = join(scratch, 'plain')
const repo = join(scratch, 'repo')
mkdirSync(notARepo, { recursive: true })

try {
  const availability = await gitAvailable()
  check('availability: the probe answers', availability.ok === true, availability.error)
  console.log(`  INFO  git ${availability.available ? `found at ${availability.path}` : 'not installed on this machine'}`)

  // ---- guardrails (independent of whether git exists) -------------------------------------------
  {
    const wildcard = await gitStage({ cwd: repo, files: ['*.mjs'] })
    check('stage: wildcard refused', wildcard.ok === false && String(wildcard.error).includes('通配符'), wildcard.error)

    const noCwd = await gitStage({ cwd: '', files: ['a.txt'] })
    check('stage: missing workspace refused', noCwd.ok === false, noCwd.error)

    const unstageNothing = await gitUnstage({ cwd: repo, files: [] })
    check('unstage: empty list refused', unstageNothing.ok === false, unstageNothing.error)

    const discardNoConfirm = await gitDiscard({ cwd: repo, path: 'a.txt' })
    check(
      'discard: requires explicit confirm',
      discardNoConfirm.ok === false && String(discardNoConfirm.error).includes('确认'),
      discardNoConfirm.error,
    )

    const badSlot = await gitStashUse({ cwd: repo, index: 'x', action: 'apply' })
    check('stash: non-numeric slot refused', badSlot.ok === false && String(badSlot.error).includes('序号'), badSlot.error)

    const badAction = await gitStashUse({ cwd: repo, index: 0, action: 'explode' })
    check('stash: unknown action refused', badAction.ok === false && String(badAction.error).includes('未知'), badAction.error)

    const dropNoConfirm = await gitStashUse({ cwd: repo, index: 0, action: 'drop' })
    check(
      'stash: drop requires explicit confirm',
      dropNoConfirm.ok === false && String(dropNoConfirm.error).includes('确认'),
      dropNoConfirm.error,
    )

    const missingDir = await gitBranches({ cwd: join(scratch, 'does-not-exist') })
    check('branches: missing directory is a sentence', missingDir.ok === false && String(missingDir.error).includes('不存在'), missingDir.error)

    const plain = await gitStatus({ cwd: notARepo })
    check('status: non-repository degrades with a sentence', plain.ok === false && String(plain.error).includes('仓库'), plain.error)
  }

  // ---- full round-trip, only when git exists -----------------------------------------------------
  if (!availability.available) {
    console.log('  SKIP  staging / branch / stash round-trip — no git binary on this machine')
    results.push({ name: 'git round-trip (skipped: no git binary)', ok: true })
  } else {
    const git = (...args) => execFileSync(availability.path ?? 'git', ['-c', 'user.email=test@example.com', '-c', 'user.name=Test', ...args], { cwd: repo, encoding: 'utf8' })
    mkdirRepo()
    writeFileSync(join(repo, 'a.txt'), 'one\n')
    writeFileSync(join(repo, 'b.txt'), 'two\n')
    git('add', '.')
    git('commit', '-m', 'init')

    writeFileSync(join(repo, 'a.txt'), 'one changed\n')
    writeFileSync(join(repo, 'new.txt'), 'new\n')

    {
      const stagedAll = await gitStage({ cwd: repo, files: ['a.txt', 'new.txt'] })
      check('round-trip: stage two files', stagedAll.ok === true, stagedAll.error)
      const status = await gitStatus({ cwd: repo })
      check(
        'round-trip: both are staged',
        status.ok === true && (status.files ?? []).filter((file) => file.staged).length === 2,
        JSON.stringify(status.files ?? []),
      )

      const unstaged = await gitUnstage({ cwd: repo, files: ['new.txt'] })
      check('round-trip: unstage one file', unstaged.ok === true, unstaged.error)

      const discarded = await gitDiscard({ cwd: repo, path: 'a.txt', confirm: true })
      check('round-trip: discard a tracked change', discarded.ok === true, discarded.error)

      // `git stash push` ignores untracked files by design, so give it a tracked change to save.
      writeFileSync(join(repo, 'a.txt'), 'again\n')
      const saved = await gitStashSave({ cwd: repo, message: 'wip' })
      check('round-trip: stash save', saved.ok === true, saved.error)
      const list = await gitStashList({ cwd: repo })
      check('round-trip: stash listed', list.ok === true && (list.entries ?? []).length === 1, JSON.stringify(list.entries ?? []))
      const popped = await gitStashUse({ cwd: repo, index: 0, action: 'pop' })
      check('round-trip: stash pop', popped.ok === true, popped.error)

      const created = await gitCheckout({ cwd: repo, branch: 'feature' })
      check('round-trip: remote-less branch checkout is refused', created.ok === false, created.error)

      const branches = await gitBranches({ cwd: repo })
      check('round-trip: branches listed', branches.ok === true && (branches.branches ?? []).length >= 1, JSON.stringify(branches.branches ?? []))
    }

    function mkdirRepo() {
      execFileSync(availability.path ?? 'git', ['init', '-q', '-b', 'main', repo], { encoding: 'utf8' })
    }
  }
} catch (error) {
  check('suite ran without throwing', false, String(error?.stack ?? error))
} finally {
  rmSync(scratch, { recursive: true, force: true })
}

finish(results)
