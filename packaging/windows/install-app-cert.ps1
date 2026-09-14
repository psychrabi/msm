#Requires -RunAsAdministrator
<#
.SYNOPSIS
  Trusts an MSM agent certificate on a machine that runs the MSM app.

.DESCRIPTION
  Imports cert.pem into Local Machine Trusted Root so the app's wss://
  control connection and VNC viewer verify the agent. Removes stale
  same-subject certificates first (they cause silent trust confusion).
  Safe to re-run: exits quietly if this exact certificate is trusted.

.PARAMETER CertificatePath
  Path to the agent's cert.pem. Defaults to .\cert.pem.

.PARAMETER ExpectedThumbprint
  Optional SHA-1 thumbprint (colons/spaces/case ignored). Aborts on mismatch.
#>
[CmdletBinding()]
param(
    [string]$CertificatePath = ".\cert.pem",
    [string]$ExpectedThumbprint = ""
)

$ErrorActionPreference = "Stop"

$CertificatePath = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($CertificatePath)
if (-not (Test-Path -LiteralPath $CertificatePath -PathType Leaf)) {
    throw "Certificate not found: $CertificatePath"
}

$dump = @(& certutil.exe -dump $CertificatePath 2>&1)
if ($LASTEXITCODE -ne 0) { throw "certutil could not read $CertificatePath" }
$hashLine = $dump | Select-String -Pattern "Cert Hash\(sha1\):" | Select-Object -First 1
$subject = ""
for ($i = 0; $i -lt ($dump.Count - 1); $i++) {
    if ($dump[$i] -match "^\s*Subject:\s*$") { $subject = $dump[$i + 1].Trim(); break }
}
if (-not $hashLine -or -not $subject) { throw "Could not parse certificate details from $CertificatePath" }
$thumbprint = (($hashLine.Line -split ":", 2)[1] -replace "[^0-9a-fA-F]", "").ToUpperInvariant()

if ($ExpectedThumbprint) {
    $want = ($ExpectedThumbprint -replace "[^0-9a-fA-F]", "").ToUpperInvariant()
    if ($thumbprint -ne $want) {
        throw "Certificate thumbprint mismatch. File: $thumbprint Expected: $want"
    }
}

$store = Get-ChildItem Cert:\LocalMachine\Root
if ($store | Where-Object { $_.Thumbprint -eq $thumbprint }) {
    Write-Host "Already trusted: $subject [$thumbprint]"
    return
}

$stale = @($store | Where-Object { $_.Subject -eq $subject -and $_.Thumbprint -ne $thumbprint })
foreach ($old in $stale) {
    Write-Host "Removing stale certificate: $($old.Thumbprint)"
    $old | Remove-Item
}

& certutil.exe -f -addstore Root $CertificatePath | Out-Null
if ($LASTEXITCODE -ne 0) { throw "certutil import failed with exit code $LASTEXITCODE." }
$check = Get-ChildItem Cert:\LocalMachine\Root | Where-Object { $_.Thumbprint -eq $thumbprint }
if (-not $check) { throw "Import reported success but the certificate is not in the store." }

Write-Host ""
Write-Host "Trusted: $subject"
Write-Host "Thumbprint: $thumbprint"
Write-Host "Next: in the MSM app, add https://<AGENT-IP>:40123 with the agent access token."
