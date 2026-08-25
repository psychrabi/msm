#Requires -RunAsAdministrator
[CmdletBinding()]
param(
    [string]$AgentBinaryPath = ".\msm-agent.exe",
    [string]$WorkerBinaryPath = ".\msm-agent-worker.exe"
)

$ErrorActionPreference = "Stop"
$InstallDir = Join-Path $env:ProgramFiles "MSM"
$AgentName = "msm-agent.exe"
$WorkerName = "msm-agent-worker.exe"
$ServiceName = "MSMAgent"

if (-not (Test-Path -LiteralPath $AgentBinaryPath -PathType Leaf)) {
    throw "Agent binary not found: $AgentBinaryPath"
}
if (-not (Test-Path -LiteralPath $WorkerBinaryPath -PathType Leaf)) {
    throw "Worker binary not found: $WorkerBinaryPath"
}

New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
$InstalledAgent = Join-Path $InstallDir $AgentName
$InstalledWorker = Join-Path $InstallDir $WorkerName

# Service registration and lifecycle are owned by the Rust agent through the
# windows-service crate. This keeps SCM registration identical to the service
# implementation used by the agent itself.
if (Test-Path -LiteralPath $InstalledAgent -PathType Leaf) {
    $ExistingService = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
    if ($ExistingService -and $ExistingService.Status -ne "Stopped") {
        & $InstalledAgent --stop-service 2>$null
        if ($LASTEXITCODE -ne 0) {
            throw "MSM Agent service stop failed (exit code $LASTEXITCODE)."
        }
    }

    if ($ExistingService) {
        & $InstalledAgent --uninstall-service 2>$null

        $UninstallExitCode = $LASTEXITCODE

        $ServiceStillExists = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue

        if ($ServiceStillExists) {
            throw "MSM Agent service uninstall failed (exit code $UninstallExitCode)."
        }
    }
}

Start-Sleep -Milliseconds 500

Copy-Item -LiteralPath $AgentBinaryPath -Destination $InstalledAgent -Force
Copy-Item -LiteralPath $WorkerBinaryPath -Destination $InstalledWorker -Force

& $InstalledAgent --install-service
if ($LASTEXITCODE -ne 0) {
    throw "MSM Agent service installation failed (exit code $LASTEXITCODE)."
}

$ServiceConfig = Get-CimInstance Win32_Service -Filter "Name='$ServiceName'"
if (-not $ServiceConfig) {
    throw "$ServiceName service was not created."
}
if ($ServiceConfig.StartName -ne "LocalSystem") {
    throw "$ServiceName was created with unexpected account '$($ServiceConfig.StartName)'. Expected LocalSystem."
}
if ($ServiceConfig.PathName -notmatch '--run-service') {
    throw "$ServiceName has unexpected service command line: $($ServiceConfig.PathName)"
}

Get-NetFirewallRule -DisplayName "MSM Agent" -ErrorAction SilentlyContinue |
    Remove-NetFirewallRule -ErrorAction SilentlyContinue
New-NetFirewallRule `
    -DisplayName "MSM Agent" `
    -Direction Inbound `
    -Protocol TCP `
    -LocalPort 40123 `
    -Action Allow `
    -Profile Domain,Private | Out-Null

Get-NetFirewallRule -DisplayName "MSM VNC Local Only" -ErrorAction SilentlyContinue |
    Remove-NetFirewallRule -ErrorAction SilentlyContinue
New-NetFirewallRule `
    -DisplayName "MSM VNC Local Only" `
    -Direction Inbound `
    -Protocol TCP `
    -LocalPort 5901-6900 `
    -Action Block `
    -Profile Any | Out-Null

& $InstalledAgent --start-service
if ($LASTEXITCODE -ne 0) {
    throw "MSM Agent service start failed (exit code $LASTEXITCODE)."
}

Start-Sleep -Milliseconds 500
$Service = Get-Service -Name $ServiceName -ErrorAction Stop
if ($Service.Status -ne "Running") {
    throw "$ServiceName was installed but failed to reach Running state. Current state: $($Service.Status)"
}

Write-Host "MSM agent installed successfully as $ServiceName"
Write-Host "Service account: LocalSystem"
Write-Host "Install directory: $InstallDir"
Write-Host "Service command: $($ServiceConfig.PathName)"
Write-Host "Run '$InstalledAgent --print-identity' as administrator to retrieve the device identity and development token."
