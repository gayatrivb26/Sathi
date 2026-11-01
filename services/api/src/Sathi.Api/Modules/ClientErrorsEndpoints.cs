using Sathi.Api.Infrastructure;
using Serilog.Context;

namespace Sathi.Api.Modules;

public sealed record ClientErrorRequest(string? Kind, string? Message, string? TraceId, string? Route, string? AppVersion, string? UserAgent,
    int? Status, string? Url);

/// <summary>POST /client-errors — anonymous, rate limited (30/min/IP), no CSRF; logged at Warning with source=web (event client.error).</summary>
public static class ClientErrorsEndpoints
{
    private static readonly EventId ClientError = new(1100, "client.error");
    private static readonly HashSet<string> Kinds = ["unhandled", "http", "sse_drop"];

    public static void MapClientErrors(this RouteGroupBuilder api)
    {
        api.MapPost("/client-errors", (ClientErrorRequest? req, ILogger<ClientErrorRequest> logger) =>
            {
                if (req is null) return Problems.Result(400, Core.Errors.ErrorCodes.ValidationFailed, "The request body is required.");
                var kind = req.Kind is not null && Kinds.Contains(req.Kind) ? req.Kind : "unhandled";
                using (LogContext.PushProperty("source", "web"))
                using (LogContext.PushProperty("client_trace_id", Clip(req.TraceId, 64)))
                {
                    logger.LogWarning(ClientError, "Client {kind} error on {route}: {client_message} (status {status}, app {app_version}, url {url}, agent {user_agent})",
                        kind, Clip(req.Route, 200), Clip(req.Message, 300), req.Status, Clip(req.AppVersion, 40), StripQuery(req.Url), Clip(req.UserAgent, 200));
                }
                return Results.NoContent();
            })
            .WithTags("Client errors")
            .Produces(StatusCodes.Status204NoContent)
            .WithProblems(400, 429)
            .Doc("ReportClientError", "Report a browser-side error (anonymous, rate limited, no CSRF)")
            .AllowAnonymous()
            .RequireRateLimiting(RateLimiting.ClientErrorsPolicy)
            .DisableAntiforgery();
    }

    private static string? Clip(string? s, int max) => s is null ? null : s.Length <= max ? s : s[..max];

    /// <summary>Query strings can carry tokens (e.g. verification links), so only the path is logged.</summary>
    private static string? StripQuery(string? url)
    {
        if (string.IsNullOrEmpty(url)) return url;
        var i = url.IndexOfAny(['?', '#']);
        return Clip(i >= 0 ? url[..i] : url, 300);
    }
}
