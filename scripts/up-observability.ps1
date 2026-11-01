<#
.SYNOPSIS  Start the stack with the observability profile (OTel Collector, Loki, Tempo, Prometheus,
           Grafana) and point every service's OpenTelemetry exporter at the collector.
#>
param([Parameter(ValueFromRemainingArguments = $true)][string[]]$Services)
. "$PSScriptRoot\_common.ps1"
Assert-Docker
Confirm-EnvFile
$env:OTEL_EXPORTER_OTLP_ENDPOINT = 'http://otel-collector:4317'
try {
    Invoke-Compose (@('--profile', 'observability', 'up', '-d', '--build', '--wait') + $Services)
} finally {
    Remove-Item Env:\OTEL_EXPORTER_OTLP_ENDPOINT -ErrorAction SilentlyContinue
}
Write-Host ''
Write-Host 'Grafana:    http://localhost:3000   (dashboards in folder Sathi)'
Write-Host 'Prometheus: http://localhost:9090/alerts'
