# Launch the packaged app, click one top-menu item by screen coordinate, capture the window.
#
# Used to review the menu-bar windows without a test harness: the alternative is trusting that a
# Vue template renders, which is exactly the claim a screenshot is supposed to settle.
#
# Usage: powershell -File _probe/click-menu-item.ps1 -ClickX 711 -ClickY 154 -Out D:\...\shot.png
param(
  [string]$Exe = 'D:\Claudecode-CN\packages\desktop\src-tauri\target\release\claude-code-cn.exe',
  [int]$ClickX = 0,
  [int]$ClickY = 0,
  [string]$Out = 'D:\Claudecode-CN\_probe\menu-shot.png',
  [int]$SettleSeconds = 3,
  [int]$BootSeconds = 22
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

Add-Type @'
using System;
using System.Runtime.InteropServices;
public class UiClick {
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint flags, uint dx, uint dy, uint data, UIntPtr extra);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hwnd);
  [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr context);
  public const uint LEFTDOWN = 0x0002;
  public const uint LEFTUP = 0x0004;
}
'@

# REQUIRED, for the same reason capture-window.ps1 declares it: without DPI awareness this process is
# virtualized, so SetCursorPos takes LOGICAL pixels while the window rect is in physical ones. On this
# 200%-scaled display a click meant for x=711 was delivered at x≈1436 — it landed in the middle of the
# conversation and the menu never opened, which is exactly what the first two attempts showed.
# The bool is deliberately unchecked: the API is missing on old Windows, and the click is still worth
# attempting there.
[void][UiClick]::SetProcessDpiAwarenessContext([IntPtr](-4))   # PER_MONITOR_AWARE_V2

$app = Start-Process -FilePath $Exe -PassThru
Write-Host "launched pid $($app.Id)"
# The launch splash is 7 s BY DESIGN (see SPLASH_MS in App.vue) and it covers the whole window, so a
# click before it lifts lands on the splash and is swallowed — which is exactly what a 12 s wait did
# on the first attempt.
Start-Sleep -Seconds $BootSeconds

# Bring the window forward: a click at screen coordinates goes to whatever is on top.
$proc = Get-Process -Id $app.Id
[void][UiClick]::SetForegroundWindow($proc.MainWindowHandle)
Start-Sleep -Milliseconds 500

if ($ClickX -gt 0 -and $ClickY -gt 0) {
  Write-Host "clicking at ($ClickX,$ClickY)"
  [void][UiClick]::SetCursorPos($ClickX, $ClickY)
  Start-Sleep -Milliseconds 300
  [UiClick]::mouse_event([UiClick]::LEFTDOWN, 0, 0, 0, [UIntPtr]::Zero)
  Start-Sleep -Milliseconds 80
  [UiClick]::mouse_event([UiClick]::LEFTUP, 0, 0, 0, [UIntPtr]::Zero)
  Start-Sleep -Seconds $SettleSeconds
}

& powershell.exe -NoProfile -ExecutionPolicy Bypass -File 'D:\Claudecode-CN\packages\desktop\scripts\capture-window.ps1' -ProcessName 'claude-code-cn' -Out $Out

Stop-Process -Id $app.Id -Force -ErrorAction SilentlyContinue
Start-Sleep -Seconds 1
Write-Host "saved $Out"
