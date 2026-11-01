using System.Net;
using System.Text.Json;
using Sathi.Api.Tests.Infrastructure;
using Sathi.Core.Security;

namespace Sathi.Api.Tests.Integration;

[Collection(IntegrationCollection.Name)]
public class LogRedactionTests(IntegrationFixture fx)
{
    private SathiApiFactory F => fx.Factory;

    [Fact]
    public async Task Seeded_secrets_in_request_bodies_never_reach_the_logs()
    {
        var email = $"leaky.person.{Guid.NewGuid():N}@example.com";
        const string password = "Seeded-Secret-Passw0rd-XYZ";
        const string apiKey = "sk-ant-api03-SEEDEDSECRETKEY123456";

        using var client = await TestClient.CreateAsync(F);
        Assert.Equal(HttpStatusCode.Accepted, (await client.PostAsync("/api/v1/auth/register", new { email, password, displayName = "Leaky", dateOfBirth = "1990-01-01" })).StatusCode);
        await client.PostAsync("/api/v1/auth/login", new { email, password, rememberMe = false });
        await client.PostAsync("/api/v1/auth/login", new { email, password = password + "-wrong", rememberMe = false });
        await client.PostAsync("/api/v1/auth/forgot-password", new { email });
        await client.PostAsync("/api/v1/client-errors", new
        {
            kind = "unhandled", message = $"Crash for {email} with key {apiKey}", route = "/tutor", appVersion = "1",
            userAgent = "test", url = $"http://app.test/auth/verify-email?userId=x&token={password}",
        });

        var all = F.Logs.All;
        Assert.NotEmpty(F.Logs.Lines);
        Assert.Contains("\"event\":\"client.error\"", all);
        Assert.Contains("\"source\":\"web\"", all);
        Assert.Contains("\"event\":\"http.request\"", all);
        Assert.DoesNotContain(email, all, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain(password, all);
        Assert.DoesNotContain(apiKey, all);
    }

    [Fact]
    public async Task Request_log_lines_carry_correlation_fields()
    {
        var u = await F.CreateUserAsync();
        using var client = await TestClient.SignedInAsync(F, u.Email, u.Password);
        var requestId = "req-" + Guid.NewGuid().ToString("N");
        var req = new HttpRequestMessage(HttpMethod.Get, "/api/v1/courses");
        req.Headers.Add("X-Request-Id", requestId);
        var resp = await client.SendAsync(req);
        Assert.Equal(requestId, resp.Headers.GetValues("X-Request-Id").Single());
        var traceId = resp.Headers.GetValues("X-Trace-Id").Single();

        var line = F.Logs.Lines.Select(l => JsonDocument.Parse(l).RootElement)
            .Last(l => l.TryGetProperty("request_id", out var r) && r.GetString() == requestId && l.TryGetProperty("event", out var e) && e.GetString() == "http.request");
        Assert.Equal("api", line.GetProperty("service").GetString());
        Assert.Equal("test", line.GetProperty("env").GetString());
        Assert.Equal(traceId, line.GetProperty("trace_id").GetString());
        Assert.Equal(16, line.GetProperty("span_id").GetString()!.Length);
        Assert.Equal(UserIdHash.Compute(SathiApiFactory.HashSalt, u.Id), line.GetProperty("user_id_hash").GetString());
        Assert.Equal("/api/v1/courses", line.GetProperty("route").GetString());
        Assert.Equal(200, line.GetProperty("status_code").GetInt32());
        Assert.True(line.TryGetProperty("duration_ms", out _));
        Assert.DoesNotContain(u.Id.ToString(), F.Logs.All);
    }
}
