using System.Net;
using System.Text.Json;
using System.Web;
using Sathi.Api.Tests.Infrastructure;

namespace Sathi.Api.Tests.Integration;

[Collection(IntegrationCollection.Name)]
public class AuthTests(IntegrationFixture fx)
{
    private SathiApiFactory F => fx.Factory;

    private static void AssertProblem(JsonElement body, int status, string code)
    {
        Assert.Equal(status, body.GetProperty("status").GetInt32());
        Assert.Equal(code, body.GetProperty("code").GetString());
        var traceId = body.GetProperty("traceId").GetString()!;
        Assert.Equal(32, traceId.Length);
        Assert.Matches("^[0-9A-F]{4}-[0-9A-F]{4}$", body.GetProperty("referenceId").GetString()!);
        Assert.Equal(traceId[..4].ToUpperInvariant(), body.GetProperty("referenceId").GetString()![..4]);
        Assert.StartsWith("https://sathi.app/errors/", body.GetProperty("type").GetString());
    }

    [Fact]
    public async Task Register_verify_login_flow_with_csrf()
    {
        var email = $"flow-{Guid.NewGuid():N}@example.com";
        const string password = "Learning-is-fun-7";

        // Without the CSRF header a mutation is rejected.
        using (var noCsrf = await TestClient.CreateAsync(F, withCsrf: false))
        {
            var r = await noCsrf.PostAsync("/api/v1/auth/register", new { email, password, displayName = "Flow", dateOfBirth = "1990-01-01" });
            Assert.Equal(HttpStatusCode.BadRequest, r.StatusCode);
            Assert.Equal("application/problem+json", r.Content.Headers.ContentType?.MediaType);
            AssertProblem(await TestClient.ReadJsonAsync(r), 400, "CSRF_INVALID");
        }

        using var client = await TestClient.CreateAsync(F);
        var reg = await client.PostAsync("/api/v1/auth/register", new { email, password, displayName = "Flow Tester", dateOfBirth = "1990-01-01" });
        Assert.Equal(HttpStatusCode.Accepted, reg.StatusCode);
        Assert.True(reg.Headers.Contains("X-Request-Id"));
        Assert.True(reg.Headers.Contains("X-Trace-Id"));

        // Duplicate email.
        var dup = await client.PostAsync("/api/v1/auth/register", new { email, password, displayName = "Again", dateOfBirth = "1990-01-01" });
        AssertProblem(await TestClient.ReadJsonAsync(dup), 409, "AUTH_EMAIL_TAKEN");

        // Not verified yet.
        var early = await client.PostAsync("/api/v1/auth/login", new { email, password, rememberMe = false });
        AssertProblem(await TestClient.ReadJsonAsync(early), 403, "AUTH_EMAIL_NOT_CONFIRMED");

        // Verify via the emailed link.
        var mail = F.Email.LastTo(email);
        var link = mail.TextBody.Split('\n').First(l => l.Contains("/auth/verify-email?"));
        Assert.StartsWith("http://app.test/auth/verify-email?", link.Trim());
        var query = HttpUtility.ParseQueryString(new Uri(link.Trim()).Query);
        var verify = await client.PostAsync("/api/v1/auth/verify-email", new { userId = query["userId"], token = query["token"] });
        Assert.Equal(HttpStatusCode.NoContent, verify.StatusCode);

        var bad = await client.PostAsync("/api/v1/auth/login", new { email, password = "Wrong-password-1", rememberMe = false });
        AssertProblem(await TestClient.ReadJsonAsync(bad), 401, "AUTH_INVALID_CREDENTIALS");

        var login = await client.PostAsync("/api/v1/auth/login", new { email, password, rememberMe = true });
        Assert.Equal(HttpStatusCode.OK, login.StatusCode);
        Assert.Contains(login.Headers.GetValues("Set-Cookie"), c => c.StartsWith("sathi.auth=", StringComparison.Ordinal) && c.Contains("httponly"));
        var me = await TestClient.ReadJsonAsync(login);
        Assert.Equal(email, me.GetProperty("email").GetString());
        Assert.Equal("Student", me.GetProperty("roles")[0].GetString());
        Assert.True(me.GetProperty("emailConfirmed").GetBoolean());
        Assert.False(me.GetProperty("onboardingCompleted").GetBoolean());
        Assert.Equal("Asia/Kolkata", me.GetProperty("preferences").GetProperty("timezone").GetString());

        Assert.Equal(HttpStatusCode.OK, (await client.GetAsync("/api/v1/auth/me")).StatusCode);

        // Mutation with the post-login CSRF token works.
        var prefs = await client.PutAsync("/api/v1/me/preferences", new { level = "advanced", reminderHour = 7 });
        Assert.Equal(HttpStatusCode.OK, prefs.StatusCode);
        Assert.Equal("advanced", (await TestClient.ReadJsonAsync(prefs)).GetProperty("preferences").GetProperty("level").GetString());

        Assert.Equal(HttpStatusCode.NoContent, (await client.PostAsync("/api/v1/auth/logout")).StatusCode);
        var after = await client.GetAsync("/api/v1/auth/me");
        AssertProblem(await TestClient.ReadJsonAsync(after), 401, "AUTH_UNAUTHENTICATED");
    }

    [Fact]
    public async Task Unauthenticated_api_calls_get_401_problem_not_redirect()
    {
        using var client = await TestClient.CreateAsync(F);
        var r = await client.GetAsync("/api/v1/courses");
        Assert.Equal(HttpStatusCode.Unauthorized, r.StatusCode);
        AssertProblem(await TestClient.ReadJsonAsync(r), 401, "AUTH_UNAUTHENTICATED");
    }

    [Fact]
    public async Task Validation_errors_are_keyed_by_field()
    {
        using var client = await TestClient.CreateAsync(F);
        var r = await client.PostAsync("/api/v1/auth/register", new { email = "not-an-email", password = "short", displayName = "" });
        var body = await TestClient.ReadJsonAsync(r);
        AssertProblem(body, 400, "VALIDATION_FAILED");
        var errors = body.GetProperty("errors");
        Assert.True(errors.TryGetProperty("email", out _));
        Assert.True(errors.TryGetProperty("password", out _));
        Assert.True(errors.TryGetProperty("displayName", out _));
        Assert.True(errors.TryGetProperty("dateOfBirth", out _));
    }

    [Fact]
    public async Task Five_failures_lock_the_account()
    {
        var (_, email, password) = await F.CreateUserAsync();
        using var client = await TestClient.CreateAsync(F);
        for (var i = 0; i < 4; i++)
            Assert.Equal(HttpStatusCode.Unauthorized, (await client.PostAsync("/api/v1/auth/login", new { email, password = "Nope-nope-123", rememberMe = false })).StatusCode);
        var fifth = await client.PostAsync("/api/v1/auth/login", new { email, password = "Nope-nope-123", rememberMe = false });
        AssertProblem(await TestClient.ReadJsonAsync(fifth), 423, "AUTH_LOCKED_OUT");
        var correct = await client.PostAsync("/api/v1/auth/login", new { email, password, rememberMe = false });
        AssertProblem(await TestClient.ReadJsonAsync(correct), 423, "AUTH_LOCKED_OUT");
    }

    [Fact]
    public async Task Forgot_and_reset_password()
    {
        var (_, email, _) = await F.CreateUserAsync();
        using var client = await TestClient.CreateAsync(F);
        Assert.Equal(HttpStatusCode.Accepted, (await client.PostAsync("/api/v1/auth/forgot-password", new { email })).StatusCode);
        Assert.Equal(HttpStatusCode.Accepted, (await client.PostAsync("/api/v1/auth/forgot-password", new { email = "nobody-" + email })).StatusCode);
        var link = F.Email.LastTo(email).TextBody.Split('\n').First(l => l.Contains("/auth/reset-password?")).Trim();
        var token = HttpUtility.ParseQueryString(new Uri(link).Query)["token"];
        var reset = await client.PostAsync("/api/v1/auth/reset-password", new { email, token, newPassword = "Brand-new-pass-9" });
        Assert.Equal(HttpStatusCode.NoContent, reset.StatusCode);
        var again = await client.PostAsync("/api/v1/auth/reset-password", new { email, token = "bogus", newPassword = "Brand-new-pass-9" });
        AssertProblem(await TestClient.ReadJsonAsync(again), 400, "AUTH_INVALID_TOKEN");
        Assert.Equal(HttpStatusCode.OK, (await client.PostAsync("/api/v1/auth/login", new { email, password = "Brand-new-pass-9", rememberMe = false })).StatusCode);
    }

    [Fact]
    public async Task Client_errors_need_no_csrf_and_no_auth()
    {
        using var client = await TestClient.CreateAsync(F, withCsrf: false);
        var r = await client.PostAsync("/api/v1/client-errors", new { kind = "http", message = "GET /api/v1/home failed", route = "/home", appVersion = "1.0", userAgent = "test", status = 500 });
        Assert.Equal(HttpStatusCode.NoContent, r.StatusCode);
    }

    [Fact]
    public async Task Health_endpoints_respond()
    {
        using var client = await TestClient.CreateAsync(F, withCsrf: false);
        Assert.Equal(HttpStatusCode.OK, (await client.GetAsync("/health/live")).StatusCode);
        Assert.Equal(HttpStatusCode.OK, (await client.GetAsync("/health/ready")).StatusCode);
    }
}
