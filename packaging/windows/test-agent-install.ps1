#Requires -RunAsAdministrator
[CmdletBinding()]
param(
    [string]$InstallDir = (Join-Path $env:ProgramFiles "MSM"),
    [string]$DataDir = (Join-Path $env:ProgramData "MSM\agent"),
    [string]$ServiceName = "MSMAgent",
    [int]$AgentPort = 40123
)

$ErrorActionPreference = "Stop"

function Assert-True([bool]$Condition, [string]$Message) {
    if (-not $Condition) { throw "SMOKE TEST FAILED: $Message" }
}

$service = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
Assert-True ($null -ne $service) "service '$ServiceName' is not installed"
Assert-True ($service.Status -eq "Running") "service '$ServiceName' is not Running (state: $($service.Status))"

$agent = Join-Path $InstallDir "msm-agent.exe"
$worker = Join-Path $InstallDir "msm-agent-worker.exe"
$token = Join-Path $DataDir "access-token"
$identity = Join-Path $DataDir "identity.json"

Assert-True (Test-Path -LiteralPath $agent -PathType Leaf) "Agent binary is missing"
Assert-True (Test-Path -LiteralPath $worker -PathType Leaf) "worker binary is missing"
Assert-True (Test-Path -LiteralPath $token -PathType Leaf) "access-token file is missing"
Assert-True (Test-Path -LiteralPath $identity -PathType Leaf) "identity.json is missing"

$tokenValue = (Get-Content -LiteralPath $token -Raw).Trim()
Assert-True ($tokenValue.Length -ge 16) "access-token is empty or unexpectedly short"

$config = Get-CimInstance Win32_Service -Filter "Name='$ServiceName'"
Assert-True ($null -ne $config) "service configuration cannot be read"
Assert-True ($config.StartName -eq "LocalSystem") "service account is '$($config.StartName)', expected LocalSystem"
Assert-True ($config.PathName -match '--run-service') "service command line does not contain --run-service"
Assert-True ($config.PathName -notmatch '--tls-cert|--tls-key') "plain LAN build unexpectedly contains TLS service arguments"

$acl = Get-Acl -LiteralPath $DataDir
$allowed = @($acl.Access | Where-Object { $_.AccessControlType -eq "Allow" -and $_.IdentityReference -in @("NT AUTHORITY\SYSTEM", "BUILTIN\Administrators") })
Assert-True ($allowed.Count -ge 2) "Agent data directory does not expose the expected SYSTEM/Administrators ACLs"

$agentRule = Get-NetFirewallRule -DisplayName "MSM Agent" -ErrorAction SilentlyContinue
Assert-True ($null -ne $agentRule) "MSM Agent firewall rule is missing"

$vncRule = Get-NetFirewallRule -DisplayName "MSM VNC Local Only" -ErrorAction SilentlyContinue
Assert-True ($null -ne $vncRule) "MSM VNC Local Only firewall rule is missing"

$unauthorized = $false
try {
    Invoke-WebRequest -UseBasicParsing -Uri "http://127.0.0.1:$AgentPort/health" -TimeoutSec 5 -ErrorAction Stop | Out-Null
} catch {
    $response = $_.Exception.Response
    if ($response -and [int]$response.StatusCode -eq 401) { $unauthorized = $true }
}
Assert-True $unauthorized "unauthenticated /health request did not return HTTP 401"

$headers = @{ Authorization = "Bearer $tokenValue" }
$health = Invoke-RestMethod -Method Get -Uri "http://127.0.0.1:$AgentPort/health" -Headers $headers -TimeoutSec 5
Assert-True ($health.status -eq "ok") "authenticated /health request did not return status=ok"
Assert-True ($null -ne $health.device.deviceId) "authenticated /health response did not include device identity"

$listeners = @(Get-NetTCPConnection -LocalPort 5901,5902,5903 -State Listen -ErrorAction SilentlyContinue)
foreach ($listener in $listeners) {
    Assert-True ($listener.LocalAddress -in @("127.0.0.1", "::1")) "VNC listener $($listener.LocalAddress):$($listener.LocalPort) is not loopback-only"
}

Write-Host "MSM Agent installation smoke test passed."
Write-Host "Service: $ServiceName ($($service.Status))"
Write-Host "Agent endpoint: http://127.0.0.1:$AgentPort"
Write-Host "Data directory: $DataDir"
