/**
 * Directory browser API checks.
 *
 * Run: node packages/bridge/test/directories.mjs
 * Exercises the module directly (no server needed) so failures point at the logic.
 */
import { listDirectories, listRoots, resolveInputPath } from '../src/directories.mjs'
import { homedir } from 'node:os'
import { join, parse } from 'node:path'

const results = []
function check(name, ok, detail = '') {
  results.push({ name, ok })
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${name}${detail ? '  — ' + detail : ''}`)
}

const HOME = homedir()
console.log(`home = ${HOME}`)

console.log('\n=== roots ===')
const roots = listRoots()
check('roots are non-empty', roots.length > 0, `${roots.length} entries`)
check('home folder is offered', roots.some((root) => root.path === HOME))
check(
  'every root exists and is a directory',
  roots.every((root) => {
    try {
      return listDirectories(root.path).path === root.path
    } catch {
      return false
    }
  }),
)
if (process.platform === 'win32') {
  check('drives are enumerated on Windows', roots.some((root) => /^[A-Z]:\\$/.test(root.path)), roots.map((r) => r.label).join(', '))
}

console.log('\n=== path resolution ===')
check('empty input falls back to home', resolveInputPath('') === HOME)
check('~ resolves to home', resolveInputPath('~') === HOME)
check('~/suffix resolves under home', resolveInputPath('~/project').startsWith(HOME))
check('absolute path is preserved', resolveInputPath('D:\\Claudecode-CN') === 'D:\\Claudecode-CN')

console.log('\n=== listing ===')
const projectRoot = listDirectories('D:\\Claudecode-CN')
check('returns the resolved path', projectRoot.path === 'D:\\Claudecode-CN')
check('lists subdirectories', projectRoot.entries.length > 0, `${projectRoot.entries.length} entries`)
check(
  'every entry is a real directory',
  projectRoot.entries.every((entry) => {
    try {
      return listDirectories(entry.path).path === entry.path
    } catch {
      return false
    }
  }),
)
check('entries are sorted by name', (() => {
  const names = projectRoot.entries.map((entry) => entry.name)
  const sorted = [...names].sort((a, b) => a.localeCompare(b, 'zh-CN'))
  return JSON.stringify(names) === JSON.stringify(sorted)
})())
check('hidden folders are filtered by default', !projectRoot.entries.some((entry) => entry.name.startsWith('.')))
check('node_modules is filtered by default', !projectRoot.entries.some((entry) => entry.name === 'node_modules'))
check('includeHidden reveals them', listDirectories('D:\\Claudecode-CN', { includeHidden: true }).entries.some((entry) => entry.name === 'node_modules'))

console.log('\n=== profile noise (legacy shell junctions) ===')
const profile = listDirectories(HOME)
const noiseNames = ['Application Data', 'Cookies', 'NetHood', 'PrintHood', 'Recent', 'SendTo', 'Templates', 'Local Settings']
const leaked = profile.entries.filter((entry) => noiseNames.includes(entry.name))
check('legacy shell junctions are hidden', leaked.length === 0, leaked.map((e) => e.name).join(', ') || 'none')
check('AppData is hidden', !profile.entries.some((entry) => entry.name === 'AppData'))
check('real folders still show', profile.entries.length > 0, `${profile.entries.length} entries`)
check('parent is reported', projectRoot.parent === parse(projectRoot.path).dir)

console.log('\n=== drive root (no parent) ===')
const driveRoot = listDirectories('D:\\')
check('drive root has no parent', driveRoot.parent === null)
check('drive root is flagged as root', driveRoot.isRoot === true)
check('drive root lists entries', driveRoot.entries.length > 0, `${driveRoot.entries.length} entries`)

console.log('\n=== error paths ===')
let enoent = false
try {
  listDirectories('D:\\definitely-not-a-real-directory-xyz')
} catch (error) {
  enoent = error.code === 'ENOENT'
}
check('missing directory throws ENOENT', enoent)

let enotdir = false
try {
  // A file, not a directory.
  listDirectories('D:\\Claudecode-CN\\package.json')
} catch (error) {
  enotdir = error.code === 'ENOTDIR'
}
check('file path throws ENOTDIR', enotdir)

const failed = results.filter((r) => !r.ok)
console.log(`\n=== ${results.length - failed.length}/${results.length} checks passed ===`)
process.exit(failed.length === 0 ? 0 : 1)
