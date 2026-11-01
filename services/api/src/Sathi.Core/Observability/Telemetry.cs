using System.Diagnostics;
using System.Diagnostics.Metrics;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Npgsql;
using OpenTelemetry.Metrics;
using OpenTelemetry.Resources;
using OpenTelemetry.Trace;
using Sathi.Core.Options;

namespace Sathi.Core.Observability;

/// <summary>Custom metrics (exported via OTLP → Prometheus).</summary>
public sealed class SathiMetrics : IDisposable
{
    public const string MeterName = "Sathi";
    private readonly Meter _meter;

    public SathiMetrics(IMeterFactory? factory = null)
    {
        _meter = factory?.Create(MeterName) ?? new Meter(MeterName);
        // Units use the "{annotation}" form so the Prometheus exporter does not append unit suffixes to the names.
        TutorTtftMs = _meter.CreateHistogram<double>("sathi_tutor_ttft_ms", "{ms}", "Time to first token of tutor answers");
        AiCostUsd = _meter.CreateCounter<double>("sathi_ai_cost_usd", "{USD}", "Estimated AI cost");
        IngestionFailures = _meter.CreateCounter<long>("sathi_ingestion_failures", description: "Failed document ingestions");
        GradingRouted = _meter.CreateCounter<long>("sathi_grading_routed", description: "Short-answer grading outcomes (tag route)");
        JobsFailed = _meter.CreateCounter<long>("sathi_jobs_failed", description: "Hangfire jobs that reached the Failed state (tags queue, job_type)");
        _meter.CreateObservableGauge("sathi_jobs_queue_oldest_age_seconds", ObserveQueueAges,
            description: "Age of the oldest enqueued job per Hangfire queue (jobs host)");
    }

    public Counter<long> JobsFailed { get; }

    private readonly System.Collections.Concurrent.ConcurrentDictionary<string, double> _queueAges = new();

    /// <summary>Updated periodically by the jobs host (QueueAgeSampler); read on each metrics collection.</summary>
    public void SetQueueOldestAge(string queue, double seconds) => _queueAges[queue] = seconds;

    private IEnumerable<Measurement<double>> ObserveQueueAges() =>
        _queueAges.Select(kv => new Measurement<double>(kv.Value, new KeyValuePair<string, object?>("queue", kv.Key)));

    /// <summary>Grading outcome tag: "route" (dashboards) — "outcome" kept for compatibility.</summary>
    public void RecordGradingRouted(string route) =>
        GradingRouted.Add(1, new KeyValuePair<string, object?>("route", route), new KeyValuePair<string, object?>("outcome", route));

    public Histogram<double> TutorTtftMs { get; }
    public Counter<double> AiCostUsd { get; }
    public Counter<long> IngestionFailures { get; }
    public Counter<long> GradingRouted { get; }

    public void Dispose() => _meter.Dispose();
}

public static class SathiTelemetry
{
    public const string ActivitySourceName = "Sathi";
    public static readonly ActivitySource Source = new(ActivitySourceName);

    /// <summary>Traces + metrics; exporters only when OTEL_EXPORTER_OTLP_ENDPOINT is set. Listeners are always on so trace ids exist.</summary>
    public static IServiceCollection AddSathiTelemetry(this IServiceCollection services, IConfiguration configuration,
        SathiEnvironment env, bool aspNetCore = true)
    {
        var endpoint = configuration[SathiLogging.DefaultOtlpEndpointVariable];
        var export = !string.IsNullOrWhiteSpace(endpoint);
        services.AddSingleton<SathiMetrics>();

        services.AddOpenTelemetry()
            .ConfigureResource(r => r
                .AddService(env.Service, serviceVersion: env.Version)
                .AddAttributes([new KeyValuePair<string, object>("deployment.environment", env.Env)]))
            .WithTracing(t =>
            {
                t.AddSource(ActivitySourceName, "Sathi.Jobs")
                 .AddHttpClientInstrumentation(o => o.FilterHttpRequestMessage = r => r.RequestUri?.AbsolutePath.StartsWith("/health", StringComparison.Ordinal) != true)
                 .AddNpgsql();
                if (aspNetCore)
                    t.AddAspNetCoreInstrumentation(o =>
                    {
                        o.Filter = ctx => !ctx.Request.Path.StartsWithSegments("/health");
                        o.RecordException = true;
                    });
                if (export) t.AddOtlpExporter();
            })
            .WithMetrics(m =>
            {
                m.AddMeter(SathiMetrics.MeterName, "Npgsql")
                 .AddHttpClientInstrumentation();
                if (aspNetCore) m.AddAspNetCoreInstrumentation();
                if (export) m.AddOtlpExporter();
            });
        return services;
    }
}
