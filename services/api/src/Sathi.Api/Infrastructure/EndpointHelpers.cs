using System.Security.Claims;
using System.Text;
using FluentValidation;
using Microsoft.AspNetCore.WebUtilities;
using Sathi.Core.Errors;

namespace Sathi.Api.Infrastructure;

public static class UserExtensions
{
    public static Guid GetUserId(this ClaimsPrincipal user) =>
        Guid.TryParse(user.FindFirstValue(ClaimTypes.NameIdentifier), out var id)
            ? id
            : throw new AppException(401, ErrorCodes.AuthUnauthenticated, "Please sign in.");

    public static bool IsStaff(this ClaimsPrincipal user) =>
        user.IsInRole(Core.Domain.Roles.Instructor) || user.IsInRole(Core.Domain.Roles.Admin);
}

/// <summary>Runs the FluentValidation validator for T and fails with VALIDATION_FAILED (errors keyed by camelCase field).</summary>
public sealed class ValidationFilter<T> : IEndpointFilter where T : class
{
    public async ValueTask<object?> InvokeAsync(EndpointFilterInvocationContext context, EndpointFilterDelegate next)
    {
        var arg = context.Arguments.OfType<T>().FirstOrDefault();
        var validator = context.HttpContext.RequestServices.GetService<IValidator<T>>();
        if (validator is not null)
        {
            if (arg is null) throw AppException.Validation("body", "The request body is required.");
            var result = await validator.ValidateAsync(arg, context.HttpContext.RequestAborted);
            if (!result.IsValid)
            {
                var errors = result.Errors
                    .GroupBy(e => CamelCase(e.PropertyName))
                    .ToDictionary(g => g.Key, g => g.Select(e => e.ErrorMessage).Distinct().ToArray());
                throw new AppException(400, ErrorCodes.ValidationFailed, "Some fields need attention.", errors);
            }
        }
        return await next(context);
    }

    private static string CamelCase(string s)
    {
        if (string.IsNullOrEmpty(s)) return "body";
        return string.Join('.', s.Split('.').Select(p => p.Length == 0 ? p : char.ToLowerInvariant(p[0]) + p[1..]));
    }
}

public static class ValidationExtensions
{
    public static RouteHandlerBuilder Validate<T>(this RouteHandlerBuilder builder) where T : class =>
        builder.AddEndpointFilter<ValidationFilter<T>>();
}

/// <summary>Opaque cursors: base64url of a timestamp (ticks).</summary>
public static class Cursor
{
    public static string Encode(DateTime value) => WebEncoders.Base64UrlEncode(Encoding.UTF8.GetBytes(value.Ticks.ToString()));

    public static DateTime? Decode(string? cursor)
    {
        if (string.IsNullOrWhiteSpace(cursor)) return null;
        try
        {
            var s = Encoding.UTF8.GetString(WebEncoders.Base64UrlDecode(cursor));
            return long.TryParse(s, out var ticks) ? new DateTime(ticks, DateTimeKind.Utc) : throw AppException.Validation("cursor", "Invalid cursor.");
        }
        catch (FormatException)
        {
            throw AppException.Validation("cursor", "Invalid cursor.");
        }
    }

    public static int Limit(int? limit) => Math.Clamp(limit ?? 20, 1, 100);

    /// <summary>Keyset cursor (timestamp + id tie-breaker) so rows sharing a timestamp are never skipped or repeated.</summary>
    public static string EncodeKeyset(DateTime value, Guid id) =>
        WebEncoders.Base64UrlEncode(Encoding.UTF8.GetBytes($"{value.Ticks}:{id:N}"));

    /// <summary>Decodes <see cref="EncodeKeyset"/> (or a plain timestamp cursor, id = null).</summary>
    public static (DateTime At, Guid? Id)? DecodeKeyset(string? cursor)
    {
        if (string.IsNullOrWhiteSpace(cursor)) return null;
        try
        {
            var parts = Encoding.UTF8.GetString(WebEncoders.Base64UrlDecode(cursor)).Split(':');
            if (parts.Length is 1 or 2 && long.TryParse(parts[0], out var ticks) && ticks >= 0 && ticks <= DateTime.MaxValue.Ticks)
            {
                if (parts.Length == 1) return (new DateTime(ticks, DateTimeKind.Utc), null);
                if (Guid.TryParseExact(parts[1], "N", out var id)) return (new DateTime(ticks, DateTimeKind.Utc), id);
            }
        }
        catch (FormatException) { }
        throw AppException.Validation("cursor", "Invalid cursor.");
    }
}

public sealed record Page<T>(IReadOnlyList<T> Items, string? NextCursor);
