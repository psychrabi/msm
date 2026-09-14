#Requires -Version 5.1
<#
.SYNOPSIS
  Creates a self-signed TLS certificate + key for the MSM agent.

.DESCRIPTION
  Generates cert.pem and key.pem with SubjectAltNames covering the DNS names
  and IPs you pass (defaults: this machine's hostname plus its LAN IPv4s).
  Copy both files to C:\ProgramData\MSM\agent\tls\ on the agent machine
  before running install-agent.ps1, and install cert.pem into Trusted Root
  on every machine that runs the MSM app.

.PARAMETER OutDir
  Directory receiving cert.pem and key.pem. Defaults to this script's folder.

.PARAMETER DnsNames
  DNS SANs. Defaults to the local hostname plus "localhost".

.PARAMETER IpAddresses
  IP SANs. Defaults to this machine's non-loopback IPv4 addresses.

.PARAMETER Days
  Validity period. Defaults to 825 days.
#>
[CmdletBinding()]
param(
    [string]$OutDir = $PSScriptRoot,
    [string[]]$DnsNames = @(),
    [string[]]$IpAddresses = @(),
    [int]$Days = 825
)

$ErrorActionPreference = "Stop"

function Find-OpenSsl {
    foreach ($candidate in @(
        "openssl",
        "C:\Program Files\Git\usr\bin\openssl.exe",
        "C:\Program Files\OpenSSL-Win64\bin\openssl.exe"
    )) {
        try { return (Get-Command $candidate -ErrorAction Stop).Source } catch {}
    }
    throw "openssl not found. Install it (winget install OpenSSL.OpenSSL) or use Git for Windows, then re-run."
}

if (-not $DnsNames -or $DnsNames.Count -eq 0) {
    $DnsNames = @($env:COMPUTERNAME, "localhost")
}
if (-not $IpAddresses -or $IpAddresses.Count -eq 0) {
    $IpAddresses = @(Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue |
        Where-Object { $_.IPAddress -notlike "127.*" -and $_.IPAddress -notlike "169.254.*" } |
        Select-Object -ExpandProperty IPAddress -Unique)
}
if (-not $IpAddresses -or $IpAddresses.Count -eq 0) { throw "No LAN IPv4 address found; pass -IpAddresses explicitly." }

$san = (($DnsNames | ForEach-Object { "DNS:$_" }) + ($IpAddresses | ForEach-Object { "IP:$_" })) -join ","
$OutDir = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($OutDir)
New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
$key = Join-Path $OutDir "key.pem"
$cert = Join-Path $OutDir "cert.pem"

$openssl = Find-OpenSsl
& $openssl req -x509 -newkey rsa:2048 -keyout $key -out $cert -days $Days -nodes `
    -subj "/CN=$($DnsNames[0])" -addext "subjectAltName=$san" `
    -addext "basicConstraints=critical,CA:FALSE" `
    -addext "keyUsage=critical,digitalSignature,keyEncipherment" `
    -addext "extendedKeyUsage=serverAuth"
if ($LASTEXITCODE -ne 0) { throw "openssl failed with exit code $LASTEXITCODE." }
$constraints = & $openssl x509 -in $cert -noout -text | Select-String -Pattern "CA:TRUE"
if ($constraints) { throw "Generated certificate is a CA cert (CA:TRUE); rustls will reject it as a server leaf." }

Write-Host ""
Write-Host "Wrote:"
Write-Host "  $cert"
Write-Host "  $key"
Write-Host "SANs: $san"
& $openssl x509 -in $cert -noout -fingerprint -sha256
Write-Host ""
Write-Host "Next: copy both files to C:\ProgramData\MSM\agent\tls\ on the agent"
Write-Host "machine, then run install-agent.ps1 elevated. Install cert.pem into"
Write-Host "Trusted Root on every machine that runs the MSM app."
