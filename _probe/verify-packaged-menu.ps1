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

# --- staged bridge vs source ---------------------------------------------------
# The check that would have caught a real mistake: `tauri build` on its own does NOT re-stage the
# sidecar, so a release can ship a NEW web bundle with an OLD bridge. That happened while building
# 0.2.1, and every endpoint still answered — nothing else noticed. Compare hashes before trusting
# anything the app says below.
$failures = 0
$srcDir = 'D:\Claudecode-CN\packages\bridge\src'
$dstDir = 'D:\Claudecode-CN\packages\desktop\src-tauri\resources\sidecar\bridge'
$drifted = @()
Get-ChildItem $srcDir -Filter '*.mjs' | ForEach-Object {
  $staged = Join-Path $dstDir $_.Name
  if (-not (Test-Path $staged)) { $drifted += "$($_.Name) (missing)"; return }
  if ((Get-FileHash $_.FullName -Algorithm SHA256).Hash -ne (Get-FileHash $staged -Algorithm SHA256).Hash) {
    $drifted += $_.Name
  }
}
if ($drifted.Count -gt 0) {
  Write-Host "  FAIL  sidecar drift — 先跑 node packages/desktop/scripts/prepare-sidecar.mjs：$($drifted -join ', ')"
  $failures++
} else {
  Write-Host '  PASS  staged bridge matches packages/bridge/src'
}

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
# NOT reset here: a sidecar-drift failure recorded above must survive into the final verdict.

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

# 这行固定在 0.2.0，发 0.2.1 时它就开始说谎，所以注释掉、改用下面那条从配置读版本的检查：
# Check 'health reports appVersion 0.2.0' '/api/health' { param($b) $b.ok -eq $true -and $b.appVersion -eq '0.2.0' }   # superseded below by the config-derived check
Check 'plugin manager lists 10 built-in plugins' '/api/plugins' { param($b) $b.plugins.Count -eq 10 -and ($b.plugins | Where-Object { $_.bundled -ne $true }).Count -eq 0 }
Check 'log ring serves lines (cursor API)' '/api/shell/logs' { param($b) $b.lastSeq -ge 1 -and $b.file -ne $null }
Check 'author card' '/api/shell/author' { param($b) $b.wechat -ne $null -and $b.intro.Count -ge 1 }
Check 'shop catalogue' '/api/shop/catalog' { param($b) $b.products.Count -eq 9 }
Check 'rules seeded on first run' '/api/rules' { param($b) $b.ok -eq $true -and $b.rules.Count -ge 3 }
Check 'defend stats' '/api/defend' { param($b) $b.ok -eq $true -and $b.stats -ne $null }
Check 'git reports honestly' '/api/git?what=available' { param($b) $b.ok -eq $true }   # available may legitimately be false
Check 'vision status (modlens present in the bundle)' '/api/vision/status' { param($b) $b.cli -ne $null }

# The version check reads the config the build actually used: a hardcoded number here went stale on
# the very next release, which is how a checker quietly starts lying about the artifact it checked.
Check 'health reports the configured appVersion' '/api/health' {
  param($b)
  $expected = (Get-Content 'D:\Claudecode-CN\packages\desktop\src-tauri\tauri.conf.json' -Raw | ConvertFrom-Json).version
  $b.ok -eq $true -and $b.appVersion -eq $expected
}

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

# --- 发送路径的两个新行为（0.2.1）---------------------------------------------
# 这两条是「窗口能用」与「真的起作用」的分界线，而且它们是纯 HTTP 可测的：
# 记忆注入进 argv（读真实子进程命令行）、拦截级命中在发送前把这一轮挡下来。

$wsDir = Join-Path $DataDir 'ws'
New-Item -ItemType Directory -Force -Path $wsDir | Out-Null
Set-Content -Path (Join-Path $wsDir 'readme.txt') -Value 'hi' -Encoding UTF8
$null = Invoke-RestMethod -Uri "$base/api/memory" -Method Post -ContentType 'application/json' `
  -Body (@{ action = 'add'; cwd = $wsDir; text = '这个工作区的构建走 pnpm'; kind = 'decision'; tags = @('构建') } | ConvertTo-Json) `
  -TimeoutSec 20 -UseBasicParsing
$session = Invoke-RestMethod -Uri "$base/api/sessions" -Method Post -ContentType 'application/json' `
  -Body (@{ cwd = $wsDir } | ConvertTo-Json) -TimeoutSec 30 -UseBasicParsing
Start-Sleep -Seconds 4
$claudeCmd = (Get-CimInstance Win32_Process -Filter "Name = 'claude.exe'" -ErrorAction SilentlyContinue |
  Select-Object -ExpandProperty CommandLine) -join "`n"
if ($claudeCmd -match '--append-system-prompt' -and $claudeCmd -match 'pnpm') {
  Write-Host '  PASS  claude.exe argv carries --append-system-prompt with the memory text'
} elseif ($claudeCmd -eq '') {
  Write-Host '  SKIP  no claude.exe running (the app may not have started a session yet)'
} else {
  Write-Host '  FAIL  --append-system-prompt missing from claude.exe argv'
  $failures++
}

# 拦截级命中：发送前应该 409 + needsConfirm，而不是直接发出去。
$danger = 'r' + 'm' + ' -r' + 'f / tmp-clean'   # assembled so this file does not look dangerous itself
try {
  $held = Invoke-RestMethod -Uri "$base/api/sessions/$($session.id)/messages" -Method Post -ContentType 'application/json' `
    -Body (@{ text = $danger } | ConvertTo-Json) -TimeoutSec 20 -UseBasicParsing -ErrorAction Stop
  Write-Host "  FAIL  dangerous prompt was accepted: $($held | ConvertTo-Json -Compress)"; $failures++
} catch {
  $body = $null
  try { $body = $_.ErrorDetails.Message | ConvertFrom-Json } catch { }
  if ($body.needsConfirm -eq $true -and $body.blockers.Count -ge 1) {
    Write-Host "  PASS  send path held a dangerous prompt for confirmation（$($body.blockers.Count) 项）"
  } else {
    Write-Host "  FAIL  expected 409 needsConfirm, got: $($_.Exception.Message)"; $failures++
  }
}

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
