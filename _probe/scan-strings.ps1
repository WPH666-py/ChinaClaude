# Targeted capability scan of the native Claude Code binary.
# Writes categorized results to a file so huge match sets never flood stdout.
param(
  [string]$Exe = 'D:\Claudecode-CN\_probe\package\claude.exe',
  [string]$Out = 'D:\Claudecode-CN\_probe\scan-report.txt'
)

$sets = @{
  'ENV_ANTHROPIC' = 'ANTHROPIC_[A-Z][A-Z0-9_]{2,40}'
  'ENV_CLAUDE'    = 'CLAUDE_[A-Z][A-Z0-9_]{2,40}'
  'ENV_OTHER'     = '\b(?:HTTP_PROXY|HTTPS_PROXY|NO_PROXY|ALL_PROXY|NODE_EXTRA_CA_CERTS|SSL_CERT_FILE|AWS_REGION|CLOUD_ML_REGION|VERTEX_REGION_CLAUDE[A-Z0-9_]*)\b'
  'URL'           = 'https?://[A-Za-z0-9._~:/?#\[\]@!$&''()*+,;=%-]{4,120}'
  'COUNTRY_GATE'  = '(?i)(supportedCountries|unsupportedCountry|countryNotSupported|regionNotSupported|isSupportedCountry|geoBlock|geo_block|blockedRegion|country_code|countryCode)'
  'TELEMETRY'     = '\b(?:statsig|sentry|datadog|amplitude|segment\.io|ingest\.sentry|featuregates|feature_gates)\b'
}

$results = @{}
foreach ($k in $sets.Keys) { $results[$k] = [System.Collections.Generic.HashSet[string]]::new() }

$fs = [System.IO.File]::OpenRead($Exe)
$sr = New-Object System.IO.StreamReader($fs, [System.Text.Encoding]::ASCII)
$buf = New-Object char[] 4194304
$carry = ''
while (($n = $sr.Read($buf, 0, $buf.Length)) -gt 0) {
  $chunk = $carry + (New-Object string ($buf, 0, $n))
  foreach ($k in $sets.Keys) {
    foreach ($m in [regex]::Matches($chunk, $sets[$k])) { [void]$results[$k].Add($m.Value) }
  }
  if ($chunk.Length -gt 256) { $carry = $chunk.Substring($chunk.Length - 256) } else { $carry = $chunk }
}
$sr.Close()

$sb = New-Object System.Text.StringBuilder
[void]$sb.AppendLine("Binary : $Exe")
[void]$sb.AppendLine("SizeMB : $([math]::Round((Get-Item $Exe).Length/1MB,1))")
[void]$sb.AppendLine("Scanned: $(Get-Date -Format o)")
[void]$sb.AppendLine('')

foreach ($k in @('ENV_ANTHROPIC','ENV_CLAUDE','ENV_OTHER')) {
  $vals = $results[$k] | Sort-Object
  [void]$sb.AppendLine("=== $k ($($vals.Count)) ===")
  foreach ($v in $vals) { [void]$sb.AppendLine($v) }
  [void]$sb.AppendLine('')
}

# URLs: group by host to keep the list readable.
$urls = $results['URL']
$hosts = @{}
foreach ($u in $urls) {
  try { $h = ([uri]$u).Host } catch { $h = '<unparsed>' }
  if (-not $hosts.ContainsKey($h)) { $hosts[$h] = [System.Collections.Generic.HashSet[string]]::new() }
  [void]$hosts[$h].Add($u)
}
[void]$sb.AppendLine("=== URL HOSTS ($($hosts.Keys.Count)) ===")
foreach ($h in ($hosts.Keys | Sort-Object)) {
  [void]$sb.AppendLine("$h   [$($hosts[$h].Count) distinct]")
}
[void]$sb.AppendLine('')

[void]$sb.AppendLine('=== ANTHROPIC / CLAUDE / 3RD-PARTY API URLS (full) ===')
$interesting = $urls | Where-Object { $_ -match 'anthropic|claude|statsig|sentry|datadog|googleapis|cloudflare|oauth' } | Sort-Object
foreach ($u in $interesting) { [void]$sb.AppendLine($u) }
[void]$sb.AppendLine('')

foreach ($k in @('COUNTRY_GATE','TELEMETRY')) {
  $vals = $results[$k] | Sort-Object
  [void]$sb.AppendLine("=== $k ($($vals.Count)) ===")
  foreach ($v in $vals) { [void]$sb.AppendLine($v) }
  [void]$sb.AppendLine('')
}

Set-Content -Path $Out -Value $sb.ToString() -Encoding UTF8
Write-Host "report written: $Out"
Write-Host "total distinct: env=$($results['ENV_ANTHROPIC'].Count + $results['ENV_CLAUDE'].Count) urls=$($urls.Count) hosts=$($hosts.Keys.Count) gates=$($results['COUNTRY_GATE'].Count)"
