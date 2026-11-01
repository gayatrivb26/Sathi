using System.Security.Claims;
using System.Threading.RateLimiting;
using Microsoft.AspNetCore.RateLimiting;
using Sathi.Core.Errors;
using Sathi.Core.Options;

namespace Sathi.Api.Infrastructure;

/// <summary>Contract §5: global per-user 120/min, auth 10/min per IP, client-errors 30/min per IP.</summary>
public static class RateLimiting
{
    public const string AuthPolicy = "auth";
    public const string ClientErrorsPolicy = "client-errors";

    public static IServiceCollection AddSathiRateLimiting(this IServiceCollection services, IConfiguration configuration)
    {
        var opts = configuration.GetSection(RateLimitOptions.Section).Get<RateLimitOptions>() ?? new RateLimitOptions();
        services.AddRateLimiter(o =>
        {
            o.GlobalLimiter = PartitionedRateLimiter.Create<HttpContext, string>(ctx =>
            {
                if (ctx.Request.Path.StartsWithSegments("/health") || ctx.Request.Path.StartsWithSegments("/api/v1/client-errors"))
                    return RateLimitPartition.GetNoLimiter("exempt");
                var key = ctx.User.FindFirstValue(ClaimTypes.NameIdentifier) is { } uid ? "u:" + uid : "ip:" + Ip(ctx);
                return RateLimitPartition.GetFixedWindowLimiter(key, _ => new FixedWindowRateLimiterOptions
                {
                    PermitLimit = opts.GlobalPerUserPerMinute, Window = TimeSpan.FromMinutes(1), QueueLimit = 0,
                });
            });
            o.AddPolicy(AuthPolicy, ctx => RateLimitPartition.GetFixedWindowLimiter("auth:" + Ip(ctx), _ => new FixedWindowRateLimiterOptions
            {
                PermitLimit = opts.AuthPerIpPerMinute, Window = TimeSpan.FromMinutes(1), QueueLimit = 0,
            }));
            o.AddPolicy(ClientErrorsPolicy, ctx => RateLimitPartition.GetFixedWindowLimiter("ce:" + Ip(ctx), _ => new FixedWindowRateLimiterOptions
            {
                PermitLimit = opts.ClientErrorsPerIpPerMinute, Window = TimeSpan.FromMinutes(1), QueueLimit = 0,
            }));
            o.OnRejected = async (context, ct) =>
            {
                TimeSpan? retry = context.Lease.TryGetMetadata(MetadataName.RetryAfter, out var ra) ? ra : TimeSpan.FromSeconds(60);
                await Problems.WriteAsync(context.HttpContext, 429, ErrorCodes.RateLimited,
                    "You're doing that too often. Please wait a moment and try again.", retryAfter: retry);
            };
        });
        return services;
    }

    private static string Ip(HttpContext ctx) => ctx.Connection.RemoteIpAddress?.ToString() ?? "unknown";
}
