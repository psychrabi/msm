#Requires -RunAsAdministrator
[CmdletBinding()]
param(
    [string]$AgentBinaryPath = ".\msm-agent.exe",
    [string]$WorkerBinaryPath = ".\msm-agent-worker.exe"
)

$ErrorActionPreference = "Stop"
$InstallDir = Join-Path $env:ProgramFiles "MSM"
$ServiceName = "MSMAgent"

if (-not (Test-Path -LiteralPath $AgentBinaryPath -PathType Leaf)) {
    throw "Agent binary not found: $AgentBinaryPath"
}
if (-not (Test-Path -LiteralPath $WorkerBinaryPath -PathType Leaf)) {
    throw "Worker binary not found: $WorkerBinaryPath"
}

New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
Copy-Item -LiteralPath $AgentBinaryPath -Destination (Join-Path $InstallDir "msm-agent.exe") -Force
Copy-Item -LiteralPath $WorkerBinaryPath -Destination (Join-Path $InstallDir "msm-agent-worker.exe") -Force

$Existing = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
if ($Existing) {
    Stop-Service -Name $ServiceName -Force -ErrorAction SilentlyContinue
    & sc.exe delete $ServiceName | Out-Null
    if ($LASTEXITCODE -ne 0) {
        throw "Failed to remove existing service '$ServiceName' (sc.exe exit code $LASTEXITCODE)."
    }
    Start-Sleep -Milliseconds 500
}

$Binary = Join-Path $InstallDir "msm-agent.exe"
$BinPath = '"{0}" --service' -f $Binary

# The Windows service must enter through the SCM dispatcher. Do not pass the
# normal --listen mode here; --service is responsible for registering with SCM
# and starting the agent listener from the service process.
New-Service `
    -Name $ServiceName `
    -BinaryPathName $BinPath `
    -DisplayName "MSM Agent" `
    -Description "MSM multiseat remote monitor and control agent" `
    -StartupType Automatic | Out-Null

$ServiceConfig = Get-CimInstance Win32_Service -Filter "Name='$ServiceName'"
if (-not $ServiceConfig) {
    throw "MSMAgent service was not created."
}
if ($ServiceConfig.StartName -ne "LocalSystem") {
    throw "MSMAgent was created with unexpected account '$($ServiceConfig.StartName)'. Expected LocalSystem."
}

# The agent is the only intended remote entry point. Per-session VNC listeners
# are implementation details and should not be reachable from other hosts.
Get-NetFirewallRule -DisplayName "MSM Agent" -ErrorAction SilentlyContinue |
    Remove-NetFirewallRule -ErrorAction SilentlyContinue
New-NetFirewallRule -DisplayName "MSM Agent" -Direction Inbound -Protocol TCP -LocalPort 40123 -Action Allow -Profile Domain,Private | Out-Null

Get-NetFirewallRule -DisplayName "MSM VNC Local Only" -ErrorAction SilentlyContinue |
    Remove-NetFirewallRule -ErrorAction SilentlyContinue
New-NetFirewallRule -DisplayName "MSM VNC Local Only" -Direction Inbound -Protocol TCP -LocalPort 5901-6900 -Action Block -Profile Any | Out-Null

Start-Service -Name $ServiceName
$Service = Get-Service -Name $ServiceName -ErrorAction Stop
if ($Service.Status -ne "Running") {
    throw "MSMAgent service was created but failed to reach Running state. Current state: $($Service.Status)"
}

Write-Host "MSM agent installed successfully as $ServiceName"
Write-Host "Service account: LocalSystem"
Write-Host "Install directory: $InstallDir"
Write-Host "Run '$Binary --print-identity' as administrator to retrieve the device identity and development token."
