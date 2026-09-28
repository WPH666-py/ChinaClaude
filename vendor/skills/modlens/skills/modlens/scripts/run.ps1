# modlens launcher for Claude Code · CN (Windows, PowerShell 5.1 compatible).
#
# Same job as the upstream skills/modlens/scripts/run.ps1 — resolve a working way to run the
# modlens CLI and forward every argument unchanged — with ONE deliberate difference:
#
#   The bundled CLI is tried FIRST.
#
# Why: the upstream order is PATH -> npx -> bunx, and the npx branch fetches
# `@liustack/modlens@<pinned>` from registry.npmjs.org. That registry is unreachable from the
# network this client targets (measured at project start: the connection is closed), so on a
# stock machine the upstream launcher would fall through to its exit-78 "no runtime" diagnosis
# even though a fully working CLI shipped inside the installer. Resolving the bundled copy first
# is what makes an offline-first install actually work.
#
# Invoke per-process so no global policy is touched:
#   powershell -ExecutionPolicy Bypass -File run.ps1 -i C:\path\image.png
#
# Exit codes match upstream: the CLI's own code, or 78 (EX_CONFIG) when nothing can run it.

$ErrorActionPreference = 'Stop'

$Bin = 'modlens'

# The skill directory is this script's parent; the vendored package sits beside it:
#   <skills-root>/.claude/skills/modlens/scripts/run.ps1
#   <skills-root>/.claude/skills/modlens/dist/main.js
$SkillDir = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$BundledCli = Join-Path $SkillDir 'dist\main.js'

# The Node runtime that shipped with the app: <sidecar>/node.exe, four levels above the skill dir
# (.claude/skills/modlens -> .claude/skills -> .claude -> skills -> sidecar).
$SidecarDir = Split-Path -Parent (Split-Path -Parent (Split-Path -Parent (Split-Path -Parent $SkillDir)))
$BundledNode = Join-Path $SidecarDir 'node.exe'

function Get-NodeExe {
    if (Test-Path $BundledNode) { return $BundledNode }
    $onPath = Get-Command node -ErrorAction SilentlyContinue
    if ($onPath) { return $onPath.Source }
    return $null
}

function Write-NoRuntime {
    # Structured diagnosis on stderr, mirroring upstream's shape so an agent can act on it.
    $payload = [ordered]@{
        tool      = $Bin
        package   = '@liustack/modlens'
        os        = 'windows'
        checked   = [ordered]@{
            bundled = [ordered]@{ present = (Test-Path $BundledCli); path = $BundledCli }
            node    = [ordered]@{ present = [bool](Get-NodeExe); path = $BundledNode }
            pathCli = [ordered]@{ present = [bool](Get-Command $Bin -ErrorAction SilentlyContinue) }
            npx     = [ordered]@{ present = [bool](Get-Command npx -ErrorAction SilentlyContinue) }
            bunx    = [ordered]@{ present = [bool](Get-Command bunx -ErrorAction SilentlyContinue) }
        }
        selected  = 'none'
        nextSteps = @(
            'The bundled modlens CLI or its Node runtime was not found. Reinstalling Claude Code · CN restores both.',
            'Alternatively install Node 22.19+ from https://nodejs.org, or put a compatible modlens on PATH.'
        )
    }
    [Console]::Error.WriteLine(($payload | ConvertTo-Json -Depth 10))
    exit 78
}

# --- resolution order --------------------------------------------------------

# 1. Bundled CLI: offline, and always the exact version this skill was written for.
if (Test-Path $BundledCli) {
    $node = Get-NodeExe
    if ($node) {
        & $node $BundledCli @args
        exit $LASTEXITCODE
    }
}

# 2. A compatible modlens already on PATH.
$onPath = Get-Command $Bin -ErrorAction SilentlyContinue
if ($onPath) { & $Bin @args; exit $LASTEXITCODE }

# 3. npx / bunx: kept for parity with upstream on machines that do have registry access.
if (Get-Command npx -ErrorAction SilentlyContinue) {
    & npx --yes --package '@liustack/modlens@3.26.5' $Bin @args
    exit $LASTEXITCODE
}
if (Get-Command bunx -ErrorAction SilentlyContinue) {
    & bunx --bun '@liustack/modlens@3.26.5' @args
    exit $LASTEXITCODE
}

Write-NoRuntime
