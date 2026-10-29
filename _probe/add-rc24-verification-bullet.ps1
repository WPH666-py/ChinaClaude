# Insert one verification bullet into the rc.24 release notes.
#
# The notes are UTF-8 without a BOM and predominantly LF, with two stray CRLF lines further
# down (185-186) that this must leave alone. PowerShell 5.1's Get-Content/Set-Content default
# to the ANSI code page on this machine and double-encode CJK, so the text is read and written
# through the .NET UTF-8 APIs explicitly.

$ErrorActionPreference = 'Stop'

$path = 'D:\projects-py\Harness-CN\harness-0.1.5-rc.1\RELEASE-NOTES-v0.1.5-rc.24.md'
$encoding = New-Object System.Text.UTF8Encoding($false)

$original = $encoding.GetString([System.IO.File]::ReadAllBytes($path))
Write-Host ("before: {0} bytes" -f (Get-Item -LiteralPath $path).Length)

$anchor = '- **手机通路在本机实测**'
$insertAfter = '- 安装程序与离线包由同一条 `tauri build` 链路产出，`cargo check --release` 与各 app 的 `tsc` 通过。'
$bullet = '- **离线包大小在构建时就卡住**：发布要同时发到 GitHub 与 Gitee，而 Gitee 的附件上限是 100 MB，所以离线包超过它就是一个谁也下载不到的包。本版的 `prepare-shell.mjs` 因此把 zstd 默认级别从 19 提到 22，并在归档后直接断言大小——rc.24 实测：19 级 124.1 MiB（超出，脚本会拒绝），22 级 97.0 MiB（通过）。内置 `dsh-mobile` 之后 19 级已经装不下，这一步是为了让下一次「加插件」在构建时就失败，而不是发布时才失败。'

$anchorAt = $original.IndexOf($anchor)
if ($anchorAt -lt 0) { throw "anchor not found: $anchor" }
$insertAt = $original.IndexOf($insertAfter, $anchorAt)
if ($insertAt -lt 0) { throw "insertion line not found: $insertAfter" }

# Walk to the end of that line's line terminator, then insert a whole new line there.
$lineEnd = $original.IndexOf("`n", $insertAt)
if ($lineEnd -lt 0) { throw 'insertion line has no terminator' }
$insertionPoint = $lineEnd + 1
# The file is LF; this must be a real newline, not the two characters "`n".
$terminator = "`n"

$updated = $original.Substring(0, $insertionPoint) + $bullet + $terminator + $original.Substring($insertionPoint)

[System.IO.File]::WriteAllBytes($path, $encoding.GetBytes($updated))

$verify = $encoding.GetString([System.IO.File]::ReadAllBytes($path))
Write-Host ("after : {0} bytes" -f (Get-Item -LiteralPath $path).Length)
Write-Host ("bullet present   : {0}" -f $verify.Contains('离线包大小在构建时就卡住'))
Write-Host ("CRLF count now   : {0} (expected 2)" -f ([regex]::Matches($verify, "`r`n")).Count)
Write-Host ("total lines      : {0}" -f (($verify -split "`n").Count))

$lines = $verify -split "`n"
for ($n = 0; $n -lt $lines.Count; $n++) {
  if ($lines[$n].StartsWith('- **离线包大小在构建时就卡住**')) {
    Write-Host ("inserted at line : {0}" -f ($n + 1))
    Write-Host ("previous line    : {0}" -f $lines[$n - 1].Substring(0, [Math]::Min(60, $lines[$n - 1].Length)))
    Write-Host ("next line        : {0}" -f $lines[$n + 1].Substring(0, [Math]::Min(60, $lines[$n + 1].Length)))
  }
}
