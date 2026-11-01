using System.Net;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.HttpOverrides;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;

namespace Sathi.Core.Observability;

public static class ProxyHeaders
{
    /// <summary>
    /// Trust X-Forwarded-For/Proto from the nginx `web` proxy (Docker private ranges + loopback), so rate limiting sees the client IP
    /// and cookies/redirects see the original scheme.
    /// </summary>
    public static IServiceCollection AddSathiForwardedHeaders(this IServiceCollection services) =>
        services.Configure<ForwardedHeadersOptions>(o =>
        {
            o.ForwardedHeaders = ForwardedHeaders.XForwardedFor | ForwardedHeaders.XForwardedProto;
            o.ForwardLimit = 2;
            o.KnownIPNetworks.Add(System.Net.IPNetwork.Parse("10.0.0.0/8"));
            o.KnownIPNetworks.Add(System.Net.IPNetwork.Parse("172.16.0.0/12"));
            o.KnownIPNetworks.Add(System.Net.IPNetwork.Parse("192.168.0.0/16"));
            o.KnownIPNetworks.Add(System.Net.IPNetwork.Parse("fc00::/7"));
        });

    /// <summary>Development-like environments (http cookies allowed): Development, Test, Testing.</summary>
    public static bool AllowsInsecureCookies(this IHostEnvironment env) =>
        env.IsDevelopment() || env.IsEnvironment("Test") || env.IsEnvironment("Testing");
}
