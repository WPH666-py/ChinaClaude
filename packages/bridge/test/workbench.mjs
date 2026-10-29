/**
 * Workbench port: tree, preview, search, changes.
 *
 * The suite calls the module directly (no HTTP): the route layer is a thin pass-through that the
 * e2e/lan suites already cover, while the interesting rules live here — path confinement, preview
 * caps, and the "git is missing but the panel still answers" degradation.
 *
 * Every case builds its own throwaway workspace, so a failure never depends on the checkout this
 * suite happens to run in.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { finish, makeCheck } from './harness.mjs'
import { workbenchChanges, workbenchFile, workbenchSearch, workbenchTree } from '../src/workbench.mjs'

const results = []
const check = makeCheck(results)

const root = mkdtempSync(join(tmpdir(), 'cccn-workbench-'))
const outside = mkdtempSync(join(tmpdir(), 'cccn-workbench-outside-'))

try {
  mkdirSync(join(root, 'src'))
  mkdirSync(join(root, 'node_modules'))
  writeFileSync(join(root, 'README.md'), '# 标题\n\n正文一行\n')
  writeFileSync(join(root, 'src', 'index.mjs'), "export const value = 'needle'\n// second line\n")
  writeFileSync(join(root, 'data.bin'), Buffer.from([0x00, 0x01, 0x02, 0x03]))
  // 1x1 transparent PNG: a real image header, so the data-URL branch is exercised end to end.
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64',
  )
  writeFileSync(join(root, 'pixel.png'), png)
  writeFileSync(join(outside, 'secret.txt'), 'should never be readable through the workspace')

  {
    const answer = workbenchTree({ cwd: root })
    check('tree: ok', answer.ok === true, answer.error)
    const names = (answer.entries ?? []).map((entry) => entry.name)
    check('tree: lists files', names.includes('README.md'))
    const dirsFirst = (answer.entries ?? []).map((entry) => entry.type)
    const firstFile = dirsFirst.indexOf('file')
    const lastDir = dirsFirst.lastIndexOf('dir')
    check('tree: directories sort first', lastDir === -1 || firstFile === -1 || lastDir < firstFile)
    const heavy = (answer.entries ?? []).find((entry) => entry.name === 'node_modules')
    check('tree: heavy directory is marked, not hidden', heavy?.heavy === true)
  }

  {
    const answer = workbenchTree({ cwd: root, path: 'src' })
    check('tree: nested path resolves', answer.ok === true && answer.path === 'src', answer.error)
    check('tree: parent points back', answer.parent === '')
  }

  {
    const escape = workbenchTree({ cwd: root, path: '../' })
    check('tree: .. escape refused', escape.ok === false, escape.error)
    const absolute = workbenchTree({ cwd: root, path: 'C:\\Windows' })
    check('tree: absolute path refused', absolute.ok === false, absolute.error)
    const sneaky = workbenchTree({ cwd: root, path: '..\\..\\..\\..\\..\\Windows' })
    check('tree: deep .. escape refused', sneaky.ok === false, sneaky.error)
  }

  {
    const text = workbenchFile({ cwd: root, path: 'src/index.mjs' })
    check('file: text preview', text.ok === true && text.kind === 'text', text.error)
    check('file: language detected', text.language === 'javascript', String(text.language))
    check('file: content is real', typeof text.text === 'string' && text.text.includes('needle'))

    const markdown = workbenchFile({ cwd: root, path: 'README.md' })
    check('file: markdown kind', markdown.kind === 'markdown')

    const image = workbenchFile({ cwd: root, path: 'pixel.png' })
    check('file: image inlined as data url', image.kind === 'image' && String(image.dataUrl).startsWith('data:image/png;base64,'))

    const binary = workbenchFile({ cwd: root, path: 'data.bin' })
    check('file: binary has no content', binary.kind === 'binary' && binary.text === undefined)

    const directory = workbenchFile({ cwd: root, path: 'src' })
    check('file: directory is refused', directory.ok === false, directory.error)

    const escape = workbenchFile({ cwd: root, path: '../' + 'cccn-workbench-outside/secret.txt' })
    check('file: outside path refused', escape.ok === false, escape.error)
  }

  {
    const found = workbenchSearch({ cwd: root, query: 'needle' })
    check('search: finds a hit', found.ok === true && found.hits.length === 1, JSON.stringify(found.hits?.[0] ?? null))
    check('search: reports the line number', found.hits?.[0]?.line === 1, String(found.hits?.[0]?.line))
    check('search: hit carries the path', found.hits?.[0]?.path === 'src/index.mjs', found.hits?.[0]?.path)

    const empty = workbenchSearch({ cwd: root, query: '   ' })
    check('search: empty query refused', empty.ok === false, empty.error)

    const binarySkipped = workbenchSearch({ cwd: root, query: '\u0000' })
    check('search: binary files do not produce hits', binarySkipped.ok === true && binarySkipped.hits.length === 0)
  }

  {
    // No git repository here, on purpose: the panel must degrade to a sentence, not an empty list
    // that reads as "nothing changed".
    const changes = await workbenchChanges({ cwd: root })
    check('changes: answers without git', changes.ok === true, changes.error)
    check('changes: says git is unavailable', changes.git?.ok === false, JSON.stringify(changes.git ?? null))
    check('changes: carries a reason', typeof changes.git?.error === 'string' && changes.git.error.length > 0)
    check('changes: empty file list rather than invented entries', Array.isArray(changes.files) && changes.files.length === 0)
  }

  {
    const large = join(root, 'big.txt')
    writeFileSync(large, 'x'.repeat(1024 * 1024 + 4096))
    const preview = workbenchFile({ cwd: root, path: 'big.txt' })
    check('file: oversized text is truncated', preview.truncated === true, String(preview.text?.length))
    check('file: truncated text is capped', (preview.text?.length ?? 0) <= 1024 * 1024)
  }
} catch (error) {
  check('suite ran without throwing', false, String(error?.stack ?? error))
} finally {
  rmSync(root, { recursive: true, force: true })
  rmSync(outside, { recursive: true, force: true })
}

finish(results)
