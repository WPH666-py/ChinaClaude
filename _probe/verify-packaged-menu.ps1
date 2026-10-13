# Verify the PACKAGED app end to end: launch the release binary, discover the bridge port from the
# bridge's own process tree, then exercise the menu-bar endpoints over HTTP.
#
# WHY NOT `verify-package.ps1`: that script looks for the listening port on the APP's pid, but the
# bridge listens in a CHILD node.exe process, so it reports "no bridge port discovered" even while
# the bridge is demonstrably running (its child list shows exactly that). This script walks the
# process tree instead — parent -> node.exe -> listening port — and then asks the bridge itself.
#
# Usage: powershell -File _probe/verify-packaged-menu.mjs.ps1 [-Exe <path>] [-DataDir <path>]
param(
  [string]$Exe = 'D:\Claudecode-CN\packages\desktop\src-tauri\target\release\claude-code-cn.exe',
  [string]$DataDir = ''
)

$ErrorActionPreference = 'Continue'
$ProgressPreference = 'SilentlyContinue'

if (-not (Test-Path $Exe)) { throw "release binary missing: $Exe" }

# A throwaway data dir keeps the check from touching the user's real memory/rules/feedback.
$ownsDataDir = $false
if ($DataDir -eq '') {
  $DataDir = Join-Path $env:TEMP ("cccn-verify-" + [guid]::NewGuid().ToString('N').Substring(0, 8))
  $ownsDataDir = $true
}
New-Item -ItemType Directory -Force -Path $DataDir | Out-Null

Write-Host "=== launch $Exe"
Write-Host "    CCCN_DATA_DIR=$DataDir"
$env:CCCN_DATA_DIR = $DataDir
$app = Start-Process -FilePath $Exe -PassThru
Write-Host "    pid $($app.Id)"

function Get-ChildPids([int]$Parent) {
  $children = Get-CimInstance Win32_Process -Filter "ParentProcessId = $Parent" -ErrorAction SilentlyContinue
  $result = @()
  foreach ($child in $children) {
    $result += [int]$child.ProcessId
    $result += Get-ChildPids -Parent ([int]$child.ProcessId)
  }
  return $result
}

$bridgePort = $null
$bridgePid = $null
$deadline = (Get-Date).AddSeconds(60)
while ((Get-Date) -lt $deadline -and -not $bridgePort) {
  Start-Sleep -Seconds 2
  foreach ($childPid in (Get-ChildPids -Parent $app.Id)) {
    $listening = Get-NetTCPConnection -OwningProcess $childPid -State Listen -ErrorAction SilentlyContinue |
      Where-Object { $_.LocalAddress -in @('127.0.0.1', '0.0.0.0', '::1', '::') }
    if ($listening) {
      $bridgePort = ($listening | Select-Object -First 1).LocalPort
      $bridgePid = $childPid
      break
    }
  }
}

if (-not $bridgePort) {
  Write-Host 'FAIL: no listening bridge port found in the app process tree'
  Stop-Process -Id $app.Id -Force -ErrorAction SilentlyContinue
  exit 1
}

Write-Host "=== bridge found: pid $bridgePid on port $bridgePort"
$base = "http://127.0.0.1:$bridgePort"
$failures = 0

function Check([string]$Label, [string]$Path, [scriptblock]$Assert) {
  try {
    $body = Invoke-RestMethod -Uri "$base$Path" -TimeoutSec 20 -UseBasicParsing
    $ok = & $Assert $body
    if ($ok) { Write-Host ("  PASS  {0}" -f $Label) }
    else { Write-Host ("  FAIL  {0}  -> {1}" -f $Label, ($body | ConvertTo-Json -Compress -Depth 4)); $script:failures++ }
  } catch {
    Write-Host ("  FAIL  {0}  -> {1}" -f $Label, $_.Exception.Message)
    $script:failures++
  }
}

Check 'health reports appVersion 0.2.0' '/api/health' { param($b) $b.ok -eq $true -and $b.appVersion -eq '0.2.0' }
Check 'plugin manager lists 10 built-in plugins' '/api/plugins' { param($b) $b.plugins.Count -eq 10 -and ($b.plugins | Where-Object { $_.bundled -ne $true }).Count -eq 0 }
Check 'log ring serves lines (cursor API)' '/api/shell/logs' { param($b) $b.lastSeq -ge 1 -and $b.file -ne $null }
Check 'author card' '/api/shell/author' { param($b) $b.wechat -ne $null -and $b.intro.Count -ge 1 }
Check 'shop catalogue' '/api/shop/catalog' { param($b) $b.products.Count -eq 9 }
Check 'rules seeded on first run' '/api/rules' { param($b) $b.ok -eq $true -and $b.rules.Count -ge 3 }
Check 'defend stats' '/api/defend' { param($b) $b.ok -eq $true -and $b.stats -ne $null }
Check 'git reports honestly' '/api/git?what=available' { param($b) $b.ok -eq $true }   # available may legitimately be false
Check 'vision status (modlens present in the bundle)' '/api/vision/status' { param($b) $b.cli -ne $null }

# POST paths: a feedback row, a memory entry and a rules test, i.e. the write side of the menu bar.
try {
  $fb = Invoke-RestMethod -Uri "$base/api/feedback" -Method Post -ContentType 'application/json' -Body (@{ message = '打包验证'; email = 'verify@example.com' } | ConvertTo-Json) -TimeoutSec 20 -UseBasicParsing
  if ($fb.ok -eq $true -and $fb.mailto -ne $null) { Write-Host '  PASS  feedback saves and returns a mailto' } else { Write-Host "  FAIL  feedback -> $($fb | ConvertTo-Json -Compress)"; $failures++ }
} catch { Write-Host "  FAIL  feedback -> $($_.Exception.Message)"; $failures++ }

try {
  $mem = Invoke-RestMethod -Uri "$base/api/memory" -Method Post -ContentType 'application/json' -Body (@{ action = 'add'; cwd = 'D:\Claudecode-CN'; text = '打包验证写入'; kind = 'fact'; tags = @('verify') } | ConvertTo-Json) -TimeoutSec 20 -UseBasicParsing
  if ($mem.ok -eq $true -and $mem.entry.id -ne $null) { Write-Host '  PASS  memory accepts an entry' } else { Write-Host "  FAIL  memory -> $($mem | ConvertTo-Json -Compress)"; $failures++ }
} catch { Write-Host "  FAIL  memory -> $($_.Exception.Message)"; $failures++ }

try {
  $rules = Invoke-RestMethod -Uri "$base/api/rules" -Method Post -ContentType 'application/json' -Body (@{ action = 'test'; text = 'rm -rf / please test'; cwd = 'D:\Claudecode-CN' } | ConvertTo-Json) -TimeoutSec 20 -UseBasicParsing
  if ($rules.ok -eq $true -and $rules.hits.Count -ge 1) { Write-Host "  PASS  rules engine matched $($rules.hits.Count) rule(s)" } else { Write-Host "  FAIL  rules -> $($rules | ConvertTo-Json -Compress)"; $failures++ }
} catch { Write-Host "  FAIL  rules -> $($_.Exception.Message)"; $failures++ }

Write-Host '=== shutdown'
Stop-Process -Id $app.Id -Force -ErrorAction SilentlyContinue
Start-Sleep -Seconds 3
$orphans = Get-Process -Id $bridgePid -ErrorAction SilentlyContinue
if ($orphans) {
  Write-Host "  FAIL: bridge process $bridgePid outlived the app (killing it)"
  Stop-Process -Id $bridgePid -Force -ErrorAction SilentlyContinue
  $failures++
} else {
  Write-Host '  PASS  bridge did not outlive the app'
}

if ($ownsDataDir) {
  Remove-Item -Recurse -Force $DataDir -ErrorAction SilentlyContinue
}

if ($failures -eq 0) { Write-Host '=== ALL CHECKS PASSED'; exit 0 }
Write-Host "=== $failures CHECK(S) FAILED"
exit 1
