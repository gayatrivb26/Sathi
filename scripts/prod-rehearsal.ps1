<#
.SYNOPSIS  Production-profile rehearsal (compose.yaml + compose.prod.yaml) under project 'sathi-prod'.
.EXAMPLE   .\scripts\prod-rehearsal.ps1                    # up (app + data)
.EXAMPLE   .\scripts\prod-rehearsal.ps1 -Observability     # up incl. observability profile
.EXAMPLE   .\scripts\prod-rehearsal.ps1 -Down [-Volumes]   # stop (and optionally delete its volumes)
#>
param([switch]$Observability, [switch]$Down, [switch]$Volumes)
. "$PSScriptRoot\_common.ps1"
Assert-Docker
Confirm-EnvFile
$base = @('-p', 'sathi-prod', '-f', 'compose.yaml', '-f', 'compose.prod.yaml')
if ($Down) {
    $a = $base + @('--profile', 'observability', 'down', '--remove-orphans')
    if ($Volumes) { $a += '--volumes' }
    Invoke-Compose $a
    exit 0
}
if ($Observability) {
    $env:OTEL_EXPORTER_OTLP_ENDPOINT = 'http://otel-collector:4317'
    try { Invoke-Compose ($base + @('--profile', 'observability', 'up', '-d', '--build', '--wait')) }
    finally { Remove-Item Env:\OTEL_EXPORTER_OTLP_ENDPOINT -ErrorAction SilentlyContinue }
} else {
    Invoke-Compose ($base + @('up', '-d', '--build', '--wait'))
}
Invoke-Compose ($base + @('ps'))
