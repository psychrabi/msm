#Requires -Version 5.1
<#
.SYNOPSIS
  Builds the MSM agent release binaries and packages a portable installer.

.DESCRIPTION
  Compiles msm-agent and msm-agent-worker in release mode, stages them
  alongside the service installer script, and produces a zip that can be
  copied to any Windows machine. Run the extracted install-agent.ps1 from
  an elevated PowerShell to install the MSM Agent Windows service.

.PARAMETER Install
  Additionally run install-agent.ps1 on this machine immediately after
  building (requires an elevated PowerShell).

.PARAMETER OutputDir
  Directory that receives the staged folder and zip.
#>
[CmdletBinding()]
param(
    [switch]$Install,
    [string]$OutputDir
)

$ErrorActionPreference = "Stop"

if (-not $OutputDir) {
    $OutputDir = Join-Path $PSScriptRoot "dist"
}
$OutputDir = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($OutputDir)

$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
$AgentManifest = Join-Path $RepoRoot "agent\Cargo.toml"
$TargetDir = Join-Path $RepoRoot "target\release"

$versionLine = Select-String -LiteralPath $AgentManifest -Pattern '^version\s*=\s*"(.+)"' |
    Select-Object -First 1
if (-not $versionLine) {
    throw "Could not read agent version from $AgentManifest"
}
$AgentVersion = $versionLine.Matches[0].Groups[1].Value

Write-Host "Building MSM agent v$AgentVersion (release)..."
Push-Location $RepoRoot
try {
    cargo build --release -p msm-agent
    if ($LASTEXITCODE -ne 0) {
        throw "cargo build failed with exit code $LASTEXITCODE"
    }
}
finally {
    Pop-Location
}

$StageDir = Join-Path $OutputDir "msm-agent-$AgentVersion"
New-Item -ItemType Directory -Force -Path $StageDir | Out-Null

$Artifacts = @{
    (Join-Path $TargetDir "msm-agent.exe")        = "msm-agent.exe"
    (Join-Path $TargetDir "msm-agent-worker.exe") = "msm-agent-worker.exe"
    (Join-Path $PSScriptRoot "install-agent.ps1") = "install-agent.ps1"
}
foreach ($source in $Artifacts.Keys) {
    if (-not (Test-Path -LiteralPath $source -PathType Leaf)) {
        throw "Expected build artifact is missing: $source"
    }
    Copy-Item -LiteralPath $source -Destination (Join-Path $StageDir $Artifacts[$source]) -Force
}

$ZipPath = Join-Path $OutputDir "msm-agent-$AgentVersion-windows-x64.zip"
if (Test-Path -LiteralPath $ZipPath) {
    Remove-Item -LiteralPath $ZipPath -Force
}
Compress-Archive -Path $StageDir -DestinationPath $ZipPath

Write-Host ""
Write-Host "Installer package ready:"
Write-Host "  $ZipPath"
Write-Host "Staged contents:"
Write-Host "  $StageDir"
Write-Host ""
Write-Host "To install on a machine, extract the zip and run install-agent.ps1"
Write-Host "from an elevated PowerShell."

if ($Install) {
    Write-Host ""
    Write-Host "Installing on this machine..."
    & (Join-Path $StageDir "install-agent.ps1") `
        -AgentBinaryPath (Join-Path $StageDir "msm-agent.exe") `
        -WorkerBinaryPath (Join-Path $StageDir "msm-agent-worker.exe")
    if ($LASTEXITCODE -ne 0) {
        throw "install-agent.ps1 failed with exit code $LASTEXITCODE"
    }
}
