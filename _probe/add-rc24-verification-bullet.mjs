#!/usr/bin/env node
/**
 * Insert one verification bullet into the rc.24 release notes.
 *
 * The notes are UTF-8 without a BOM and predominantly LF, with two stray CRLF lines further
 * down (185-186) that this must leave alone. Windows PowerShell 5.1 reads and writes these
 * files in the ANSI code page, which double-encodes CJK, so this runs under Node instead.
 *
 * Prints what it changed and refuses to write unless the anchor matched exactly once.
 */

import { readFileSync, writeFileSync } from 'node:fs'

const path = 'D:\\projects-py\\Harness-CN\\harness-0.1.5-rc.1\\RELEASE-NOTES-v0.1.5-rc.24.md'

const original = readFileSync(path, 'utf8')
console.log(`before: ${String(Buffer.byteLength(original, 'utf8'))} bytes`)

const anchor = '- **手机通路在本机实测**'
const insertAfter =
  '- 安装程序与离线包由同一条 `tauri build` 链路产出，`cargo check --release` 与各 app 的 `tsc` 通过。'
const bullet =
  '- **离线包大小在构建时就卡住**：发布要同时发到 GitHub 与 Gitee，而 Gitee 的附件上限是 100 MB，所以离线包超过它就是一个谁也下载不到的包。本版的 `prepare-shell.mjs` 因此把 zstd 默认级别从 19 提到 22，并在归档后直接断言大小——rc.24 实测：19 级 124.1 MiB（超出，脚本会拒绝），22 级 97.0 MiB（通过）。内置 `dsh-mobile` 之后 19 级已经装不下，这一步是为了让下一次「加插件」在构建时就失败，而不是发布时才失败。'

const countOf = (haystack, needle) => haystack.split(needle).length - 1
if (countOf(original, anchor) !== 1) {
  throw new Error(`anchor appears ${String(countOf(original, anchor))} times, expected 1: ${anchor}`)
}
const anchorAt = original.indexOf(anchor)
const lineAt = original.indexOf(insertAfter, anchorAt)
if (lineAt === -1) throw new Error(`insertion line not found after the anchor: ${insertAfter}`)
if (countOf(original, insertAfter) !== 1) {
  throw new Error(`insertion line appears ${String(countOf(original, insertAfter))} times, expected 1`)
}

// Walk to the end of that line's own terminator so the new bullet becomes its own line and
// keeps whatever line ending the surrounding text already uses.
const lfAt = original.indexOf('\n', lineAt)
if (lfAt === -1) throw new Error('insertion line has no terminator')
const terminator = lfAt > 0 && original[lfAt - 1] === '\r' ? '\r\n' : '\n'
const updated = original.slice(0, lfAt + 1) + bullet + terminator + original.slice(lfAt + 1)

writeFileSync(path, updated, 'utf8')

const verify = readFileSync(path, 'utf8')
console.log(`after : ${String(Buffer.byteLength(verify, 'utf8'))} bytes`)
console.log(`bullet present : ${String(verify.includes('离线包大小在构建时就卡住'))}`)
console.log(`CRLF count now : ${String(countOf(verify, '\r\n'))} (expected 2)`)
console.log(`terminator used: ${JSON.stringify(terminator)}`)

const lines = verify.split('\n')
const at = lines.findIndex((line) => line.startsWith('- **离线包大小在构建时就卡住**'))
console.log(`inserted at line: ${String(at + 1)}`)
console.log(`  prev: ${lines[at - 1].slice(0, 70)}`)
console.log(`  next: ${lines[at + 1].slice(0, 70)}`)
