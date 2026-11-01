<#
.SYNOPSIS  Stop the development stack (including the observability profile).
.EXAMPLE   .\scripts\dev-down.ps1            # keep data volumes
.EXAMPLE   .\scripts\dev-down.ps1 -Volumes   # also delete Postgres/MinIO/Grafana/... volumes
#>
param([switch]$Volumes)
. "$PSScriptRoot\_common.ps1"
Assert-Docker
$composeArgs = @('--profile', 'observability', 'down', '--remove-orphans')
if ($Volumes) { $composeArgs += '--volumes' }
Invoke-Compose $composeArgs
