# Capture the running desktop window to a PNG so the UI can be reviewed.
#
# Uses PrintWindow with PW_RENDERFULLCONTENT, which is the only reliable way to grab a
# WebView2 surface (a plain BitBlt of the screen returns an empty rectangle for
# hardware-composited content).
param(
  [string]$ProcessName = 'claude-code-cn',
  [string]$Out = 'D:\Claudecode-CN\_probe\app-window.png'
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

Add-Type @'
using System;
using System.Runtime.InteropServices;
public class WinCap {
  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr hwnd, IntPtr hdc, uint flags);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hwnd, out RECT rect);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hwnd);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hwnd);
  // Declaring DPI awareness is REQUIRED for an accurate capture: without it this process is
  // DPI-virtualized, so GetWindowRect reports logical pixels while PrintWindow renders at
  // physical resolution — the bitmap then has the content in its top-left corner and empty
  // padding on the right and bottom, which reads as a clipped layout.
  [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr context);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
}
'@

# DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2 == -4
try { [void][WinCap]::SetProcessDpiAwarenessContext([IntPtr]::new(-4)) } catch { }
Start-Sleep -Milliseconds 200

$proc = Get-Process -Name $ProcessName -ErrorAction SilentlyContinue |
  Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1

if (-not $proc) { throw "no window found for process '$ProcessName'" }

$hwnd = $proc.MainWindowHandle
Write-Host "window: pid=$($proc.Id) title='$($proc.MainWindowTitle)' hwnd=$hwnd"

[void][WinCap]::SetForegroundWindow($hwnd)
Start-Sleep -Milliseconds 900

$rect = New-Object WinCap+RECT
[void][WinCap]::GetWindowRect($hwnd, [ref]$rect)
$width = $rect.Right - $rect.Left
$height = $rect.Bottom - $rect.Top
Write-Host "size: ${width}x${height} at ($($rect.Left),$($rect.Top))"

if ($width -le 0 -or $height -le 0) { throw "invalid window rect" }

$bmp = New-Object System.Drawing.Bitmap($width, $height, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$hdc = $g.GetHdc()

# 0x2 == PW_RENDERFULLCONTENT, required for DirectComposition (WebView2) surfaces.
$ok = [WinCap]::PrintWindow($hwnd, $hdc, 2)
$g.ReleaseHdc($hdc)
$g.Dispose()

if (-not $ok) { Write-Warning 'PrintWindow reported failure; the image may be blank' }

$bmp.Save($Out, [System.Drawing.Imaging.ImageFormat]::Png)
$bmp.Dispose()

$info = Get-Item $Out
Write-Host "saved: $($info.FullName) ($([math]::Round($info.Length/1KB,1)) KB)"
