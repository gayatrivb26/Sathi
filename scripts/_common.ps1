# Shared helpers for the PowerShell scripts in this directory (dot-sourced).
$ErrorActionPreference = 'Stop'
$script:SathiRoot = Split-Path -Parent $PSScriptRoot
Set-Location $script:SathiRoot
$script:SathiProject = if ($env:COMPOSE_PROJECT_NAME) { $env:COMPOSE_PROJECT_NAME } else { 'sathi' }

function Assert-Docker {
    if (-not (Get-Command docker -ErrorAction SilentlyContinue)) { throw 'docker not found on PATH' }
    docker compose version *> $null
    if ($LASTEXITCODE -ne 0) { throw 'Docker Compose v2 is required (docker compose ...)' }
}

function Confirm-EnvFile {
    if (-not (Test-Path (Join-Path $script:SathiRoot '.env'))) {
        Write-Host '.env not found - generating one from .env.example'
        & (Join-Path $PSScriptRoot 'generate-secrets.ps1')
    }
}

function Invoke-Compose {
    # Accepts loose arguments or one array of arguments: Invoke-Compose @('up', '-d')
    param([Parameter(ValueFromRemainingArguments = $true)]$Arguments)
    $flat = @($Arguments | ForEach-Object { $_ } | ForEach-Object { [string]$_ })
    # docker writes progress to stderr; judge success by the exit code only (PowerShell 5.1).
    $ErrorActionPreference = 'Continue'
    & docker compose @flat
    if ($LASTEXITCODE -ne 0) { throw "docker compose $($flat -join ' ') failed with exit code $LASTEXITCODE" }
}
