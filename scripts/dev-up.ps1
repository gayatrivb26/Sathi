<#
.SYNOPSIS  Build and start the development stack (compose.yaml + compose.override.yaml).
.EXAMPLE   .\scripts\dev-up.ps1            # everything
.EXAMPLE   .\scripts\dev-up.ps1 web api    # selected services (and their dependencies)
#>
param([Parameter(ValueFromRemainingArguments = $true)][string[]]$Services)
. "$PSScriptRoot\_common.ps1"
Assert-Docker
Confirm-EnvFile
Invoke-Compose (@('up', '-d', '--build', '--wait') + $Services)
Write-Host ''
Write-Host 'Sathi:   http://localhost:8080'
Write-Host 'Mailpit: http://localhost:8025   MinIO console: http://localhost:9001'
Write-Host 'Logs:    .\scripts\logs.ps1 [service]     Stop: .\scripts\dev-down.ps1'
