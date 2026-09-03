# Deploy ProjectBounty server tree to Ubuntu host (run from Windows PowerShell).
#
# Usage:
#   cd HomeAssistConfig\ProjectBounty\server
#   .\setup\deploy-to-server.ps1
#
# Default target: root@Bounty-Server (192.168.1.206)

param(
    [string]$Target = "root@Bounty-Server",
    [string]$RemoteDir = "/opt/projectbounty-deploy"
)

$ErrorActionPreference = "Stop"
$Here = Split-Path -Parent $PSScriptRoot   # .../server

Write-Host "Deploying $Here -> ${Target}:${RemoteDir}"
Write-Host "You will be prompted for the SSH password if no key is configured."
Write-Host ""

# Ensure remote dir exists
ssh $Target "mkdir -p $RemoteDir"

# Copy app + requirements + setup (no venv/media/data)
scp -r `
    "$Here\app" `
    "$Here\requirements.txt" `
    "$Here\setup" `
    "${Target}:${RemoteDir}/"

Write-Host ""
Write-Host "Files copied. SSH in and run the installer:"
Write-Host "  ssh $Target"
Write-Host "  bash $RemoteDir/setup/install-server.sh"
Write-Host ""
