param(
    [string]$AgentBinaryPath = ".\msm-agent.exe",
    [string]$WorkerBinaryPath = ".\msm-agent-worker.exe"
)

$InstallDir = "$env:ProgramFiles\MSM"
New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
Copy-Item $AgentBinaryPath "$InstallDir\msm-agent.exe" -Force
Copy-Item $WorkerBinaryPath "$InstallDir\msm-agent-worker.exe" -Force

$ServiceName = "MSMAgent"
$Existing = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
if ($Existing) {
    Stop-Service $ServiceName -Force -ErrorAction SilentlyContinue
    sc.exe delete $ServiceName | Out-Null
}

sc.exe create $ServiceName binPath= "`"$InstallDir\msm-agent.exe`" --listen 0.0.0.0:40123" start= auto obj= LocalSystem | Out-Null
sc.exe description $ServiceName "MSM multiseat remote monitor and control agent" | Out-Null

# The agent is the only intended remote entry point. Per-session VNC listeners
# are implementation details and should not be reachable from other hosts.
Get-NetFirewallRule -DisplayName "MSM Agent" -ErrorAction SilentlyContinue | Remove-NetFirewallRule -ErrorAction SilentlyContinue
New-NetFirewallRule -DisplayName "MSM Agent" -Direction Inbound -Protocol TCP -LocalPort 40123 -Action Allow -Profile Domain,Private | Out-Null
Get-NetFirewallRule -DisplayName "MSM VNC Local Only" -ErrorAction SilentlyContinue | Remove-NetFirewallRule -ErrorAction SilentlyContinue
New-NetFirewallRule -DisplayName "MSM VNC Local Only" -Direction Inbound -Protocol TCP -LocalPort 5901-6900 -Action Block -Profile Any | Out-Null

Start-Service $ServiceName
Write-Host "MSM agent installed as $ServiceName"
Write-Host "Run '$InstallDir\msm-agent.exe --print-identity' as administrator to retrieve the device identity and development token."
