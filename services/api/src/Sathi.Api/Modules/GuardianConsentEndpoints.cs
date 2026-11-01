using FluentValidation;
using Microsoft.AspNetCore.Http.HttpResults;
using Microsoft.AspNetCore.Identity;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Options;
using Sathi.Api.Infrastructure;
using Sathi.Core.Access;
using Sathi.Core.Data;
using Sathi.Core.Domain;
using Sathi.Core.Email;
using Sathi.Core.Errors;
using Sathi.Core.Options;
using Sathi.Core.Security;
using Sathi.Core.Usage;

namespace Sathi.Api.Modules;

public sealed record GuardianDecisionRequest(string Decision);
public sealed record GuardianConsentDto(string LearnerDisplayName, string LearnerEmailMasked, string PolicyVersion, IReadOnlyList<string> DataWeProcess,
    string Status);

public sealed class GuardianDecisionValidator : AbstractValidator<GuardianDecisionRequest>
{
    public GuardianDecisionValidator() =>
        RuleFor(x => x.Decision).Must(d => d is GuardianConsentStatuses.Granted or GuardianConsentStatuses.Declined or GuardianConsentStatuses.Withdrawn)
            .WithMessage("Decision must be granted, declined or withdrawn.");
}

/// <summary>
/// Verifiable guardian consent for under-18 learners (contract §11.4, India DPDP Act 2023 s.9). Anonymous endpoints reached from the
/// emailed link ${APP_BASE_URL}/consent/{token}. Only salted hashes of the guardian's IP address and user agent are stored.
/// </summary>
public static class GuardianConsentEndpoints
{
    private static readonly EventId ConsentEvent = new(2201, "guardian_consent");
    public static readonly TimeSpan RequestLifetime = TimeSpan.FromDays(7);

    /// <summary>What Sathi processes about the learner (shown to the guardian before deciding).</summary>
    public static readonly IReadOnlyList<string> DataWeProcess =
    [
        "Name, email address and date of birth (to run the account and check age)",
        "Your email address (to ask for and record your consent)",
        "Lesson progress, quiz answers and mastery estimates (to personalise practice and revision)",
        "Questions asked to the AI tutor and its answers (to answer them and keep the conversation history)",
        "Notes the learner uploads (to answer questions from them)",
        "Technical logs with pseudonymised identifiers (to keep the service secure and working)",
        "No advertising, no behavioural tracking, no sale of data — learning analytics are used only for tutoring",
    ];

    public static void MapGuardianConsent(this RouteGroupBuilder api)
    {
        var g = api.MapGroup("/guardian-consent").WithTags("Guardian consent").AllowAnonymous();
        g.MapGet("/{token}", GetAsync).WithProblems(404).Doc("GetGuardianConsent", "What the guardian is asked to consent to, and the current status");
        g.MapPost("/{token}", DecideAsync).Validate<GuardianDecisionRequest>().RequireRateLimiting(RateLimiting.AuthPolicy)
            .WithProblems(400, 404, 409, 429)
            .Doc("DecideGuardianConsent", "Grant, decline or withdraw consent (decline/withdraw delete the learner's account)");
    }

    /// <summary>Creates a pending consent request for a new minor; returns the raw token for the email. Caller saves.</summary>
    public static string AddConsentRequest(AppDbContext db, AppUser user, PrivacyOptions privacy)
    {
        var (raw, hash) = SecureTokens.Create();
        var now = DateTime.UtcNow;
        db.GuardianConsents.Add(new GuardianConsent
        {
            UserId = user.Id, GuardianEmailNormalized = user.GuardianEmailNormalized!, TokenHash = hash, PolicyVersion = privacy.ConsentPolicyVersion,
            RequestedAt = now, ExpiresAt = now + RequestLifetime,
        });
        db.Audit(null, AuditActions.GuardianConsentRequested, "user", user.Id, new { policyVersion = privacy.ConsentPolicyVersion });
        return raw;
    }

    /// <summary>New link (and expiry) for the latest undecided request, or a new request. Caller saves.</summary>
    public static async Task<string> RefreshRequestAsync(AppDbContext db, AppUser user, PrivacyOptions privacy, CancellationToken ct)
    {
        var pending = await db.GuardianConsents.Where(c => c.UserId == user.Id && c.Decision == null).OrderByDescending(c => c.RequestedAt).FirstOrDefaultAsync(ct);
        if (pending is null) return AddConsentRequest(db, user, privacy);
        var (raw, hash) = SecureTokens.Create();
        pending.TokenHash = hash;
        pending.RequestedAt = DateTime.UtcNow;
        pending.ExpiresAt = pending.RequestedAt + RequestLifetime;
        pending.PolicyVersion = privacy.ConsentPolicyVersion;
        pending.GuardianEmailNormalized = user.GuardianEmailNormalized!;
        return raw;
    }

    public static string Link(AppUrlOptions app, string rawToken) => $"{app.BaseUrl.TrimEnd('/')}/consent/{rawToken}";

    public static async Task SendRequestAsync(AppDbContext db, AppUser user, string rawToken, IAppEmailSender email, AppUrlOptions app, ILogger logger,
        CancellationToken ct)
    {
        var consent = await db.GuardianConsents.AsNoTracking().Where(c => c.UserId == user.Id && c.Decision == null)
            .OrderByDescending(c => c.RequestedAt).FirstAsync(ct);
        try
        {
            await email.SendAsync(EmailTemplates.GuardianConsentRequest(consent.GuardianEmailNormalized, user.DisplayName,
                EmailAddresses.Mask(user.Email), Link(app, rawToken), consent.ExpiresAt), ct);
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            logger.LogWarning(ConsentEvent, ex, "Guardian consent email could not be sent");
        }
    }

    private static string StatusOf(GuardianConsent c) =>
        c.Decision ?? (c.ExpiresAt <= DateTime.UtcNow ? GuardianConsentStatuses.Expired : GuardianConsentStatuses.Pending);

    private static async Task<GuardianConsentDto> GetAsync(string token, AppDbContext db, CancellationToken ct)
    {
        var hash = SecureTokens.Hash(token);
        var row = await (from c in db.GuardianConsents
                         join u in db.Users on c.UserId equals u.Id
                         where c.TokenHash == hash
                         select new { c, u.DisplayName, u.Email }).AsNoTracking().FirstOrDefaultAsync(ct)
                  ?? throw AppException.NotFound("This consent link is not valid.");
        return new GuardianConsentDto(row.DisplayName, EmailAddresses.Mask(row.Email), row.c.PolicyVersion, DataWeProcess, StatusOf(row.c));
    }

    private static async Task<NoContent> DecideAsync(string token, GuardianDecisionRequest req, HttpContext ctx, AppDbContext db, UserManager<AppUser> users,
        IAppEmailSender email, IOptions<AppUrlOptions> app, UserIdHasher hasher, ILogger<GuardianDecisionRequest> logger, CancellationToken ct)
    {
        var hash = SecureTokens.Hash(token);
        var consent = await db.GuardianConsents.FirstOrDefaultAsync(c => c.TokenHash == hash, ct) ?? throw AppException.NotFound("This consent link is not valid.");
        var user = await users.FindByIdAsync(consent.UserId.ToString()) ?? throw AppException.NotFound("This consent link is not valid.");
        var current = StatusOf(consent);
        var wanted = req.Decision;

        // Idempotent repeats; a granted consent can only be withdrawn; a closed account can't be re-opened from this link.
        if (current == wanted || (current is GuardianConsentStatuses.Declined or GuardianConsentStatuses.Withdrawn && wanted != GuardianConsentStatuses.Granted))
            return TypedResults.NoContent();
        if (current is GuardianConsentStatuses.Declined or GuardianConsentStatuses.Withdrawn)
            throw AppException.Conflict("This account was closed after consent was declined. The learner can register again.");
        if (current == GuardianConsentStatuses.Expired && wanted == GuardianConsentStatuses.Granted)
            throw new AppException(400, ErrorCodes.AuthInvalidToken, "This consent link has expired. The learner can send you a new one from the sign-in page.");
        if (current == GuardianConsentStatuses.Granted) wanted = GuardianConsentStatuses.Withdrawn; // "declined" after granting = withdrawal
        else if (wanted == GuardianConsentStatuses.Withdrawn) wanted = GuardianConsentStatuses.Declined; // nothing to withdraw yet

        var now = DateTime.UtcNow;
        consent.Decision = wanted;
        consent.DecidedAt = now;
        var ip = ctx.Connection.RemoteIpAddress?.ToString();
        var agent = ctx.Request.Headers.UserAgent.ToString();
        consent.IpHash = string.IsNullOrEmpty(ip) ? null : hasher.Hash("consent-ip:" + ip);
        consent.UserAgentHash = string.IsNullOrEmpty(agent) ? null : hasher.Hash("consent-ua:" + agent);
        user.GuardianConsentStatus = wanted;
        user.GuardianConsentAt = now;
        var action = wanted switch
        {
            GuardianConsentStatuses.Granted => AuditActions.GuardianConsentGranted,
            GuardianConsentStatuses.Withdrawn => AuditActions.GuardianConsentWithdrawn,
            _ => AuditActions.GuardianConsentDeclined,
        };
        db.Audit(null, action, "user", user.Id, new { consentId = consent.Id, consent.PolicyVersion, ipHash = consent.IpHash, userAgentHash = consent.UserAgentHash });

        if (wanted == GuardianConsentStatuses.Granted)
        {
            await users.UpdateAsync(user);
            await db.SaveChangesAsync(ct);
            try
            {
                await email.SendAsync(EmailTemplates.GuardianConsentGranted(consent.GuardianEmailNormalized, user.DisplayName, Link(app.Value, token)), ct);
            }
            catch (Exception ex) when (ex is not OperationCanceledException)
            {
                logger.LogWarning(ConsentEvent, ex, "Consent confirmation email could not be sent");
            }
        }
        else
        {
            await IdentityEndpoints.SoftDeleteAccountAsync(db, users, user, null, "guardian_" + wanted, ct);
        }
        using (Serilog.Context.LogContext.PushProperty("user_id_hash", hasher.Hash(user.Id)))
            logger.LogInformation(ConsentEvent, "Guardian consent {decision} (policy {policy_version})", wanted, consent.PolicyVersion);
        return TypedResults.NoContent();
    }
}
