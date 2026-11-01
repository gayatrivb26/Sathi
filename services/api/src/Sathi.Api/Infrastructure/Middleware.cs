using System.Diagnostics;
using System.Text.RegularExpressions;
using Microsoft.AspNetCore.Antiforgery;
using Serilog.Context;
using Sathi.Core.Ai;
using Sathi.Core.Errors;
using Sathi.Core.Security;

namespace Sathi.Api.Infrastructure;

/// <summary>X-Request-Id (echo or create), X-Trace-Id, request_id in the log context and on outgoing AI calls.</summary>
public sealed partial class CorrelationMiddleware(RequestDelegate next)
{
    public const string RequestIdHeader = "X-Request-Id";
    public const string TraceIdHeader = "X-Trace-Id";
    public const string ItemKey = "sathi.request_id";

    [GeneratedRegex("^[A-Za-z0-9._:\\-]{1,128}$")]
    private static partial Regex SafeId();

    public async Task InvokeAsync(HttpContext ctx)
    {
        var incoming = ctx.Request.Headers[RequestIdHeader].ToString();
        var requestId = SafeId().IsMatch(incoming) ? incoming : Guid.NewGuid().ToString("N");
        ctx.Items[ItemKey] = requestId;
        RequestCorrelation.RequestId = requestId;
        var traceId = TraceIds.Current();

        ctx.Response.OnStarting(() =>
        {
            ctx.Response.Headers[RequestIdHeader] = requestId;
            ctx.Response.Headers[TraceIdHeader] = traceId;
            return Task.CompletedTask;
        });

        using (LogContext.PushProperty("request_id", requestId))
        {
            await next(ctx);
        }
    }

    public static string Get(HttpContext ctx) => ctx.Items[ItemKey] as string ?? ctx.TraceIdentifier;
}

/// <summary>One log line per request (event http.request): method, route template, status, duration_ms.</summary>
public sealed class RequestLoggingMiddleware(RequestDelegate next, ILogger<RequestLoggingMiddleware> logger)
{
    private static readonly EventId HttpRequest = new(1000, "http.request");

    /// <summary>HttpContext.Items key holding the matched route template, captured right after routing
    /// because the exception handler clears the endpoint before this middleware's finally block runs.</summary>
    public const string RouteItemKey = "sathi.route";

    public async Task InvokeAsync(HttpContext ctx)
    {
        var sw = Stopwatch.StartNew();
        try
        {
            await next(ctx);
        }
        finally
        {
            sw.Stop();
            var route = (ctx.GetEndpoint() as RouteEndpoint)?.RoutePattern.RawText
                ?? ctx.Items[RouteItemKey] as string ?? "unmatched";
            var status = ctx.Response.StatusCode;
            var level = ctx.Request.Path.StartsWithSegments("/health") ? LogLevel.Debug
                : status >= 500 ? LogLevel.Warning
                : LogLevel.Information;
            logger.Log(level, HttpRequest, "{method} {route} responded {status_code} in {duration_ms} ms",
                ctx.Request.Method, route, status, (int)sw.Elapsed.TotalMilliseconds);
        }
    }
}

/// <summary>
/// Antiforgery for every non-GET API request (cookie XSRF-TOKEN, header X-XSRF-TOKEN) except /api/v1/client-errors.
/// Fails with 400 CSRF_INVALID.
/// </summary>
public sealed class CsrfMiddleware(RequestDelegate next, IAntiforgery antiforgery)
{
    public async Task InvokeAsync(HttpContext ctx)
    {
        var path = ctx.Request.Path;
        var method = ctx.Request.Method;
        var safe = HttpMethods.IsGet(method) || HttpMethods.IsHead(method) || HttpMethods.IsOptions(method) || HttpMethods.IsTrace(method);
        if (!safe && path.StartsWithSegments("/api") && !path.StartsWithSegments("/api/v1/client-errors"))
        {
            try
            {
                await antiforgery.ValidateRequestAsync(ctx);
            }
            catch (AntiforgeryValidationException)
            {
                await Problems.WriteAsync(ctx, 400, ErrorCodes.CsrfInvalid, "The security token is missing or invalid. Refresh the page and try again.");
                return;
            }
        }
        await next(ctx);
    }
}

public static class CsrfCookie
{
    public const string CookieName = "XSRF-TOKEN";
    public const string HeaderName = "X-XSRF-TOKEN";

    /// <summary>(Re)issues the JS-readable XSRF-TOKEN cookie for the principal currently on the context.</summary>
    public static void Issue(HttpContext ctx, IAntiforgery antiforgery, bool secure)
    {
        var tokens = antiforgery.GetAndStoreTokens(ctx);
        ctx.Response.Cookies.Append(CookieName, tokens.RequestToken ?? "", new CookieOptions
        {
            HttpOnly = false,
            Secure = secure,
            SameSite = SameSiteMode.Strict,
            Path = "/",
            IsEssential = true,
        });
    }
}
