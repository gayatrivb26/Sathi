using FluentValidation;
using Hangfire;
using Microsoft.AspNetCore.DataProtection;
using Microsoft.AspNetCore.Diagnostics.HealthChecks;
using Microsoft.AspNetCore.Http.Json;
using Microsoft.AspNetCore.Identity;
using Microsoft.Extensions.Options;
using Sathi.Api.Infrastructure;
using Sathi.Api.Modules;
using Sathi.Api.Modules.Tutor;
using Sathi.Core;
using Sathi.Core.Data;
using Sathi.Core.Domain;
using Sathi.Core.Errors;
using Sathi.Core.Jobs;
using Sathi.Core.Observability;
using Sathi.Core.Options;
using Serilog;

var builder = WebApplication.CreateBuilder(args);
if (BuildTimeOpenApi.IsGenerating) builder.Configuration.AddInMemoryCollection(BuildTimeOpenApi.PlaceholderSettings());
var env =SathiEnvironment.From(builder.Configuration, "api", builder.Environment.EnvironmentName);
Log.Logger = SathiLogging.CreateBootstrapLogger(env);

try
{
    var services = builder.Services;
    var config = builder.Configuration;

    services.AddHttpContextAccessor();
    services.AddSathiSerilog(config, env);
    services.AddSathiTelemetry(config, env);
    services.AddSathiData(config);
    services.AddSathiServices(config, tokenIssuer: "sathi-api");
    services.AddValidatedOptions<RateLimitOptions>(config, RateLimitOptions.Section);
    services.AddScoped<TutorStreamService>();
    services.AddSingleton<ActiveTutorRuns>();
    services.AddValidatorsFromAssemblyContaining<Program>(ServiceLifetime.Singleton);

    // ---- auth: Identity cookie "sathi.auth", ProblemDetails instead of redirects ----
    var secureCookies = !builder.Environment.AllowsInsecureCookies();
    services.AddSathiForwardedHeaders();
    services.AddDataProtection().SetApplicationName("Sathi").PersistKeysToDbContext<AppDbContext>();
    services.AddAuthentication(IdentityConstants.ApplicationScheme).AddIdentityCookies();
    services.AddSathiIdentityCore().AddSignInManager();
    // Contract §11.2: role changes, locks and password resets update the security stamp; sessions pick that up within a minute.
    services.Configure<SecurityStampValidatorOptions>(o => o.ValidationInterval = TimeSpan.FromMinutes(1));
    services.ConfigureApplicationCookie(o =>
    {
        o.Cookie.Name = "sathi.auth";
        o.Cookie.HttpOnly = true;
        o.Cookie.SameSite = SameSiteMode.Lax;
        o.Cookie.SecurePolicy = secureCookies ? CookieSecurePolicy.Always : CookieSecurePolicy.SameAsRequest;
        o.ExpireTimeSpan = TimeSpan.FromDays(14);
        o.SlidingExpiration = true;
        o.Events.OnRedirectToLogin = ctx => Problems.WriteAsync(ctx.HttpContext, 401, ErrorCodes.AuthUnauthenticated, "Please sign in.");
        o.Events.OnRedirectToAccessDenied = ctx => Problems.WriteAsync(ctx.HttpContext, 403, ErrorCodes.AuthForbidden, "You don't have access to this.");
    });
    services.AddAuthorizationBuilder()
        .SetFallbackPolicy(null)
        .AddPolicy("Staff", p => p.RequireRole(Roles.Instructor, Roles.Admin))
        .AddPolicy("Admin", p => p.RequireRole(Roles.Admin));
    services.AddAntiforgery(o =>
    {
        o.HeaderName = CsrfCookie.HeaderName;
        o.Cookie.Name = "sathi.af";
        o.Cookie.HttpOnly = true;
        o.Cookie.SameSite = SameSiteMode.Strict;
        o.Cookie.SecurePolicy = secureCookies ? CookieSecurePolicy.Always : CookieSecurePolicy.SameAsRequest;
        o.SuppressXFrameOptionsHeader = false;
    });

    services.AddSathiRateLimiting(config);
    services.AddExceptionHandler<SathiExceptionHandler>();
    services.AddProblemDetails();
    services.Configure<JsonOptions>(o => o.SerializerOptions.PropertyNamingPolicy = System.Text.Json.JsonNamingPolicy.CamelCase);
    services.Configure<RouteHandlerOptions>(o => o.ThrowOnBadRequest = true);
    services.Configure<Microsoft.AspNetCore.Http.Features.FormOptions>(o =>
        o.MultipartBodyLengthLimit = config.GetValue<long?>("Quotas:MaxUploadBytes") is { } max ? max + 1_048_576 : 27_262_976);
    builder.WebHost.ConfigureKestrel(k => k.Limits.MaxRequestBodySize = 64L * 1024 * 1024);

    // ---- Hangfire client only (same Postgres storage; the server runs in Sathi.Jobs) ----
    services.AddHangfire((sp, cfg) =>
    {
        var cs = sp.GetRequiredService<IOptions<ConnectionStringOptions>>().Value.Hangfire;
        if (string.IsNullOrWhiteSpace(cs)) throw new OptionsValidationException("ConnectionStrings", typeof(ConnectionStringOptions), ["ConnectionStrings:Hangfire is required."]);
        cfg.UseSathiHangfireStorage(cs, prepareSchema: config.GetValue("Hangfire:PrepareSchema", false));
        cfg.UseFilter(new JobObservabilityFilter(sp.GetRequiredService<ILoggerFactory>(), sp.GetRequiredService<SathiMetrics>()));
    });
    services.AddOptions<ConnectionStringOptions>()
        .Validate(o => !string.IsNullOrWhiteSpace(o.Hangfire), "ConnectionStrings:Hangfire is required.").ValidateOnStart();

    services.AddOpenApi("v1", o =>
    {
        o.AddDocumentTransformer((doc, _, _) =>
        {
            doc.Info.Title = "Sathi API";
            doc.Info.Version = "v1";
            doc.Info.Description = "Public API (/api/v1) used by the Sathi web app. Cookie auth (sathi.auth) + antiforgery header X-XSRF-TOKEN on "
                                   + "every non-GET request. Errors are RFC 9457 problem+json with code, traceId and referenceId. Source of truth: "
                                   + "docs/architecture/contracts.md.";
            return Task.CompletedTask;
        });
    });

    services.AddHealthChecks()
        .AddDbContextCheck<AppDbContext>("db", tags: ["ready"])
        .AddCheck<AiServiceHealthCheck>("ai-service", tags: ["ready"]);

    var app = builder.Build();

    app.UseForwardedHeaders();
    app.UseMiddleware<CorrelationMiddleware>();
    app.UseMiddleware<RequestLoggingMiddleware>();
    app.UseExceptionHandler();
    app.UseStatusCodePages(async ctx =>
    {
        var http = ctx.HttpContext;
        if (http.Response.HasStarted || http.Response.ContentLength > 0 || !string.IsNullOrEmpty(http.Response.ContentType)) return;
        var status = http.Response.StatusCode;
        await Problems.WriteAsync(http, status, Problems.CodeForStatus(status), status == 404 ? "We couldn't find that." : null);
    });
    app.UseRouting();
    app.Use((ctx, next) =>
    {
        if (ctx.GetEndpoint() is RouteEndpoint e) ctx.Items[RequestLoggingMiddleware.RouteItemKey] = e.RoutePattern.RawText;
        return next(ctx);
    });
    app.UseAuthentication();
    app.UseRateLimiter();
    app.UseMiddleware<CsrfMiddleware>();
    app.UseAuthorization();

    app.MapHealthChecks("/health/live", new HealthCheckOptions { Predicate = _ => false }).DisableRateLimiting();
    app.MapHealthChecks("/health/ready", new HealthCheckOptions { Predicate = c => c.Tags.Contains("ready") }).DisableRateLimiting();

    if (app.Environment.IsDevelopment()) app.MapOpenApi("/openapi/{documentName}.json").AllowAnonymous().DisableRateLimiting();

    var api = app.MapGroup("/api/v1");
    api.MapIdentity();
    api.MapGuardianConsent();
    api.MapClientErrors();

    var authed = api.MapGroup("").RequireAuthorization();
    authed.MapCourses();
    authed.MapClasses();
    authed.MapTutor();
    authed.MapDocuments();
    authed.MapAssessments();
    authed.MapInstructor();
    authed.MapInstructorClasses();
    authed.MapAdmin();
    authed.MapAdminUsers();

    app.Run();
    return 0;
}
catch (Exception ex) when (ex is not HostAbortedException)
{
    Log.Fatal(ex, "API failed to start");
    return 1;
}
finally
{
    Log.CloseAndFlush();
}

public partial class Program;
