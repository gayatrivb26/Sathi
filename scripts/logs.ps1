<#
.SYNOPSIS  Follow container logs, or filter them.
.EXAMPLE   .\scripts\logs.ps1                      # follow all services
.EXAMPLE   .\scripts\logs.ps1 api ai-service       # follow selected services
.EXAMPLE   .\scripts\logs.ps1 -Errors api          # only warning/error JSON lines
.EXAMPLE   .\scripts\logs.ps1 -Trace 7F3A-91C2     # lines whose trace_id starts with a reference ID
#>
param(
    [switch]$Errors,
    [string]$Trace,
    [Parameter(ValueFromRemainingArguments = $true)][string[]]$Services
)
. "$PSScriptRoot\_common.ps1"
Assert-Docker
if ($Errors -or $Trace) {
    if ($Trace) {
        $pattern = '"trace_id":"' + ($Trace -replace '-', '').ToLowerInvariant()
    } else {
        $pattern = '"level":"(warn|warning|error|fatal|critical)"'
    }
    & docker compose --profile observability logs --no-log-prefix --tail=2000 @Services |
        Select-String -Pattern $pattern | ForEach-Object { $_.Line }
} else {
    & docker compose --profile observability logs -f --tail=200 @Services
}
