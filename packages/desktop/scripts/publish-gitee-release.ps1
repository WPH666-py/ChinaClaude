# Publish one ChinaClaude release to Gitee: create the release for a tag, then attach the installer.
#
# WHY THIS EXISTS: Gitee has no CLI. Its OpenAPI accepts HTTP Basic auth with the account
# credential, which is exactly what the OS already holds for `git push` — so this script reads that
# credential from the Windows Credential Manager (target `git:https://gitee.com`) instead of asking
# for a token, and nothing secret is ever written to disk or to the command line.
#
# Reads the notes from RELEASE-NOTES-<tag>.md when the file exists.
#
# Usage:
#   powershell -File packages/desktop/scripts/publish-gitee-release.ps1 `
#     -Tag v0.2.0 -Asset 'packages\desktop\src-tauri\target\release\bundle\nsis\ChinaClaude_0.2.0_x64-setup.exe'
param(
  [Parameter(Mandatory = $true)][string]$Tag,
  [Parameter(Mandatory = $true)][string]$Asset,
  [string]$Owner = 'ph-wang',
  [string]$Repo = 'ChinaClaude',
  [string]$Title = '',
  [string]$NotesFile = '',
  [string]$CredentialHelper = 'D:\_tools\git-cred-windows.ps1'
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

if (-not (Test-Path $Asset)) { throw "installer not found: $Asset" }
$assetItem = Get-Item $Asset
if ($Title -eq '') { $Title = "ChinaClaude $($Tag.TrimStart('v'))（Windows x64，$([math]::Round($assetItem.Length/1MB,1)) MB，不含 claude.exe）" }
if ($NotesFile -eq '') {
  $candidate = Join-Path (Get-Location) "RELEASE-NOTES-$Tag.md"
  if (Test-Path $candidate) { $NotesFile = $candidate }
}
$body = if ($NotesFile -ne '' -and (Test-Path $NotesFile)) { Get-Content $NotesFile -Raw -Encoding UTF8 } else { '' }

# --- credential ---------------------------------------------------------------
if (-not (Test-Path $CredentialHelper)) { throw "credential helper missing: $CredentialHelper" }
$raw = "protocol=https`nhost=gitee.com`n`n" | & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $CredentialHelper get
$user = ($raw | Where-Object { $_ -like 'username=*' }) -replace '^username=',''
$pass = ($raw | Where-Object { $_ -like 'password=*' }) -replace '^password=',''
if ($user -eq '' -or $pass -eq '') { throw 'no Gitee credential in the Windows Credential Manager (target git:https://gitee.com)' }
$auth = @{ Authorization = 'Basic ' + [Convert]::ToBase64String([Text.Encoding]::ASCII.GetBytes("${user}:${pass}")) }
Write-Host "credential: $user"

$api = "https://gitee.com/api/v5/repos/$Owner/$Repo"

# --- release ------------------------------------------------------------------
$existing = Invoke-RestMethod "$api/releases?per_page=100" -Headers $auth -TimeoutSec 60 -UseBasicParsing
$release = $existing | Where-Object { $_.tag_name -eq $Tag }
if ($release) {
  Write-Host "release $Tag already exists (id $($release.id)) — reusing it"
} else {
  Write-Host "creating release $Tag"
  # Gitee takes form fields here rather than a JSON body.
  $form = @{
    tag_name         = $Tag
    name             = $Title
    body             = $body
    target_commitish = 'main'
    prerelease       = 'false'
  }
  $release = Invoke-RestMethod "$api/releases" -Method Post -Headers $auth -Body $form -TimeoutSec 120 -UseBasicParsing
  Write-Host "  created id $($release.id)"
}

# --- attachment ---------------------------------------------------------------
$limit = 100 * 1024 * 1024
if ($assetItem.Length -gt $limit) {
  throw "$($assetItem.Name) is $([math]::Round($assetItem.Length/1MB,1)) MB and Gitee caps an attachment at 100 MB"
}

$already = Invoke-RestMethod "$api/releases/$($release.id)/attach_files" -Headers $auth -TimeoutSec 60 -UseBasicParsing
if ($already | Where-Object { $_.name -eq $assetItem.Name }) {
  Write-Host "attachment $($assetItem.Name) already uploaded — nothing to do"
} else {
  Write-Host "uploading $($assetItem.Name) ($([math]::Round($assetItem.Length/1MB,1)) MB)"
  # PowerShell 5.1 has no -Form, so the multipart body is assembled by hand.
  $boundary = [guid]::NewGuid().ToString('N')
  $prefix = [Text.Encoding]::UTF8.GetBytes(
    "--$boundary`r`nContent-Disposition: form-data; name=`"file`"; filename=`"$($assetItem.Name)`"`r`n" +
    "Content-Type: application/octet-stream`r`n`r`n")
  $suffix = [Text.Encoding]::UTF8.GetBytes("`r`n--$boundary--`r`n")
  $bytes = [IO.File]::ReadAllBytes($assetItem.FullName)
  $payload = New-Object byte[] ($prefix.Length + $bytes.Length + $suffix.Length)
  [Array]::Copy($prefix, 0, $payload, 0, $prefix.Length)
  [Array]::Copy($bytes, 0, $payload, $prefix.Length, $bytes.Length)
  [Array]::Copy($suffix, 0, $payload, $prefix.Length + $bytes.Length, $suffix.Length)

  $uploaded = Invoke-RestMethod "$api/releases/$($release.id)/attach_files" -Method Post -Headers $auth `
    -ContentType "multipart/form-data; boundary=$boundary" -Body $payload -TimeoutSec 1800 -UseBasicParsing
  Write-Host "  uploaded: $($uploaded.browser_download_url)"
}

Write-Host "release page: https://gitee.com/$Owner/$Repo/releases/tag/$Tag"
