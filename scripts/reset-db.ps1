<#
.SYNOPSIS  DESTROYS the local Postgres volume, re-runs the init script, both migrators and the seed.
.EXAMPLE   .\scripts\reset-db.ps1 -Yes
#>
param([switch]$Yes)
. "$PSScriptRoot\_common.ps1"
Assert-Docker
$volume = "$($script:SathiProject)_postgres-data"
if (-not $Yes) {
    $answer = Read-Host "Delete ALL local Sathi database data (volume $volume)? [y/N]"
    if ($answer -notmatch '^[Yy]$') { Write-Host 'aborted'; exit 1 }
}
$ErrorActionPreference = 'Continue'   # best-effort steps below may write to stderr
& docker compose stop web api jobs ai-service ai-ingest *> $null
Invoke-Compose @('rm', '-sf', 'postgres', 'migrator-app', 'migrator-ai')
& docker volume rm $volume *> $null
Invoke-Compose @('up', '-d', '--wait')
Write-Host 'Database recreated and seeded.'
