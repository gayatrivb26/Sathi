<#
.SYNOPSIS  Static checks for infrastructure config: compose files, Prometheus rules + unit tests,
           Prometheus config, OTel Collector config, nginx config (bash twin: check-monitoring.sh).
#>
. "$PSScriptRoot\_common.ps1"
Assert-Docker
$root = $script:SathiRoot
$envFile = if (Test-Path (Join-Path $root '.env')) { '.env' } else { '.env.example' }

function Invoke-Checked {
    # Simple function (no param block) so flags like -w / -v are passed through, not bound.
    $ErrorActionPreference = 'Continue'
    & docker @args
    if ($LASTEXITCODE -ne 0) { throw "docker $($args -join ' ') failed" }
}

Write-Host '== docker compose config'
$combos = @(
    , @('-f', 'compose.yaml')
    , @('-f', 'compose.yaml', '-f', 'compose.override.yaml')
    , @('-f', 'compose.yaml', '-f', 'compose.test.yaml')
    , @('-f', 'compose.yaml', '-f', 'compose.prod.yaml')
)
foreach ($files in $combos) {
    foreach ($withProfile in @($false, $true)) {
        $profileArgs = @()
        if ($withProfile) { $profileArgs = @('--profile', 'observability') }
        Invoke-Compose (@('--env-file', $envFile) + $files + $profileArgs + @('config', '-q'))
        Write-Host "ok: $($files -join ' ') $($profileArgs -join ' ')"
    }
}

$prom = Join-Path $root 'infrastructure\monitoring\prometheus'
Write-Host '== promtool'
Invoke-Checked run --rm -v "${prom}:/w" -w /w --entrypoint promtool prom/prometheus:v3.2.1 check rules alerts.yml
Invoke-Checked run --rm -v "${prom}:/w" -w /w --entrypoint promtool prom/prometheus:v3.2.1 test rules alerts.test.yml
Invoke-Checked run --rm -v "${prom}:/etc/prometheus" --entrypoint promtool prom/prometheus:v3.2.1 check config /etc/prometheus/prometheus.yml

Write-Host '== otelcol validate'
$otel = Join-Path $root 'infrastructure\monitoring\otel-collector\config.yaml'
Invoke-Checked run --rm -v "${otel}:/etc/otelcol/config.yaml:ro" otel/opentelemetry-collector-contrib:0.120.0 validate --config=/etc/otelcol/config.yaml
Write-Host 'ok: otel-collector'

Write-Host '== nginx -t'
$nginx = Join-Path $root 'infrastructure\nginx\default.conf'
Invoke-Checked run --rm -v "${nginx}:/etc/nginx/conf.d/default.conf:ro" nginxinc/nginx-unprivileged:1.27-alpine nginx -t
