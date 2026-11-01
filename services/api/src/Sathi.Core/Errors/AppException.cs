namespace Sathi.Core.Errors;

/// <summary>
/// An expected, user-facing failure. Mapped to ProblemDetails by the API exception handler
/// and NOT logged as an error (it is not a fault).
/// </summary>
public class AppException : Exception
{
    public AppException(int status, string code, string? detail = null, IDictionary<string, string[]>? errors = null)
        : base(detail ?? code)
    {
        Status = status;
        Code = code;
        Detail = detail;
        Errors = errors;
    }

    public int Status { get; }
    public string Code { get; }
    public string? Detail { get; }
    public IDictionary<string, string[]>? Errors { get; }
    public TimeSpan? RetryAfter { get; init; }

    public static AppException NotFound(string? detail = null) =>
        new(404, ErrorCodes.NotFound, detail ?? "We couldn't find that.");

    public static AppException Conflict(string detail) => new(409, ErrorCodes.Conflict, detail);

    public static AppException Validation(string field, string message) =>
        new(400, ErrorCodes.ValidationFailed, "Some fields need attention.",
            new Dictionary<string, string[]> { [field] = [message] });

    public static AppException Forbidden(string? detail = null) =>
        new(403, ErrorCodes.AuthForbidden, detail ?? "You don't have access to this.");
}
