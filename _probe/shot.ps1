# Screenshot one UI route in headless Edge.
#
# DPI awareness must be set BEFORE any window calls: without it GetWindowRect returns logical pixels
# while PrintWindow captures physical ones, which produces a correct-looking image with blank padding
# and led to a false "layout is clipped" diagnosis earlier in this project.
param(
  [string]$Url = 'http://127.0.0.1:5180/',
  [string]$Out = 'D:\Claudecode-CN\_probe\shot.png',
  [int]$Width = 1440,
  [int]$Height = 900,
  [int]$WaitMs = 3500
)

Add-Type -AssemblyName System.Drawing

$edge = @(
  "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe",
  "${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe"
) | Where-Object { Test-Path $_ } | Select-Object -First 1

if (-not $edge) { Write-Error 'msedge.exe not found'; exit 1 }

# An isolated profile keeps a stale running instance from answering with the wrong window.
$profile = Join-Path $env:TEMP "cccn-shot-$([guid]::NewGuid().ToString('N').Substring(0,8))"
New-Item -ItemType Directory -Force -Path $profile | Out-Null

$args = @(
  '--headless=new',
  '--disable-gpu',
  '--hide-scrollbars',
  "--user-data-dir=$profile",
  "--window-size=$Width,$Height",
  "--screenshot=$Out",
  "--virtual-time-budget=$WaitMs",
  $Url
)

Write-Host "capturing $Url -> $Out"
$proc = Start-Process -FilePath $edge -ArgumentList $args -PassThru -Wait -NoNewWindow
Write-Host "edge exit=$($proc.ExitCode)"

if (Test-Path $Out) {
  $info = Get-Item $Out
  Write-Host "wrote $($info.Length) bytes"
} else {
  Write-Error "no screenshot produced"
  exit 1
}

Remove-Item -Recurse -Force $profile -ErrorAction SilentlyContinue
