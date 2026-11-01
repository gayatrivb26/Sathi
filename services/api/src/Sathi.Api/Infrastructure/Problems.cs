using System.Text.Json;
using Microsoft.AspNetCore.Antiforgery;
using Microsoft.AspNetCore.Diagnostics;
using Microsoft.EntityFrameworkCore;
using Npgsql;
using Sathi.Core.Errors;
using Sathi.Core.Security;

namespace Sathi.Api.Infrastructure;

/// <summary>RFC 9457 ProblemDetails with code, traceId, referenceId (contract §4.1).</summary>
public static class Problems
{
    public const string ContentType = "application/problem+json";

    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web);

    public static Dictionary<string, object?> Build(int status, string code, string? detail, IDictionary<string, string[]>? errors = null,
        string? title = null)
    {
        var traceId = TraceIds.Current();
        var body = new Dictionary<string, object?>
        {
            ["type"] = ErrorCodes.TypeUri(code),
            ["title"] = title ?? ErrorCodes.DefaultTitle(code),
            ["status"] = status,
            ["detail"] = detail ?? ErrorCodes.DefaultTitle(code) + ".",
            ["code"] = code,
            ["traceId"] = traceId,
            ["referenceId"] = ReferenceId.FromTraceId(traceId),
        };
        if (errors is { Count: > 0 }) body["errors"] = errors;
        return body;
    }

    public static IResult Result(int status, string code, string? detail = null, IDictionary<string, string[]>? errors = null) =>
        Results.Json(Build(status, code, detail, errors), Json, ContentType, status);

    public static async Task WriteAsync(HttpContext ctx, int status, string code, string? detail = null,
        IDictionary<string, string[]>? errors = null, TimeSpan? retryAfter = null)
    {
        if (ctx.Response.HasStarted) return;
        ctx.Response.StatusCode = status;
        ctx.Response.ContentType = ContentType;
        if (retryAfter is { } ra) ctx.Response.Headers.RetryAfter = ((int)Math.Ceiling(ra.TotalSeconds)).ToString();
        await JsonSerializer.SerializeAsync(ctx.Response.Body, Build(status, code, detail, errors), Json, ctx.RequestAborted);
    }

    public static string CodeForStatus(int status) => status switch
    {
        400 => ErrorCodes.ValidationFailed,
        401 => ErrorCodes.AuthUnauthenticated,
        403 => ErrorCodes.AuthForbidden,
        404 => ErrorCodes.NotFound,
        405 => ErrorCodes.NotFound,
        409 => ErrorCodes.Conflict,
        413 => ErrorCodes.UploadTooLarge,
        415 => ErrorCodes.UploadInvalidType,
        429 => ErrorCodes.RateLimited,
        503 => ErrorCodes.AiServiceUnavailable,
        _ => ErrorCodes.InternalError,
    };
}

/// <summary>Global exception handler: expected AppExceptions become ProblemDetails; anything else is logged once at Error → INTERNAL_ERROR.</summary>
public sealed class SathiExceptionHandler(ILogger<SathiExceptionHandler> logger) : IExceptionHandler
{
    private static readonly EventId Unhandled = new(1001, "http.unhandled");

    public async ValueTask<bool> TryHandleAsync(HttpContext ctx, Exception exception, CancellationToken ct)
    {
        switch (exception)
        {
            case AppException app:
                logger.LogDebug("Request failed with {error_code}", app.Code);
                await Problems.WriteAsync(ctx, app.Status, app.Code, app.Detail, app.Errors, app.RetryAfter);
                return true;

            case AntiforgeryValidationException:
                await Problems.WriteAsync(ctx, 400, ErrorCodes.CsrfInvalid, "The security token is missing or invalid. Refresh the page and try again.");
                return true;

            case BadHttpRequestException bad:
                logger.LogDebug("Bad request: {reason}", bad.Message);
                await Problems.WriteAsync(ctx, bad.StatusCode == 413 ? 413 : 400,
                    bad.StatusCode == 413 ? ErrorCodes.UploadTooLarge : ErrorCodes.ValidationFailed,
                    bad.StatusCode == 413 ? "The request is too large." : "The request body is missing or invalid.");
                return true;

            case JsonException:
                await Problems.WriteAsync(ctx, 400, ErrorCodes.ValidationFailed, "The request body is not valid JSON.");
                return true;

            case OperationCanceledException when ctx.RequestAborted.IsCancellationRequested:
                logger.LogDebug("Request aborted by the client");
                return true;

            case DbUpdateException { InnerException: PostgresException { SqlState: PostgresErrorCodes.UniqueViolation } }:
                await Problems.WriteAsync(ctx, 409, ErrorCodes.Conflict, "This was already done.");
                return true;

            default:
                logger.LogError(Unhandled, exception, "Unhandled exception for {method} {path}", ctx.Request.Method, ctx.Request.Path.Value);
                await Problems.WriteAsync(ctx, 500, ErrorCodes.InternalError, "Something went wrong on our side. Quote the reference ID if you contact support.");
                return true;
        }
    }
}
