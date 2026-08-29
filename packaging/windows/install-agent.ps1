#Requires -RunAsAdministrator
[CmdletBinding()]
param(
    [string]$AgentBinaryPath = ".\msm-agent.exe",
    [string]$WorkerBinaryPath = ".\msm-agent-worker.exe",
    [string]$TlsCertificatePath = ".\cert.pem",
    [string]$TlsPrivateKeyPath = ".\key.pem"
)

$ErrorActionPreference = "Stop"
$InstallDir = Join-Path $env:ProgramFiles "MSM"
$DataDir = Join-Path $env:ProgramData "MSM\agent"
$TlsDir = Join-Path $DataDir "tls"
$LogDir = Join-Path $DataDir "logs"
$AgentName = "msm-agent.exe"
$WorkerName = "msm-agent-worker.exe"
$ServiceName = "MSMAgent"

foreach ($path in @($AgentBinaryPath, $WorkerBinaryPath)) {
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { throw "Required binary not found: $path" }
}

New-Item -ItemType Directory -Force -Path $InstallDir, $DataDir, $TlsDir, $LogDir | Out-Null
$InstalledAgent = Join-Path $InstallDir $AgentName
$InstalledWorker = Join-Path $InstallDir $WorkerName
$InstalledCert = Join-Path $TlsDir "cert.pem"
$InstalledKey = Join-Path $TlsDir "key.pem"

function Stop-MsmWorkers {
    $workers = @(Get-Process -Name "msm-agent-worker" -ErrorAction SilentlyContinue)
    if (-not $workers) { return }
    Write-Host "Stopping $($workers.Count) MSM worker process(es)..."
    foreach ($worker in $workers) {
        try { Stop-Process -Id $worker.Id -Force -ErrorAction Stop }
        catch { if (Get-Process -Id $worker.Id -ErrorAction SilentlyContinue) { throw "Unable to terminate MSM worker PID $($worker.Id): $($_.Exception.Message)" } }
    }
    $deadline = (Get-Date).AddSeconds(10)
    do {
        $remaining = @(Get-Process -Name "msm-agent-worker" -ErrorAction SilentlyContinue)
        if (-not $remaining) { return }
        Start-Sleep -Milliseconds 250
    } while ((Get-Date) -lt $deadline)
    $remainingIds = @($remaining | ForEach-Object { $_.Id }) -join ", "
    throw "MSM worker process(es) are still running: $remainingIds"
}

function Stop-MsmServiceAndWait {
    $service = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
    if (-not $service) { return }
    if ($service.Status -ne "Stopped") {
        Write-Host "Stopping $ServiceName service..."
        try { Stop-Service -Name $ServiceName -Force -ErrorAction Stop } catch { Write-Warning "Stop-Service reported: $($_.Exception.Message)" }
    }
    $deadline = (Get-Date).AddSeconds(20)
    do {
        $service = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
        if (-not $service -or $service.Status -eq "Stopped") { return }
        Start-Sleep -Milliseconds 250
    } while ((Get-Date) -lt $deadline)
    $state = if ($service) { $service.Status } else { "Unknown" }
    throw "$ServiceName did not stop within 20 seconds. Current state: $state"
}

function Uninstall-MsmServiceAndWait {
    $service = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
    if (-not $service) { return }
    Write-Host "Uninstalling $ServiceName service..."
    & $InstalledAgent --uninstall-service 2>$null
    $uninstallExitCode = $LASTEXITCODE
    $deadline = (Get-Date).AddSeconds(10)
    do {
        $remaining = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
        if (-not $remaining) { return }
        Start-Sleep -Milliseconds 250
    } while ((Get-Date) -lt $deadline)
    Write-Warning "$ServiceName is still registered after --uninstall-service (exit code $uninstallExitCode). Retrying through SCM..."
    & sc.exe delete $ServiceName | Out-Null
    $scExitCode = $LASTEXITCODE
    $deadline = (Get-Date).AddSeconds(10)
    do {
        $remaining = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
        if (-not $remaining) { return }
        Start-Sleep -Milliseconds 250
    } while ((Get-Date) -lt $deadline)
    throw "MSM Agent service uninstall failed (service still exists; --uninstall-service exit code $uninstallExitCode, sc.exe exit code $scExitCode)."
}

function Protect-MsmDataAcl {
    $acl = Get-Acl $DataDir
    $acl.SetAccessRuleProtection($true, $false)
    foreach ($rule in @($acl.Access)) { $acl.RemoveAccessRule($rule) | Out-Null }
    $acl.AddAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule("SYSTEM","FullControl","ContainerInherit,ObjectInherit","None","Allow")))
    $acl.AddAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule("BUILTIN\Administrators","FullControl","ContainerInherit,ObjectInherit","None","Allow")))
    Set-Acl -Path $DataDir -AclObject $acl
}

Stop-MsmWorkers
Stop-MsmServiceAndWait
Uninstall-MsmServiceAndWait
Stop-MsmWorkers
Start-Sleep -Milliseconds 500
Copy-Item -LiteralPath $AgentBinaryPath -Destination $InstalledAgent -Force
Copy-Item -LiteralPath $WorkerBinaryPath -Destination $InstalledWorker -Force

$certSourceExists = Test-Path -LiteralPath $TlsCertificatePath -PathType Leaf
$keySourceExists = Test-Path -LiteralPath $TlsPrivateKeyPath -PathType Leaf
if ($certSourceExists -xor $keySourceExists) { throw "TLS certificate and private key must be supplied together." }
if ($certSourceExists) {
    Copy-Item -LiteralPath $TlsCertificatePath -Destination $InstalledCert -Force
    Copy-Item -LiteralPath $TlsPrivateKeyPath -Destination $InstalledKey -Force
}
if (-not (Test-Path -LiteralPath $InstalledCert -PathType Leaf) -or -not (Test-Path -LiteralPath $InstalledKey -PathType Leaf)) {
    throw "Production installation requires TLS certificate and private key. Supply -TlsCertificatePath and -TlsPrivateKeyPath on first install."
}

Protect-MsmDataAcl

& $InstalledAgent --install-service
if ($LASTEXITCODE -ne 0) { throw "MSM Agent service installation failed (exit code $LASTEXITCODE)." }

$ServiceConfig = Get-CimInstance Win32_Service -Filter "Name='$ServiceName'"
if (-not $ServiceConfig) { throw "$ServiceName service was not created." }
if ($ServiceConfig.StartName -ne "LocalSystem") { throw "$ServiceName was created with unexpected account '$($ServiceConfig.StartName)'. Expected LocalSystem." }
if ($ServiceConfig.PathName -notmatch '--run-service') { throw "$ServiceName has unexpected service command line: $($ServiceConfig.PathName)" }
if ($ServiceConfig.PathName -notmatch '--tls-cert' -or $ServiceConfig.PathName -notmatch '--tls-key') { throw "$ServiceName is not configured with TLS certificate and key arguments." }

# Configure automatic service recovery. Reset the failure counter after one day.
& sc.exe failure $ServiceName reset= 86400 actions= restart/5000/restart/15000/restart/60000 | Out-Null
& sc.exe failureflag $ServiceName 1 | Out-Null

Get-NetFirewallRule -DisplayName "MSM Agent" -ErrorAction SilentlyContinue | Remove-NetFirewallRule -ErrorAction SilentlyContinue
New-NetFirewallRule -DisplayName "MSM Agent" -Direction Inbound -Protocol TCP -LocalPort 40123 -Action Allow -Profile Domain,Private | Out-Null
Get-NetFirewallRule -DisplayName "MSM VNC Local Only" -ErrorAction SilentlyContinue | Remove-NetFirewallRule -ErrorAction SilentlyContinue
New-NetFirewallRule -DisplayName "MSM VNC Local Only" -Direction Inbound -Protocol TCP -LocalPort 5901-5999 -Action Block -Profile Any | Out-Null

& $InstalledAgent --start-service
if ($LASTEXITCODE -ne 0) { throw "MSM Agent service start failed (exit code $LASTEXITCODE)." }

$deadline = (Get-Date).AddSeconds(20)
do {
    $Service = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
    if ($Service -and $Service.Status -eq "Running") { break }
    Start-Sleep -Milliseconds 250
} while ((Get-Date) -lt $deadline)
if (-not $Service) { throw "$ServiceName was installed but is no longer registered." }
if ($Service.Status -ne "Running") { throw "$ServiceName was installed but failed to reach Running state. Current state: $($Service.Status)" }

Write-Host "MSM agent installed successfully as $ServiceName"
Write-Host "Service account: LocalSystem"
Write-Host "Install directory: $InstallDir"
Write-Host "TLS certificate: $InstalledCert"
Write-Host "Service recovery: restart on first three failures"
