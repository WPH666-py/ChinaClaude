# Restore (un-minimize) a window and bring it to the foreground, then report its state.
#
# Needed because a MINIMIZED WebView2 window has its timers throttled by Chromium, so the app's
# 2.5 s session poll can effectively stop. That makes the app look broken ("the sidebar never
# updates") when the real cause is that the window is not being rendered — a distinction that
# matters before blaming application code.
param(
  [string]$ProcessName = 'claude-code-cn'
)

$ErrorActionPreference = 'Stop'

Add-Type @"
using System;
using System.Runtime.InteropServices;
public class WinRestore {
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
}
"@

$proc = Get-Process -Name $ProcessName -ErrorAction SilentlyContinue |
  Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1
if (-not $proc) { Write-Error "no window for $ProcessName"; exit 1 }

$hwnd = $proc.MainWindowHandle
Write-Host "pid=$($proc.Id) hwnd=$hwnd minimized=$([WinRestore]::IsIconic($hwnd)) visible=$([WinRestore]::IsWindowVisible($hwnd))"

if ([WinRestore]::IsIconic($hwnd)) {
  # SW_RESTORE = 9
  [void][WinRestore]::ShowWindow($hwnd, 9)
  Write-Host 'restored from minimized'
}
[void][WinRestore]::SetForegroundWindow($hwnd)
Start-Sleep -Milliseconds 800
Write-Host "after: minimized=$([WinRestore]::IsIconic($hwnd)) visible=$([WinRestore]::IsWindowVisible($hwnd))"
