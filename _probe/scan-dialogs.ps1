# Bounded scan of the CLI binary for `request_user_dialog` kind literals.
#
# The SDK does not enumerate dialog kinds (it is an open string union), so the only source of
# truth for what can actually arrive is the binary. The scan is time-boxed and reads in chunks
# because a full regex sweep of a 231 MB image is slow enough to matter.
param(
  [string]$Exe = 'D:\Claudecode-CN\_probe\package\claude.exe',
  [int]$Seconds = 240
)

$fs = [System.IO.File]::OpenRead($Exe)
$chunkSize = 8MB
$carry = ''
$kinds = [System.Collections.Generic.HashSet[string]]::new()
$context = [System.Collections.Generic.HashSet[string]]::new()
$sw = [System.Diagnostics.Stopwatch]::StartNew()

while ($sw.Elapsed.TotalSeconds -lt $Seconds) {
  $bytes = New-Object byte[] $chunkSize
  $read = $fs.Read($bytes, 0, $chunkSize)
  if ($read -le 0) { break }
  $text = $carry + [System.Text.Encoding]::ASCII.GetString($bytes, 0, $read)

  # Kind literals look like '<words>_prompt' / '<words>_dialog' / '<words>_choice'.
  foreach ($m in [regex]::Matches($text, '\b[a-z][a-z0-9]*(?:_[a-z0-9]+){1,4}_(?:prompt|dialog|choice|picker|confirm)\b')) {
    [void]$kinds.Add($m.Value)
  }
  # Anything printed near the wire field name is likely a real kind.
  foreach ($m in [regex]::Matches($text, 'dialog_kind[^\x00-\x1f]{0,60}')) {
    [void]$context.Add(($m.Value -replace '\s+', ' '))
  }

  if ($text.Length -gt 128) { $carry = $text.Substring($text.Length - 128) } else { $carry = $text }
}

$fs.Close()

Write-Host "=== candidate dialog kinds ($($kinds.Count)) ==="
$kinds | Sort-Object | ForEach-Object { Write-Host "  $_" }

Write-Host ''
Write-Host "=== dialog_kind context strings ($($context.Count)) ==="
$context | Sort-Object | Select-Object -First 40 | ForEach-Object { Write-Host "  $_" }
