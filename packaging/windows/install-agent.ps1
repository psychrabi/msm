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

function Stop-MsmWorkers {
    $workers = @(Get-Process -Name "msm-agent-worker" -ErrorAction SilentlyContinue)
    if (-not $workers) {
        return
    }

    Write-Host "Stopping $($workers.Count) MSM worker process(es)..."
    foreach ($worker in $workers) {
        try {
            Stop-Process -Id $worker.Id -Force -ErrorAction Stop
        }
        catch {
            if (Get-Process -Id $worker.Id -ErrorAction SilentlyContinue) {
                throw "Unable to terminate MSM worker PID $($worker.Id): $($_.Exception.Message)"
            }
        }
    }

    $deadline = (Get-Date).AddSeconds(10)
    do {
        $remaining = @(Get-Process -Name "msm-agent-worker" -ErrorAction SilentlyContinue)
        if (-not $remaining) {
            return
        }
        Start-Sleep -Milliseconds 250
    } while ((Get-Date) -lt $deadline)

    $remainingIds = @($remaining | ForEach-Object { $_.Id }) -join ", "
    throw "MSM worker process(es) are still running: $remainingIds"
}

function Stop-MsmServiceAndWait {
    $service = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
    if (-not $service) {
        return
    }

    if ($service.Status -ne "Stopped") {
        Write-Host "Stopping $ServiceName service..."
        try {
            Stop-Service -Name $ServiceName -Force -ErrorAction Stop
        }
        catch {
            # The service may already be transitioning to stopped. The status wait below
            # is authoritative; only fail if it never reaches Stopped.
            Write-Warning "Stop-Service reported: $($_.Exception.Message)"
        }
    }

    $deadline = (Get-Date).AddSeconds(20)
    do {
        $service = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
        if (-not $service -or $service.Status -eq "Stopped") {
            return
        }
        Start-Sleep -Milliseconds 250
    } while ((Get-Date) -lt $deadline)

    $state = if ($service) { $service.Status } else { "Unknown" }
    throw "$ServiceName did not stop within 20 seconds. Current state: $state"
}

function Uninstall-MsmServiceAndWait {
    $service = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
    if (-not $service) {
        return
    }

    # First use the same service implementation as normal installation. The command
    # returns success once SCM accepts the delete request, not necessarily once the
    # service object has disappeared, so we explicitly wait for disappearance.
    Write-Host "Uninstalling $ServiceName service..."
    & $InstalledAgent --uninstall-service 2>$null
    $uninstallExitCode = $LASTEXITCODE

    $deadline = (Get-Date).AddSeconds(10)
    do {
        $remaining = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
        if (-not $remaining) {
            return
        }
        Start-Sleep -Milliseconds 250
    } while ((Get-Date) -lt $deadline)

    # Windows can leave a service in DELETE_PENDING while an SCM handle is still open.
    # If it is still registered after the normal uninstall command, issue the SCM delete
    # directly and wait again rather than reporting a false failure for exit code 0.
    Write-Warning "$ServiceName is still registered after --uninstall-service (exit code $uninstallExitCode). Retrying through SCM..."
    & sc.exe delete $ServiceName | Out-Null
    $scExitCode = $LASTEXITCODE

    $deadline = (Get-Date).AddSeconds(10)
    do {
        $remaining = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
        if (-not $remaining) {
            return
        }
        Start-Sleep -Milliseconds 250
    } while ((Get-Date) -lt $deadline)

    if ($remaining) {
        throw "MSM Agent service uninstall failed (service still exists after SCM delete; --uninstall-service exit code $uninstallExitCode, sc.exe exit code $scExitCode)."
    }
}

# Reinstallation must be safe while the previous service has active per-session
# workers. Terminate workers first so no old VNC worker remains attached to a user
# session while the service is being replaced.
Stop-MsmWorkers
Stop-MsmServiceAndWait
Uninstall-MsmServiceAndWait
Stop-MsmWorkers

# At this point the old service and workers are gone, so the binaries can be replaced.
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

$deadline = (Get-Date).AddSeconds(20)
do {
    $Service = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
    if ($Service -and $Service.Status -eq "Running") {
        break
    }
    Start-Sleep -Milliseconds 250
} while ((Get-Date) -lt $deadline)

if (-not $Service) {
    throw "$ServiceName was installed but is no longer registered."
}
if ($Service.Status -ne "Running") {
    throw "$ServiceName was installed but failed to reach Running state. Current state: $($Service.Status)"
}

Write-Host "MSM agent installed successfully as $ServiceName"
Write-Host "Service account: LocalSystem"
Write-Host "Install directory: $InstallDir"
Write-Host "Service command: $($ServiceConfig.PathName)"
Write-Host "Run '$InstalledAgent --print-identity' as administrator to retrieve the device identity and development token."
