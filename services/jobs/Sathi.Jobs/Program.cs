using System.Text.Json;
using Hangfire;
using Hangfire.Dashboard;
using Microsoft.AspNetCore.DataProtection;
using Microsoft.AspNetCore.Diagnostics.HealthChecks;
using Microsoft.AspNetCore.Identity;
using Microsoft.Extensions.Options;
using Sathi.Core;
using Sathi.Core.Data;
using Sathi.Core.Domain;
using Sathi.Core.Errors;
using Sathi.Core.Jobs;
using Sathi.Core.Observability;
using Sathi.Core.Options;
using Sathi.Core.Security;
using Serilog;
using Serilog.Context;

// Sathi.Jobs — Hangfire server (queues critical / default / ai-heavy) + admin-only dashboard at /hangfire.
var builder = WebApplication.CreateBuilder(args);
var env = SathiEnvironment.From(builder.Configuration, "jobs", builder.Environment.EnvironmentName);
Log.Logger = SathiLogging.CreateBootstrapLogger(env);

try
{
    var services = builder.Services;
    var config = builder.Configuration;

    services.AddHttpContextAccessor();
    services.AddSathiSerilog(config, env);
    services.AddSathiTelemetry(config, env);
    services.AddSathiData(config);
    services.AddSathiServices(config, tokenIssuer: "sathi-jobs");
    services.AddOptions<ConnectionStringOptions>()
        .Validate(o => !string.IsNullOrWhiteSpace(o.Hangfire), "ConnectionStrings:Hangfire is required.").ValidateOnStart();

    // Same key ring + application name + cookie name as the API, so the API's sign-in cookie is valid on /hangfire.
    var secureCookies = !builder.Environment.AllowsInsecureCookies();
    services.AddSathiForwardedHeaders();
    services.AddDataProtection().SetApplicationName("Sathi").PersistKeysToDbContext<AppDbContext>();
    services.AddAuthentication(IdentityConstants.ApplicationScheme)
        .AddCookie(IdentityConstants.ApplicationScheme, o =>
        {
            o.Cookie.Name = "sathi.auth";
            o.Cookie.HttpOnly = true;
            o.Cookie.SameSite = SameSiteMode.Lax;
            o.Cookie.SecurePolicy = secureCookies ? CookieSecurePolicy.Always : CookieSecurePolicy.SameAsRequest;
            o.SlidingExpiration = false;
            o.Events.OnRedirectToLogin = ctx =>
            {
                ctx.Response.Redirect("/auth/login?returnUrl=" + Uri.EscapeDataString("/hangfire"));
                return Task.CompletedTask;
            };
        });
    services.AddAuthorization();
    services.AddAntiforgery();

    var jobsSection = config.GetSection("Jobs");
    services.AddHangfire((sp, cfg) =>
    {
        var cs = sp.GetRequiredService<IOptions<ConnectionStringOptions>>().Value.Hangfire!;
        cfg.UseSathiHangfireStorage(cs, prepareSchema: true);
        cfg.UseFilter(new JobObservabilityFilter(sp.GetRequiredService<ILoggerFactory>(), sp.GetRequiredService<SathiMetrics>()));
    });
    AddServer(services, JobQueues.Critical, jobsSection.GetValue("CriticalWorkers", 2));
    AddServer(services, JobQueues.Default, jobsSection.GetValue("DefaultWorkers", 2));
    AddServer(services, JobQueues.AiHeavy, jobsSection.GetValue("AiHeavyWorkers", 1));
    services.AddHostedService<RecurringJobsRegistrar>();
    services.AddHostedService<QueueAgeSampler>();

    services.AddHealthChecks().AddDbContextCheck<AppDbContext>("db", tags: ["ready"]);

    // Bounded retries (contract §10) instead of Hangfire's default 10 attempts.
    foreach (var f in GlobalJobFilters.Filters.Where(f => f.Instance is AutomaticRetryAttribute).Select(f => f.Instance).ToList())
        GlobalJobFilters.Filters.Remove(f);
    GlobalJobFilters.Filters.Add(new AutomaticRetryAttribute
    {
        Attempts = JobRetry.Attempts, DelaysInSeconds = JobRetry.Delays, ExceptOn = [typeof(NonRetryableJobException)],
    });

    var app = builder.Build();

    app.UseForwardedHeaders();
    app.Use(async (ctx, next) =>
    {
        using (LogContext.PushProperty("request_id", ctx.Request.Headers["X-Request-Id"].FirstOrDefault() ?? ctx.TraceIdentifier))
            await next(ctx);
    });
    app.UseRouting();
    app.UseAuthentication();
    app.UseAuthorization();

    app.MapHealthChecks("/health/live", new HealthCheckOptions { Predicate = _ => false });
    app.MapHealthChecks("/health/ready", new HealthCheckOptions { Predicate = c => c.Tags.Contains("ready") });

    // Signed-in non-admins get a ProblemDetails 403; anonymous browsers are sent to the SPA login.
    app.Use(async (ctx, next) =>
    {
        if (ctx.Request.Path.StartsWithSegments("/hangfire"))
        {
            if (ctx.User.Identity?.IsAuthenticated != true)
            {
                ctx.Response.Redirect("/auth/login?returnUrl=" + Uri.EscapeDataString("/hangfire"));
                return;
            }
            if (!ctx.User.IsInRole(Roles.Admin))
            {
                await WriteProblemAsync(ctx, 403, ErrorCodes.AuthForbidden, "The jobs dashboard is for administrators.");
                return;
            }
        }
        await next(ctx);
    });
    DashboardCustomization.Register();
    app.MapHangfireDashboard("/hangfire", new DashboardOptions
    {
        Authorization = [new AdminDashboardAuthorizationFilter()],
        DashboardTitle = "Sathi jobs",
        DisplayStorageConnectionString = false,
        AppPath = "/",
        StatsPollingInterval = DashboardCustomization.StatsPollingIntervalMs,
    });

    app.Run();
    return 0;
}
catch (Exception ex) when (ex is not HostAbortedException)
{
    Log.Fatal(ex, "Jobs host failed to start");
    return 1;
}
finally
{
    Log.CloseAndFlush();
}

static void AddServer(IServiceCollection services, string queue, int workers) =>
    services.AddHangfireServer(o =>
    {
        o.ServerName = $"{Environment.MachineName}:{queue}";
        o.Queues = [queue];
        o.WorkerCount = Math.Max(1, workers);
        o.ShutdownTimeout = TimeSpan.FromSeconds(30);
    });

static async Task WriteProblemAsync(HttpContext ctx, int status, string code, string detail)
{
    var traceId = TraceIds.Current();
    ctx.Response.StatusCode = status;
    ctx.Response.ContentType = "application/problem+json";
    await JsonSerializer.SerializeAsync(ctx.Response.Body, new Dictionary<string, object?>
    {
        ["type"] = ErrorCodes.TypeUri(code), ["title"] = ErrorCodes.DefaultTitle(code), ["status"] = status, ["detail"] = detail,
        ["code"] = code, ["traceId"] = traceId, ["referenceId"] = ReferenceId.FromTraceId(traceId),
    });
}

/// <summary>
/// Dashboard look and feel (contract §11.10): live counters/realtime graph poll every 5 s; an embedded stylesheet caps both graphs
/// at ~220 px and an embedded script adds the "Auto-refresh (10 s)" toggle to job list pages. Hangfire 1.8 exposes this through
/// DashboardRoutes.AddStylesheet/AddJavaScript (embedded resources appended to the dashboard's CSS/JS bundles).
/// </summary>
public static class DashboardCustomization
{
    public const int StatsPollingIntervalMs = 5000;
    public const string StylesheetResource = "Sathi.Jobs.Dashboard.sathi-dashboard.css";
    public const string ScriptResource = "Sathi.Jobs.Dashboard.sathi-dashboard.js";
    private static int _registered;

    public static void Register()
    {
        if (Interlocked.Exchange(ref _registered, 1) == 1) return;
        var assembly = typeof(DashboardCustomization).Assembly;
        DashboardRoutes.AddStylesheet(assembly, StylesheetResource);
        DashboardRoutes.AddJavaScript(assembly, ScriptResource);
    }
}

/// <summary>Hangfire dashboard: Admin role only (cookie shared with the API).</summary>
public sealed class AdminDashboardAuthorizationFilter : IDashboardAuthorizationFilter
{
    public bool Authorize(DashboardContext context)
    {
        var user = context.GetHttpContext().User;
        return user.Identity?.IsAuthenticated == true && user.IsInRole(Roles.Admin);
    }
}

/// <summary>Samples the oldest enqueued job per queue every 30 s for sathi_jobs_queue_oldest_age_seconds{queue}.</summary>
public sealed class QueueAgeSampler(JobStorage storage, SathiMetrics metrics, ILogger<QueueAgeSampler> logger) : BackgroundService
{
    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        while (!stoppingToken.IsCancellationRequested)
        {
            try
            {
                var api = storage.GetMonitoringApi();
                var now = DateTime.UtcNow;
                foreach (var queue in JobQueues.All)
                {
                    var oldest = api.EnqueuedJobs(queue, 0, 1).Select(j => j.Value?.EnqueuedAt).FirstOrDefault(d => d is not null);
                    metrics.SetQueueOldestAge(queue, oldest is { } at ? Math.Max(0, (now - DateTime.SpecifyKind(at, DateTimeKind.Utc)).TotalSeconds) : 0);
                }
            }
            catch (Exception ex) when (ex is not OperationCanceledException)
            {
                logger.LogDebug(ex, "Queue age sampling failed");
            }
            try { await Task.Delay(TimeSpan.FromSeconds(30), stoppingToken); } catch (OperationCanceledException) { }
        }
    }
}

/// <summary>Registers recurring jobs and enqueues a one-off SyncLessonIndexJob at start-up.</summary>
public sealed class RecurringJobsRegistrar(IServiceScopeFactory scopes, IRecurringJobManager manager, ILogger<RecurringJobsRegistrar> logger) : IHostedService
{
    public Task StartAsync(CancellationToken cancellationToken)
    {
        RecurringJobs.Register(manager);
        using var scope = scopes.CreateScope();
        var id = scope.ServiceProvider.GetRequiredService<JobScheduler>().EnqueueSyncLessonIndex();
        logger.LogInformation(new EventId(4501, "jobs.startup"), "Recurring jobs registered; start-up lesson sync enqueued as {job_id}", id);
        return Task.CompletedTask;
    }

    public Task StopAsync(CancellationToken cancellationToken) => Task.CompletedTask;
}
