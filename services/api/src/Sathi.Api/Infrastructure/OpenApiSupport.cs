using System.Security.Claims;
using Microsoft.AspNetCore.Http.Metadata;
using Sathi.Core.Access;
using Sathi.Core.Domain;

namespace Sathi.Api.Infrastructure;

/// <summary>RFC 9457 problem body as written by <see cref="Problems"/> (contract §4.1). Used for OpenAPI only.</summary>
public sealed record ProblemResponse(
    string Type, string Title, int Status, string Detail, string Code, string TraceId, string ReferenceId,
    IDictionary<string, string[]>? Errors);

/// <summary>A simple { message } body (202 responses of the auth endpoints).</summary>
public sealed record MessageResponse(string Message);

public static class OpenApiConventions
{
    private static readonly string[] ProblemContentTypes = [Problems.ContentType];

    /// <summary>Declares ProblemDetails responses (application/problem+json) for the given status codes.</summary>
    public static TBuilder WithProblems<TBuilder>(this TBuilder builder, params int[] statusCodes) where TBuilder : IEndpointConventionBuilder
    {
        foreach (var status in statusCodes)
            builder.WithMetadata(new ProducesResponseTypeMetadata(status, typeof(ProblemResponse), ProblemContentTypes));
        return builder;
    }

    /// <summary>Name (operationId), summary and tag in one call.</summary>
    public static RouteHandlerBuilder Doc(this RouteHandlerBuilder builder, string name, string summary) =>
        builder.WithName(name).WithSummary(summary);
}

public static class ViewerExtensions
{
    /// <summary>The signed-in user as a course-access viewer (roles from the security-stamp validated cookie).</summary>
    public static CourseViewer Viewer(this ClaimsPrincipal user) =>
        new(user.GetUserId(), user.IsInRole(Roles.Admin), user.IsInRole(Roles.Instructor));
}

/// <summary>
/// Build-time OpenAPI generation (Microsoft.Extensions.ApiDescription.Server, contract §11.9) runs Program in the
/// GetDocument.Insider process without any configuration. The host is only built (never started), so placeholder values
/// are enough for the services resolved during Build(); they are never used for real traffic.
/// </summary>
public static class BuildTimeOpenApi
{
    public static bool IsGenerating => System.Reflection.Assembly.GetEntryAssembly()?.GetName().Name == "GetDocument.Insider";

    public static Dictionary<string, string?> PlaceholderSettings() => new()
    {
        ["SATHI_ENV"] = "production",
        ["SATHI_VERSION"] = "openapi",
        ["Serilog:DisableConsole"] = "true",
        ["ConnectionStrings:App"] = "Host=localhost;Database=openapi;Username=openapi;Password=openapi",
        ["ConnectionStrings:Hangfire"] = "Host=localhost;Database=openapi;Username=openapi;Password=openapi",
        ["Ai:BaseUrl"] = "http://localhost:8000",
        ["Ai:IngestBaseUrl"] = "http://localhost:8000",
        ["Storage:Endpoint"] = "http://localhost:9000",
        ["Storage:AccessKey"] = "openapi",
        ["Storage:SecretKey"] = "openapi",
        ["Email:Host"] = "localhost",
        ["App:BaseUrl"] = "http://localhost",
        ["Logging:HashSalt"] = "openapi",
        ["ServiceToken:KeyId"] = "openapi",
        // Throw-away key generated per run: options are validated when the generator starts the (server-less) host.
        ["ServiceToken:PrivateKeyPem"] = Convert.ToBase64String(System.Text.Encoding.UTF8.GetBytes(
            System.Security.Cryptography.RSA.Create(2048).ExportPkcs8PrivateKeyPem())),
    };
}
