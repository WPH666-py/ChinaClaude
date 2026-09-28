# Verify the packaged desktop app actually boots and wires up its bridge.
#
# It runs the real release binary with a mock Anthropic backend, then re-discovers the
# bridge by enumerating the ports the process owns. That proves the whole chain:
#   exe -> sidecar node -> bridge -> claude.exe -> mock backend
$ErrorActionPreference = 'Continue'
$ProgressPreference = 'SilentlyContinue'

$exe = 'D:\Claudecode-CN\packages\desktop\src-tauri\target\release\claude-code-cn.exe'
$mockPort = 59921

if (-not (Test-Path $exe)) { throw "release binary missing: $exe" }

Write-Host '=== 1. start mock Anthropic backend ==='
$mock = Start-Process -FilePath 'node' `
  -ArgumentList 'D:\Claudecode-CN\packages\bridge\test\mock-server.mjs', '--port', "$mockPort", '--quiet' `
  -PassThru -WindowStyle Hidden
Start-Sleep -Seconds 2

try {
  $probe = Invoke-WebRequest "http://127.0.0.1:$mockPort/api/hello" -Method Head -UseBasicParsing -TimeoutSec 5
  Write-Host "  mock backend up (HEAD /api/hello -> $($probe.StatusCode))"
} catch {
  Write-Host "  mock backend not reachable: $($_.Exception.Message)"
}

Write-Host '=== 2. launch the packaged app ==='
$env:CCCN_BASE_URL = "http://127.0.0.1:$mockPort"
$env:CCCN_AUTH_TOKEN = 'sk-mock-token'
$app = Start-Process -FilePath $exe -PassThru
Write-Host "  pid $($app.Id) launched"

$bridgePort = $null
$deadline = (Get-Date).AddSeconds(60)
while ((Get-Date) -lt $deadline -and -not $bridgePort) {
  Start-Sleep -Seconds 2
  try {
    $ports = Get-NetTCPConnection -OwningProcess $app.Id -State Listen -ErrorAction SilentlyContinue |
      Where-Object { $_.LocalAddress -in @('127.0.0.1', '0.0.0.0', '::1', '::') }
    foreach ($candidate in $ports) {
      try {
        $health = Invoke-WebRequest "http://127.0.0.1:$($candidate.LocalPort)/api/health" -UseBasicParsing -TimeoutSec 2
        if ($health.Content -match '"ok":true') {
          $bridgePort = $candidate.LocalPort
          Write-Host "  bridge found on port $bridgePort"
          Write-Host "  health: $($health.Content)"
          break
        }
      } catch { }
    }
  } catch { }
}

if (-not $bridgePort) {
  Write-Host '  FAIL: no bridge port discovered under the app process'
  Write-Host '  child processes:'
  Get-CimInstance Win32_Process -Filter "ParentProcessId=$($app.Id)" |
    Select-Object ProcessId, Name, CommandLine | Format-List
} else {
  Write-Host '=== 3. drive one real turn through the packaged app''s bridge ==='
  $session = Invoke-WebRequest "http://127.0.0.1:$bridgePort/api/sessions" -Method Post `
    -ContentType 'application/json' -UseBasicParsing -TimeoutSec 20 `
    -Body (@{ cwd = 'D:\Claudecode-CN'; baseUrl = "http://127.0.0.1:$mockPort"; authToken = 'sk-mock-token' } | ConvertTo-Json)
  $sessionId = ($session.Content | ConvertFrom-Json).id
  Write-Host "  session: $sessionId"

  Start-Sleep -Seconds 2
  $accepted = Invoke-WebRequest "http://127.0.0.1:$bridgePort/api/sessions/$sessionId/messages" -Method Post `
    -ContentType 'application/json' -UseBasicParsing -TimeoutSec 20 `
    -Body (@{ text = 'verify packaged desktop app' } | ConvertTo-Json)
  Write-Host "  send accepted: $($accepted.StatusCode)"

  # Read the SSE stream briefly and report which event kinds arrived.
  $kinds = New-Object System.Collections.Generic.List[string]
  $client = [System.Net.Http.HttpClient]::new()
  $client.Timeout = [TimeSpan]::FromSeconds(25)
  try {
    $stream = $client.GetStreamAsync("http://127.0.0.1:$bridgePort/api/sessions/$sessionId/events").Result
    $reader = New-Object System.IO.StreamReader($stream)
    $sw = [System.Diagnostics.Stopwatch]::StartNew()
    while (-not $reader.EndOfStream -and $sw.Elapsed.TotalSeconds -lt 20) {
      $line = $reader.ReadLine()
      if ($line -and $line.StartsWith('data: ')) {
        try {
          $event = $line.Substring(6) | ConvertFrom-Json
          $kinds.Add($event.kind)
          if ($event.kind -eq 'result') { break }
        } catch { }
      }
    }
    $reader.Close()
  } catch {
    Write-Host "  stream read ended: $($_.Exception.Message)"
  } finally {
    $client.Dispose()
  }

  Write-Host "  event kinds: $($kinds -join ', ')"
  $unique = $kinds | Select-Object -Unique
  $ok = ($unique -contains 'init') -and ($unique -contains 'result')
  if ($ok) { Write-Host '  PASS: packaged app ran a full turn end-to-end' }
  else { Write-Host '  FAIL: expected init + result events' }
}

Write-Host '=== 4. shutdown ==='
if ($app -and -not $app.HasExited) {
  Stop-Process -Id $app.Id -Force -ErrorAction SilentlyContinue
  Write-Host '  app stopped'
}
Start-Sleep -Seconds 2
# The sidecar must not survive its parent.
$leftover = Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
  Where-Object { $_.CommandLine -like '*bridge*cli.mjs*' }
if ($leftover) {
  Write-Host "  WARNING: $($leftover.Count) bridge process(es) survived the app:"
  $leftover | ForEach-Object { Write-Host "    pid $($_.ProcessId)"; Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
} else {
  Write-Host '  PASS: no orphaned bridge process'
}
Stop-Process -Id $mock.Id -Force -ErrorAction SilentlyContinue
Write-Host 'done'
