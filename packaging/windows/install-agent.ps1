param(
    [string]$BinaryPath = ".\msm-agent.exe"
)

$InstallDir = "$env:ProgramFiles\MSM"
New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
Copy-Item $BinaryPath "$InstallDir\msm-agent.exe" -Force

$ServiceName = "MSMAgent"
$Existing = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
if ($Existing) {
    Stop-Service $ServiceName -Force -ErrorAction SilentlyContinue
    sc.exe delete $ServiceName | Out-Null
}

sc.exe create $ServiceName binPath= "`"$InstallDir\msm-agent.exe`" --listen 127.0.0.1:40123" start= auto | Out-Null
sc.exe description $ServiceName "MSM multiseat remote monitor and control agent" | Out-Null
Start-Service $ServiceName
Write-Host "MSM agent installed as $ServiceName"
