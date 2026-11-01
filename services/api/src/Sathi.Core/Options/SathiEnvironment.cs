using Microsoft.Extensions.Configuration;

namespace Sathi.Core.Options;

/// <summary>Process-level identity used in every log line: service, env, version.</summary>
public sealed class SathiEnvironment
{
    public required string Service { get; init; }
    public required string Env { get; init; }
    public required string Version { get; init; }

    public bool IsDevelopment => Env is "development" or "test";

    public static SathiEnvironment From(IConfiguration configuration, string service, string? aspnetEnvironment = null)
    {
        var env = configuration["SATHI_ENV"];
        if (string.IsNullOrWhiteSpace(env))
        {
            env = (aspnetEnvironment ?? "Production").ToLowerInvariant() switch
            {
                "development" => "development",
                "testing" or "test" => "test",
                "staging" => "staging",
                _ => "production",
            };
        }

        var version = configuration["SATHI_VERSION"];
        if (string.IsNullOrWhiteSpace(version))
            version = typeof(SathiEnvironment).Assembly.GetName().Version?.ToString(3) ?? "0.0.0";

        return new SathiEnvironment { Service = service, Env = env.ToLowerInvariant(), Version = version };
    }
}
