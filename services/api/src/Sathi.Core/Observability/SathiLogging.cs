using System.Security.Claims;
using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using Serilog;
using Serilog.Core;
using Serilog.Events;
using Serilog.Sinks.OpenTelemetry;
using Sathi.Core.Options;
using Sathi.Core.Security;

namespace Sathi.Core.Observability;

/// <summary>Runtime-switchable minimum level (PUT /api/v1/admin/log-level).</summary>
public sealed class LogLevelControl
{
    public LoggingLevelSwitch Switch { get; }

    public LogLevelControl(LogEventLevel initial) => Switch = new LoggingLevelSwitch(initial);

    public static bool TryParseLevel(string? value, out LogEventLevel level)
    {
        level = LogEventLevel.Information;
        switch (value?.Trim().ToLowerInvariant())
        {
            case "debug" or "verbose" or "trace": level = LogEventLevel.Debug; return true;
            case "info" or "information": level = LogEventLevel.Information; return true;
            case "warning" or "warn": level = LogEventLevel.Warning; return true;
            case "error": level = LogEventLevel.Error; return true;
            default: return false;
        }
    }
}

/// <summary>Adds user_id_hash for the signed-in user of the current HTTP request.</summary>
public sealed class UserIdHashEnricher(IHttpContextAccessor accessor, UserIdHasher hasher) : ILogEventEnricher
{
    private const string ItemKey = "sathi.user_id_hash";

    public void Enrich(LogEvent logEvent, ILogEventPropertyFactory propertyFactory)
    {
        if (logEvent.Properties.ContainsKey("user_id_hash")) return;
        var ctx = accessor.HttpContext;
        if (ctx is null) return;
        string? hash;
        if (ctx.Items.TryGetValue(ItemKey, out var cached)) hash = cached as string;
        else
        {
            var id = ctx.User?.FindFirstValue(ClaimTypes.NameIdentifier);
            hash = string.IsNullOrEmpty(id) ? null : hasher.Hash(id);
            if (hash is not null) ctx.Items[ItemKey] = hash;
        }
        if (hash is not null) logEvent.AddPropertyIfAbsent(propertyFactory.CreateProperty("user_id_hash", hash));
    }
}

public static class SathiLogging
{
    public const string DefaultOtlpEndpointVariable = "OTEL_EXPORTER_OTLP_ENDPOINT";

    /// <summary>Registers Serilog for a host (api / jobs / migrator) with the contract §8 JSON shape.</summary>
    public static IServiceCollection AddSathiSerilog(this IServiceCollection services, IConfiguration configuration, SathiEnvironment env)
    {
        var initial = LogLevelControl.TryParseLevel(configuration["Serilog:MinimumLevel"] ?? configuration["LOG_LEVEL"], out var lvl)
            ? lvl : LogEventLevel.Information;
        services.AddSingleton(new LogLevelControl(initial));
        services.AddSingleton(env);

        services.AddSerilog((sp, cfg) => Configure(cfg, sp, configuration, env), preserveStaticLogger: true);
        return services;
    }

    public static void Configure(LoggerConfiguration cfg, IServiceProvider sp, IConfiguration configuration, SathiEnvironment env)
    {
        var control = sp.GetRequiredService<LogLevelControl>();
        cfg.MinimumLevel.ControlledBy(control.Switch)
            .MinimumLevel.Override("Microsoft", LogEventLevel.Warning)
            .MinimumLevel.Override("Microsoft.Hosting.Lifetime", LogEventLevel.Information)
            .MinimumLevel.Override("Microsoft.EntityFrameworkCore", LogEventLevel.Warning)
            // Failed commands surface as exceptions and are logged once at the boundary that handles them.
            .MinimumLevel.Override("Microsoft.EntityFrameworkCore.Database.Command", LogEventLevel.Fatal)
            .MinimumLevel.Override("System.Net.Http.HttpClient", LogEventLevel.Warning)
            // /health/ready is polled by orchestrators; an unhealthy dependency is reported by the endpoint, not as an Error log per poll.
            .MinimumLevel.Override("Microsoft.Extensions.Diagnostics.HealthChecks", LogEventLevel.Fatal)
            .MinimumLevel.Override("Hangfire", LogEventLevel.Information)
            .MinimumLevel.Override("Amazon", LogEventLevel.Warning)
            .Destructure.With(new RedactingDestructuringPolicy())
            .Enrich.WithProperty("service", env.Service)
            .Enrich.WithProperty("env", env.Env)
            .Enrich.WithProperty("version", env.Version)
            .Enrich.FromLogContext();

        var accessor = sp.GetService<IHttpContextAccessor>();
        var hasher = sp.GetService<UserIdHasher>();
        if (accessor is not null && hasher is not null) cfg.Enrich.With(new UserIdHashEnricher(accessor, hasher));

        // Sinks/enrichers registered in DI (tests add a capturing sink).
        cfg.ReadFrom.Services(sp);

        // Redaction must be the last enricher.
        cfg.Enrich.With(new RedactionEnricher());

        if (!configuration.GetValue("Serilog:DisableConsole", false))
            cfg.WriteTo.Console(new SathiJsonFormatter());

        var otlp = configuration[DefaultOtlpEndpointVariable];
        if (!string.IsNullOrWhiteSpace(otlp))
        {
            cfg.WriteTo.OpenTelemetry(o =>
            {
                o.Endpoint = otlp;
                o.Protocol = otlp.Contains(":4318", StringComparison.Ordinal) ? OtlpProtocol.HttpProtobuf : OtlpProtocol.Grpc;
                if (o.Protocol == OtlpProtocol.HttpProtobuf && !otlp.EndsWith("/v1/logs", StringComparison.Ordinal))
                    o.Endpoint = otlp.TrimEnd('/') + "/v1/logs";
                o.ResourceAttributes = new Dictionary<string, object>
                {
                    ["service.name"] = env.Service,
                    ["service.version"] = env.Version,
                    ["deployment.environment"] = env.Env,
                };
                o.IncludedData = IncludedData.TraceIdField | IncludedData.SpanIdField | IncludedData.MessageTemplateTextAttribute
                                 | IncludedData.SourceContextAttribute;
            });
        }
    }

    /// <summary>Bootstrap logger used before the host is built (and for fatal start-up errors).</summary>
    public static Serilog.ILogger CreateBootstrapLogger(SathiEnvironment env) =>
        new LoggerConfiguration()
            .MinimumLevel.Information()
            .Enrich.WithProperty("service", env.Service)
            .Enrich.WithProperty("env", env.Env)
            .Enrich.WithProperty("version", env.Version)
            .Enrich.With(new RedactionEnricher())
            .WriteTo.Console(new SathiJsonFormatter())
            .CreateLogger();

    public static bool IsDevelopmentLike(this IHostEnvironment env) =>
        env.IsDevelopment() || env.IsEnvironment("Testing") || env.IsEnvironment("Test");
}
