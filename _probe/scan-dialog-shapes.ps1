# Extract the code context around named dialog kinds, tolerating binary separators.
#
# The naive "runs of printable ASCII" approach missed every hit because these literals sit
# next to NUL bytes (they are in a binary table), so the neighbourhood regex must allow any
# non-newline byte rather than only printable ones.
param(
  [string]$Exe = 'D:\Claudecode-CN\_probe\package\claude.exe',
  [int]$Seconds = 200,
  [string[]]$Kinds = @('refusal_fallback_prompt', 'get_sandbox_dialog', 'get_memory_dialog', 'get_skills_dialog', 'elicitation_url_dialog', 'request_user_dialog')
)

$fs = [System.IO.File]::OpenRead($Exe)
$chunkSize = 8MB
$carry = ''
$hits = New-Object System.Collections.Generic.List[string]
$counts = @{}
foreach ($k in $Kinds) { $counts[$k] = 0 }
$sw = [System.Diagnostics.Stopwatch]::StartNew()

# Any byte except NUL and newlines: enough to read a JS object literal sitting in a table.
$pattern = '(?s)[^\x00\r\n]{0,200}KIND[^\x00\r\n]{0,240}'

while ($sw.Elapsed.TotalSeconds -lt $Seconds) {
  $bytes = New-Object byte[] $chunkSize
  $read = $fs.Read($bytes, 0, $chunkSize)
  if ($read -le 0) { break }
  $text = $carry + [System.Text.Encoding]::Latin1.GetString($bytes, 0, $read)

  foreach ($kind in $Kinds) {
    $rx = $pattern.Replace('KIND', [regex]::Escape($kind))
    foreach ($m in [regex]::Matches($text, $rx)) {
      $counts[$kind]++
      $value = ($m.Value -replace '\s+', ' ')
      if ($value.Length -gt 40) { $hits.Add("[$kind] $value") }
    }
  }

  if ($text.Length -gt 512) { $carry = $text.Substring($text.Length - 512) } else { $carry = $text }
}
$fs.Close()

Write-Host '=== hit counts ==='
foreach ($k in $Kinds) { Write-Host ("  {0,-28} {1}" -f $k, $counts[$k]) }
Write-Host ''
Write-Host "=== samples (of $($hits.Count)) ==="
foreach ($h in ($hits | Select-Object -First 24)) { Write-Host $h; Write-Host '' }
