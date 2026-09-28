# Capture the exact HTTP request Claude Code makes, to document relay/proxy requirements.
param([int]$Port = 59888)

$listener = New-Object System.Net.HttpListener
$listener.Prefixes.Add("http://127.0.0.1:$Port/")
$listener.Start()
Write-Host "listening on http://127.0.0.1:$Port/"

$job = Start-Job -ScriptBlock {
  param($p, $exe)
  $env:ANTHROPIC_BASE_URL = "http://127.0.0.1:$p"
  $env:ANTHROPIC_AUTH_TOKEN = 'sk-capture'
  $env:ANTHROPIC_API_KEY = ''
  $env:CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = '1'
  & $exe -p "say hi" 2>&1 | Out-String
} -ArgumentList $Port, 'D:\Claudecode-CN\_probe\package\claude.exe'

$deadline = (Get-Date).AddSeconds(150)
$captured = 0
$report = New-Object System.Text.StringBuilder

while ((Get-Date) -lt $deadline -and $captured -lt 3) {
  $ctxTask = $listener.GetContextAsync()
  if (-not $ctxTask.Wait(30000)) { continue }
  $ctx = $ctxTask.Result
  $captured++
  $req = $ctx.Request

  [void]$report.AppendLine("--- REQUEST $captured ---")
  [void]$report.AppendLine("METHOD : $($req.HttpMethod)")
  [void]$report.AppendLine("URL    : $($req.Url.AbsoluteUri)")
  [void]$report.AppendLine("PATH   : $($req.Url.AbsolutePath)")
  [void]$report.AppendLine("HOSTHDR: $($req.Headers['Host'])")
  [void]$report.AppendLine("HEADERS:")
  foreach ($k in $req.Headers.AllKeys) {
    $v = $req.Headers[$k]
    if ($k -match '(?i)authorization|x-api-key|anthropic-beta|anthropic-version|user-agent|content-type|accept') {
      if ($k -match '(?i)authorization|x-api-key' -and $v.Length -gt 24) { $v = $v.Substring(0, 24) + '...[truncated]' }
      [void]$report.AppendLine("  ${k}: $v")
    }
  }
  $sr = New-Object System.IO.StreamReader($req.InputStream)
  $body = $sr.ReadToEnd()
  [void]$report.AppendLine("BODY($($body.Length) chars, first 600):")
  [void]$report.AppendLine($body.Substring(0, [Math]::Min(600, $body.Length)))

  $respBytes = [System.Text.Encoding]::UTF8.GetBytes('{"type":"error","error":{"type":"invalid_request_error","message":"captured"}}')
  $ctx.Response.StatusCode = 400
  $ctx.Response.ContentType = 'application/json'
  $ctx.Response.ContentLength64 = $respBytes.Length
  $ctx.Response.OutputStream.Write($respBytes, 0, $respBytes.Length)
  $ctx.Response.Close()
}

$listener.Stop()
$childOut = Receive-Job $job -Wait -AutoRemoveJob 2>&1 | Out-String
[void]$report.AppendLine("--- CHILD STDOUT ---")
[void]$report.AppendLine($childOut)

Set-Content -Path 'D:\Claudecode-CN\_probe\request-capture.txt' -Value $report.ToString() -Encoding UTF8
Write-Host "captured $captured request(s) -> D:\Claudecode-CN\_probe\request-capture.txt"
