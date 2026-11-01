using Microsoft.Extensions.Diagnostics.HealthChecks;
using Sathi.Core.Ai;

namespace Sathi.Api.Infrastructure;

/// <summary>Ready check: AI service /health/live reachable.</summary>
public sealed class AiServiceHealthCheck(IServiceScopeFactory scopes) : IHealthCheck
{
    public async Task<HealthCheckResult> CheckHealthAsync(HealthCheckContext context, CancellationToken cancellationToken = default)
    {
        await using var scope = scopes.CreateAsyncScope();
        var ai = scope.ServiceProvider.GetRequiredService<AiServiceClient>();
        return await ai.IsHealthyAsync(cancellationToken)
            ? HealthCheckResult.Healthy()
            : HealthCheckResult.Unhealthy("AI service unreachable");
    }
}
