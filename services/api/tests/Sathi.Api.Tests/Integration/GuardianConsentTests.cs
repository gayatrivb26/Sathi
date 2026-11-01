using System.Net;
using System.Text.Json;
using System.Web;
using Microsoft.EntityFrameworkCore;
using Sathi.Api.Tests.Infrastructure;
using Sathi.Core.Domain;

namespace Sathi.Api.Tests.Integration;

/// <summary>Contract §11.4: under-18 registration, guardian consent (grant / decline / withdraw), sign-in gating.</summary>
[Collection(IntegrationCollection.Name)]
public class GuardianConsentTests(IntegrationFixture fx)
{
    private SathiApiFactory F => fx.Factory;
    private const string Password = "Learning-is-fun-7";

    private static async Task<JsonElement> Json(Task<HttpResponseMessage> call, HttpStatusCode expected)
    {
        var resp = await call;
        var body = await TestClient.ReadJsonAsync(resp);
        Assert.True(resp.StatusCode == expected, $"Expected {(int)expected}, got {(int)resp.StatusCode}: {body}");
        return body;
    }

    private static async Task ExpectProblem(Task<HttpResponseMessage> call, HttpStatusCode status, string code)
    {
        var resp = await call;
        var body = await TestClient.ReadJsonAsync(resp);
        Assert.True(resp.StatusCode == status, $"Expected {(int)status} {code}, got {(int)resp.StatusCode}: {body}");
        Assert.Equal(code, body.GetProperty("code").GetString());
    }

    private static string Dob(int yearsAgo) => DateTime.UtcNow.Date.AddYears(-yearsAgo).AddDays(-10).ToString("yyyy-MM-dd");

    /// <summary>Registers a minor, confirms the learner's email via the emailed link and returns the guardian's consent token.</summary>
    private async Task<(string Email, string Guardian, string Token)> RegisterMinorAsync(TestClient client)
    {
        var email = $"kid-{Guid.NewGuid():N}@example.com";
        var guardian = $"parent-{Guid.NewGuid():N}@example.com";
        Assert.Equal(HttpStatusCode.Accepted, (await client.PostAsync("/api/v1/auth/register",
            new { email, password = Password, displayName = "Young Learner", dateOfBirth = Dob(14), guardianEmail = guardian.ToUpperInvariant() })).StatusCode);

        var verify = F.Email.LastTo(email).TextBody.Split('\n').Select(l => l.Trim()).First(l => l.Contains("/auth/verify-email?"));
        var q = HttpUtility.ParseQueryString(new Uri(verify).Query);
        Assert.Equal(HttpStatusCode.NoContent, (await client.PostAsync("/api/v1/auth/verify-email", new { userId = q["userId"], token = q["token"] })).StatusCode);

        var consentMail = F.Email.LastTo(guardian);
        Assert.Contains("Young Learner", consentMail.TextBody);
        Assert.DoesNotContain(email, consentMail.TextBody); // learner email is masked
        var link = consentMail.TextBody.Split('\n').Select(l => l.Trim()).First(l => l.StartsWith("http://app.test/consent/", StringComparison.Ordinal));
        return (email, guardian, link["http://app.test/consent/".Length..]);
    }

    [Fact]
    public async Task Registration_age_rules()
    {
        using var c = await TestClient.CreateAsync(F);
        var email = $"young-{Guid.NewGuid():N}@example.com";
        await ExpectProblem(c.PostAsync("/api/v1/auth/register", new { email, password = Password, displayName = "Tiny", dateOfBirth = Dob(6) }),
            HttpStatusCode.BadRequest, "AUTH_TOO_YOUNG");
        var noGuardian = await TestClient.ReadJsonAsync(await c.PostAsync("/api/v1/auth/register",
            new { email, password = Password, displayName = "Teen", dateOfBirth = Dob(15) }));
        Assert.Equal("VALIDATION_FAILED", noGuardian.GetProperty("code").GetString());
        Assert.True(noGuardian.GetProperty("errors").TryGetProperty("guardianEmail", out _));
        await ExpectProblem(c.PostAsync("/api/v1/auth/register",
            new { email, password = Password, displayName = "Teen", dateOfBirth = Dob(15), guardianEmail = email.ToUpperInvariant() }),
            HttpStatusCode.BadRequest, "VALIDATION_FAILED");
        await ExpectProblem(c.PostAsync("/api/v1/auth/register",
            new { email, password = Password, displayName = "Teen", dateOfBirth = "15/04/2010", guardianEmail = "p@example.com" }),
            HttpStatusCode.BadRequest, "VALIDATION_FAILED");
        await ExpectProblem(c.PostAsync("/api/v1/auth/register",
            new { email, password = Password, displayName = "Future", dateOfBirth = DateTime.UtcNow.AddDays(3).ToString("yyyy-MM-dd") }),
            HttpStatusCode.BadRequest, "VALIDATION_FAILED");
        Assert.False(await F.WithDbAsync(db => db.Users.AnyAsync(u => u.NormalizedEmail == email.ToUpperInvariant())));

        // An adult needs no guardian and is not a minor.
        Assert.Equal(HttpStatusCode.Accepted, (await c.PostAsync("/api/v1/auth/register",
            new { email, password = Password, displayName = "Adult", dateOfBirth = Dob(18) })).StatusCode);
        var adult = await F.WithDbAsync(db => db.Users.AsNoTracking().SingleAsync(u => u.NormalizedEmail == email.ToUpperInvariant()));
        Assert.Equal((false, GuardianConsentStatuses.NotRequired), (adult.IsMinor, adult.GuardianConsentStatus));
    }

    [Fact]
    public async Task Minor_is_blocked_until_the_guardian_grants_consent_and_can_later_be_withdrawn()
    {
        using var c = await TestClient.CreateAsync(F);
        var (email, guardian, token) = await RegisterMinorAsync(c);
        var user = await F.WithDbAsync(db => db.Users.AsNoTracking().SingleAsync(u => u.NormalizedEmail == email.ToUpperInvariant()));
        Assert.True(user.IsMinor);
        Assert.Equal(GuardianConsentStatuses.Pending, user.GuardianConsentStatus);
        Assert.Equal(guardian, user.GuardianEmailNormalized);

        await ExpectProblem(c.PostAsync("/api/v1/auth/login", new { email, password = Password, rememberMe = false }),
            HttpStatusCode.Forbidden, "AUTH_GUARDIAN_CONSENT_PENDING");

        // Admin sees the account as pending_guardian.
        var admin = await F.CreateUserAsync(Roles.Admin);
        using (var ad = await TestClient.SignedInAsync(F, admin.Email, admin.Password))
        {
            var row = await Json(ad.GetAsync($"/api/v1/admin/users/{user.Id}"), HttpStatusCode.OK);
            Assert.Equal("pending_guardian", row.GetProperty("accountStatus").GetString());
            Assert.True(row.GetProperty("isMinor").GetBoolean());
        }

        // Resend: a new link replaces the old one.
        Assert.Equal(HttpStatusCode.Accepted, (await c.PostAsync("/api/v1/auth/resend-guardian-consent", new { email })).StatusCode);
        var newToken = F.Email.LastTo(guardian).TextBody.Split('\n').Select(l => l.Trim())
            .First(l => l.StartsWith("http://app.test/consent/", StringComparison.Ordinal))["http://app.test/consent/".Length..];
        Assert.NotEqual(token, newToken);
        Assert.Equal(HttpStatusCode.NotFound, (await c.GetAsync($"/api/v1/guardian-consent/{token}")).StatusCode);
        Assert.Equal(HttpStatusCode.Accepted, (await c.PostAsync("/api/v1/auth/resend-guardian-consent", new { email = "nobody@example.com" })).StatusCode);

        using var guardianClient = await TestClient.CreateAsync(F);
        var view = await Json(guardianClient.GetAsync($"/api/v1/guardian-consent/{newToken}"), HttpStatusCode.OK);
        Assert.Equal("pending", view.GetProperty("status").GetString());
        Assert.Equal("Young Learner", view.GetProperty("learnerDisplayName").GetString());
        Assert.Equal("k***@example.com", view.GetProperty("learnerEmailMasked").GetString());
        Assert.Equal("2026-10", view.GetProperty("policyVersion").GetString());
        Assert.True(view.GetProperty("dataWeProcess").GetArrayLength() > 3);

        await ExpectProblem(guardianClient.PostAsync($"/api/v1/guardian-consent/{newToken}", new { decision = "maybe" }), HttpStatusCode.BadRequest, "VALIDATION_FAILED");
        Assert.Equal(HttpStatusCode.NoContent, (await guardianClient.PostAsync($"/api/v1/guardian-consent/{newToken}", new { decision = "granted" })).StatusCode);
        Assert.Equal(HttpStatusCode.NoContent, (await guardianClient.PostAsync($"/api/v1/guardian-consent/{newToken}", new { decision = "granted" })).StatusCode);
        Assert.Contains($"http://app.test/consent/{newToken}", F.Email.LastTo(guardian).TextBody); // confirmation keeps the link for withdrawal

        var consent = await F.WithDbAsync(db => db.GuardianConsents.AsNoTracking().SingleAsync(x => x.UserId == user.Id));
        Assert.Equal(("granted", "2026-10"), (consent.Decision, consent.PolicyVersion));
        Assert.NotNull(consent.DecidedAt);
        Assert.NotEqual(newToken, consent.TokenHash);
        if (consent.UserAgentHash is not null) Assert.Equal(16, consent.UserAgentHash.Length); // salted HMAC, never the raw value

        var login = await Json(c.PostAsync("/api/v1/auth/login", new { email, password = Password, rememberMe = false }), HttpStatusCode.OK);
        Assert.True(login.GetProperty("isMinor").GetBoolean());

        // Withdrawal deletes the account and ends the session.
        Assert.Equal(HttpStatusCode.NoContent, (await guardianClient.PostAsync($"/api/v1/guardian-consent/{newToken}", new { decision = "withdrawn" })).StatusCode);
        var deleted = await F.WithDbAsync(db => db.Users.AsNoTracking().SingleAsync(u => u.Id == user.Id));
        Assert.NotNull(deleted.DeletedAt);
        Assert.Equal(GuardianConsentStatuses.Withdrawn, deleted.GuardianConsentStatus);
        Assert.Equal("withdrawn", (await Json(guardianClient.GetAsync($"/api/v1/guardian-consent/{newToken}"), HttpStatusCode.OK)).GetProperty("status").GetString());
        Assert.Contains(await F.WithDbAsync(db => db.OutboxMessages.AsNoTracking().Where(m => m.Type == OutboxTypes.UserDeleted).Select(m => m.PayloadJson).ToListAsync()),
            p => p.Contains(user.Id.ToString()));
        await ExpectProblem(c.PostAsync("/api/v1/auth/login", new { email, password = Password, rememberMe = false }),
            HttpStatusCode.Forbidden, "AUTH_GUARDIAN_CONSENT_DECLINED");
        await ExpectProblem(guardianClient.PostAsync($"/api/v1/guardian-consent/{newToken}", new { decision = "granted" }), HttpStatusCode.Conflict, "CONFLICT");
    }

    [Fact]
    public async Task Declined_consent_deletes_the_learner()
    {
        using var c = await TestClient.CreateAsync(F);
        var (email, _, token) = await RegisterMinorAsync(c);
        using var guardianClient = await TestClient.CreateAsync(F);
        Assert.Equal(HttpStatusCode.NoContent, (await guardianClient.PostAsync($"/api/v1/guardian-consent/{token}", new { decision = "declined" })).StatusCode);

        var user = await F.WithDbAsync(db => db.Users.AsNoTracking().SingleAsync(u => u.NormalizedEmail == email.ToUpperInvariant()));
        Assert.NotNull(user.DeletedAt);
        Assert.Equal(GuardianConsentStatuses.Declined, user.GuardianConsentStatus);
        Assert.Contains(await F.WithDbAsync(db => db.OutboxMessages.AsNoTracking().Where(m => m.Type == OutboxTypes.UserDeleted).Select(m => m.PayloadJson).ToListAsync()),
            p => p.Contains(user.Id.ToString()));
        Assert.True(await F.WithDbAsync(db => db.AuditEvents.AnyAsync(e => e.Action == AuditActions.GuardianConsentDeclined && e.EntityId == user.Id)));

        await ExpectProblem(c.PostAsync("/api/v1/auth/login", new { email, password = Password, rememberMe = false }),
            HttpStatusCode.Forbidden, "AUTH_GUARDIAN_CONSENT_DECLINED");
        // Wrong password reveals nothing.
        await ExpectProblem(c.PostAsync("/api/v1/auth/login", new { email, password = Password + "x", rememberMe = false }),
            HttpStatusCode.Unauthorized, "AUTH_INVALID_CREDENTIALS");
        Assert.Equal("declined", (await Json(guardianClient.GetAsync($"/api/v1/guardian-consent/{token}"), HttpStatusCode.OK)).GetProperty("status").GetString());
    }
}
