using System.Globalization;
using System.Security.Claims;
using System.Text;
using FluentValidation;
using Microsoft.AspNetCore.Antiforgery;
using Microsoft.AspNetCore.Http.HttpResults;
using Microsoft.AspNetCore.Identity;
using Microsoft.AspNetCore.WebUtilities;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Options;
using Sathi.Api.Infrastructure;
using Sathi.Core.Access;
using Sathi.Core.Data;
using Sathi.Core.Domain;
using Sathi.Core.Email;
using Sathi.Core.Errors;
using Sathi.Core.Observability;
using Sathi.Core.Options;
using Sathi.Core.Security;
using Sathi.Core.Usage;

namespace Sathi.Api.Modules;

/// <summary>Contract §5.1 + §11.2/§11.4: dateOfBirth (YYYY-MM-DD) is required; guardianEmail for minors; optional staffInviteToken.</summary>
public sealed record RegisterRequest(string Email, string Password, string DisplayName, string? DateOfBirth, string? GuardianEmail, string? StaffInviteToken);
public sealed record VerifyEmailRequest(Guid UserId, string Token);
public sealed record EmailRequest(string Email);
public sealed record LoginRequest(string Email, string Password, bool RememberMe);
public sealed record ResetPasswordRequest(string Email, string Token, string NewPassword);
public sealed record PreferencesRequest(string? Level, string? Timezone, int? ReminderHour, bool? RemindersEnabled, Guid? ActiveCourseId);
public sealed record ProfileRequest(string DisplayName);
public sealed record DeleteMeRequest(string Password);

public sealed record PreferencesDto(string Level, string Timezone, int ReminderHour, bool RemindersEnabled, Guid? ActiveCourseId);
public sealed record MeDto(Guid Id, string Email, string DisplayName, IReadOnlyList<string> Roles, bool EmailConfirmed,
    PreferencesDto Preferences, bool OnboardingCompleted, bool IsMinor);
public sealed record StaffInviteLookupDto(string EmailMasked, string Role, string? CourseTitle, string Status);

public sealed class RegisterValidator : AbstractValidator<RegisterRequest>
{
    public RegisterValidator()
    {
        RuleFor(x => x.Email).NotEmpty().WithMessage("Email is required.").EmailAddress().WithMessage("Enter a valid email address.").MaximumLength(254);
        RuleFor(x => x.Password).NotEmpty().WithMessage("Password is required.")
            .MinimumLength(10).WithMessage("Use at least 10 characters.")
            .Must(p => p is not null && p.Any(char.IsLetter) && p.Any(char.IsDigit)).WithMessage("Use at least one letter and one digit.")
            .MaximumLength(128);
        RuleFor(x => x.DisplayName).NotEmpty().WithMessage("Name is required.").MaximumLength(80);
        RuleFor(x => x.DateOfBirth).NotEmpty().WithMessage("Date of birth is required.");
        RuleFor(x => x.DateOfBirth)
            .Must(d => IdentityEndpoints.ParseDate(d) is { } dob && dob <= DateOnly.FromDateTime(DateTime.UtcNow) && dob.Year >= 1900)
            .WithMessage("Enter your date of birth as YYYY-MM-DD.").When(x => !string.IsNullOrEmpty(x.DateOfBirth));
        RuleFor(x => x.GuardianEmail).EmailAddress().WithMessage("Enter a valid email address.").MaximumLength(254)
            .When(x => !string.IsNullOrWhiteSpace(x.GuardianEmail));
        RuleFor(x => x.StaffInviteToken).MaximumLength(200);
    }
}

public sealed class LoginValidator : AbstractValidator<LoginRequest>
{
    public LoginValidator()
    {
        RuleFor(x => x.Email).NotEmpty().WithMessage("Email is required.");
        RuleFor(x => x.Password).NotEmpty().WithMessage("Password is required.");
    }
}

public sealed class EmailRequestValidator : AbstractValidator<EmailRequest>
{
    public EmailRequestValidator() => RuleFor(x => x.Email).NotEmpty().WithMessage("Email is required.").EmailAddress().WithMessage("Enter a valid email address.");
}

public sealed class VerifyEmailValidator : AbstractValidator<VerifyEmailRequest>
{
    public VerifyEmailValidator()
    {
        RuleFor(x => x.UserId).NotEmpty();
        RuleFor(x => x.Token).NotEmpty();
    }
}

public sealed class ResetPasswordValidator : AbstractValidator<ResetPasswordRequest>
{
    public ResetPasswordValidator()
    {
        RuleFor(x => x.Email).NotEmpty().EmailAddress();
        RuleFor(x => x.Token).NotEmpty();
        RuleFor(x => x.NewPassword).NotEmpty().MinimumLength(10).WithMessage("Use at least 10 characters.")
            .Must(p => p is not null && p.Any(char.IsLetter) && p.Any(char.IsDigit)).WithMessage("Use at least one letter and one digit.");
    }
}

public sealed class PreferencesValidator : AbstractValidator<PreferencesRequest>
{
    public PreferencesValidator()
    {
        RuleFor(x => x.Level).Must(l => l is null || Levels.All.Contains(l)).WithMessage("Level must be beginner, intermediate or advanced.");
        RuleFor(x => x.Timezone).Must(t => t is null || Core.Jobs.TimeZones.IsValid(t)).WithMessage("Unknown time zone.");
        RuleFor(x => x.ReminderHour).InclusiveBetween(0, 23).When(x => x.ReminderHour is not null);
    }
}

public sealed class ProfileValidator : AbstractValidator<ProfileRequest>
{
    public ProfileValidator() =>
        RuleFor(x => x.DisplayName).Must(n => n is not null && n.Trim().Length is >= 1 and <= 60).WithMessage("Use 1–60 characters for your name.");
}

public static class IdentityEndpoints
{
    private static readonly EventId LoginFailed = new(2001, "auth.login_failed");
    private static readonly EventId AuthEvent = new(2002, "auth.event");

    public static void MapIdentity(this RouteGroupBuilder api)
    {
        var auth = api.MapGroup("/auth").WithTags("Auth");

        auth.MapGet("/csrf", (HttpContext ctx, IAntiforgery af, IHostEnvironment env) =>
        {
            CsrfCookie.Issue(ctx, af, Secure(env));
            return TypedResults.NoContent();
        }).AllowAnonymous().Doc("GetCsrfToken", "(Re)issue the XSRF-TOKEN cookie");

        auth.MapPost("/register", RegisterAsync).Validate<RegisterRequest>().AllowAnonymous().RequireRateLimiting(RateLimiting.AuthPolicy)
            .WithProblems(400, 409, 410, 429).Doc("Register", "Create a Student account (dateOfBirth required; guardianEmail for under-18s; optional staffInviteToken)");
        auth.MapPost("/verify-email", VerifyEmailAsync).Validate<VerifyEmailRequest>().AllowAnonymous().RequireRateLimiting(RateLimiting.AuthPolicy)
            .WithProblems(400, 429).Doc("VerifyEmail", "Confirm the email address from the emailed link");
        auth.MapPost("/resend-verification", ResendAsync).Validate<EmailRequest>().AllowAnonymous().RequireRateLimiting(RateLimiting.AuthPolicy)
            .WithProblems(400, 429).Doc("ResendVerification", "Send a new verification link (always 202)");
        auth.MapPost("/resend-guardian-consent", ResendGuardianConsentAsync).Validate<EmailRequest>().AllowAnonymous()
            .RequireRateLimiting(RateLimiting.AuthPolicy).WithProblems(400, 429)
            .Doc("ResendGuardianConsent", "Send the guardian consent email again for a pending under-18 account (always 202)");
        auth.MapPost("/login", LoginAsync).Validate<LoginRequest>().AllowAnonymous().RequireRateLimiting(RateLimiting.AuthPolicy)
            .WithProblems(400, 401, 403, 423, 429).Doc("Login", "Sign in (cookie); under-18s also need guardian consent");
        auth.MapPost("/logout", LogoutAsync).AllowAnonymous().Doc("Logout", "Sign out");
        auth.MapPost("/forgot-password", ForgotAsync).Validate<EmailRequest>().AllowAnonymous().RequireRateLimiting(RateLimiting.AuthPolicy)
            .WithProblems(400, 429).Doc("ForgotPassword", "Email a password reset link (always 202)");
        auth.MapPost("/reset-password", ResetAsync).Validate<ResetPasswordRequest>().AllowAnonymous().RequireRateLimiting(RateLimiting.AuthPolicy)
            .WithProblems(400, 429).Doc("ResetPassword", "Set a new password from the emailed link");
        auth.MapGet("/me", async (HttpContext ctx, UserManager<AppUser> users, AppDbContext db, IOptions<PrivacyOptions> privacy) =>
        {
            var user = await users.FindByIdAsync(ctx.User.GetUserId().ToString());
            if (user is null || user.DeletedAt is not null) throw new AppException(401, ErrorCodes.AuthUnauthenticated, "Please sign in.");
            return await BuildMeAsync(user, users, db);
        }).RequireAuthorization().WithProblems(401).Doc("GetMe", "The signed-in user");

        auth.MapGet("/staff-invites/{token}", StaffInviteLookupAsync).AllowAnonymous().WithProblems(404)
            .Doc("GetStaffInvite", "Public summary of a staff invitation");
        auth.MapPost("/staff-invites/{token}/accept", AcceptStaffInviteAsync).RequireAuthorization().WithProblems(401, 403, 410)
            .Doc("AcceptStaffInvite", "Accept a staff invitation with an existing account (signed in with the invited email)");

        var me = api.MapGroup("/me").RequireAuthorization().WithTags("Me").WithProblems(401);
        me.MapPut("/preferences", UpdatePreferencesAsync).Validate<PreferencesRequest>().WithProblems(400).Doc("UpdatePreferences", "Learning preferences");
        me.MapPut("/profile", UpdateProfileAsync).Validate<ProfileRequest>().WithProblems(400).Doc("UpdateProfile", "Change the display name (1–60 characters)");
        me.MapDelete("", DeleteMeAsync).Accepts<DeleteMeRequest>("application/json").WithProblems(400).Doc("DeleteMe", "Delete my account (password required in the body)");
    }

    private static bool Secure(IHostEnvironment env) => !env.AllowsInsecureCookies();

    public static DateOnly? ParseDate(string? value) =>
        DateOnly.TryParseExact(value?.Trim(), "yyyy-MM-dd", CultureInfo.InvariantCulture, DateTimeStyles.None, out var d) ? d : null;

    public static DateOnly TodayUtc => DateOnly.FromDateTime(DateTime.UtcNow);

    public static async Task<MeDto> BuildMeAsync(AppUser user, UserManager<AppUser> users, AppDbContext db)
    {
        var roles = await users.GetRolesAsync(user);
        var p = await db.UserPreferences.AsNoTracking().FirstOrDefaultAsync(x => x.UserId == user.Id) ?? new UserPreference { UserId = user.Id };
        return new MeDto(user.Id, user.Email ?? "", user.DisplayName, roles.OrderBy(r => r).ToList(), user.EmailConfirmed,
            new PreferencesDto(p.Level, p.Timezone, p.ReminderHour, p.RemindersEnabled, p.ActiveCourseId), p.OnboardingCompletedAt is not null, user.IsMinor);
    }

    private static string Encode(string token) => WebEncoders.Base64UrlEncode(Encoding.UTF8.GetBytes(token));

    private static string? Decode(string token)
    {
        try { return Encoding.UTF8.GetString(WebEncoders.Base64UrlDecode(token)); }
        catch (FormatException) { return null; }
    }

    public static async Task SendVerificationAsync(AppUser user, UserManager<AppUser> users, IAppEmailSender email, AppUrlOptions app,
        ILogger logger, CancellationToken ct)
    {
        var token = Encode(await users.GenerateEmailConfirmationTokenAsync(user));
        var link = $"{app.BaseUrl.TrimEnd('/')}/auth/verify-email?userId={user.Id}&token={Uri.EscapeDataString(token)}";
        try
        {
            await email.SendAsync(EmailTemplates.VerifyEmail(user.Email!, user.DisplayName, link), ct);
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            logger.LogWarning(AuthEvent, ex, "Verification email could not be sent");
        }
    }

    // ---------------- staff invites (shared with admin) ----------------

    public static string StaffInviteStatus(StaffInvite i) =>
        ClassesEndpoints.InviteStatus(i.AcceptedAt, i.RevokedAt, i.ExpiresAt);

    /// <summary>Grants the invited role (plus a course_instructors row when the invite names a course) and marks the invite accepted.
    /// Caller saves and refreshes the security stamp.</summary>
    private static async Task ApplyStaffInviteAsync(StaffInvite invite, AppUser user, UserManager<AppUser> users, AppDbContext db, CancellationToken ct)
    {
        if (!await users.IsInRoleAsync(user, invite.Role)) await users.AddToRoleAsync(user, invite.Role);
        if (invite.CourseId is { } courseId && await db.Courses.AnyAsync(c => c.Id == courseId, ct)
                                           && !await db.CourseInstructors.AnyAsync(ci => ci.CourseId == courseId && ci.UserId == user.Id, ct))
            db.CourseInstructors.Add(new CourseInstructor { CourseId = courseId, UserId = user.Id, Role = CourseInstructorRoles.Instructor, AddedAt = DateTime.UtcNow });
        invite.AcceptedAt = DateTime.UtcNow;
        invite.AcceptedUserId = user.Id;
        db.Audit(user.Id, AuditActions.StaffInviteAccepted, "staff_invite", invite.Id, new { invite.Role, invite.CourseId });
    }

    private static async Task<StaffInvite> UsableStaffInviteAsync(AppDbContext db, string token, CancellationToken ct)
    {
        var hash = SecureTokens.Hash(token);
        var invite = await db.StaffInvites.FirstOrDefaultAsync(i => i.TokenHash == hash, ct);
        if (invite is null || StaffInviteStatus(invite) != InviteStatuses.Valid)
            throw new AppException(410, ErrorCodes.StaffInviteInvalid, "This staff invitation is no longer valid. Ask an administrator for a new one.");
        return invite;
    }

    private static async Task<StaffInviteLookupDto> StaffInviteLookupAsync(string token, AppDbContext db, CancellationToken ct)
    {
        var hash = SecureTokens.Hash(token);
        var row = await db.StaffInvites.AsNoTracking().Where(i => i.TokenHash == hash)
                      .Select(i => new { Invite = i, CourseTitle = db.Courses.Where(c => c.Id == i.CourseId).Select(c => c.Title).FirstOrDefault() })
                      .FirstOrDefaultAsync(ct)
                  ?? throw AppException.NotFound("This invitation link is not valid.");
        return new StaffInviteLookupDto(EmailAddresses.Mask(row.Invite.EmailNormalized), row.Invite.Role, row.CourseTitle, StaffInviteStatus(row.Invite));
    }

    private static async Task<MeDto> AcceptStaffInviteAsync(string token, HttpContext ctx, UserManager<AppUser> users, SignInManager<AppUser> signIn,
        AppDbContext db, ILogger<RegisterRequest> logger, CancellationToken ct)
    {
        var invite = await UsableStaffInviteAsync(db, token, ct);
        var user = await users.FindByIdAsync(ctx.User.GetUserId().ToString());
        if (user is null || user.DeletedAt is not null) throw new AppException(401, ErrorCodes.AuthUnauthenticated, "Please sign in.");
        if (EmailAddresses.Normalize(user.Email ?? "") != invite.EmailNormalized)
            throw AppException.Forbidden($"This invitation was sent to {EmailAddresses.Mask(invite.EmailNormalized)}. Sign in with that email address.");

        await ApplyStaffInviteAsync(invite, user, users, db, ct);
        await db.SaveChangesAsync(ct);
        await users.UpdateSecurityStampAsync(user);
        await signIn.RefreshSignInAsync(user); // new role claims right away
        logger.LogInformation(AuthEvent, "Staff invitation accepted ({role})", invite.Role);
        return await BuildMeAsync(user, users, db);
    }

    // ---------------- registration ----------------

    private static async Task<Accepted<MessageResponse>> RegisterAsync(RegisterRequest req, HttpContext ctx, UserManager<AppUser> users, AppDbContext db,
        IAppEmailSender email, IOptions<AppUrlOptions> app, IOptions<PrivacyOptions> privacy, UserIdHasher hasher, ILogger<RegisterRequest> logger,
        CancellationToken ct)
    {
        var emailAddr = req.Email.Trim();
        var dob = ParseDate(req.DateOfBirth) ?? throw AppException.Validation("dateOfBirth", "Date of birth is required.");
        var p = privacy.Value;
        var age = Ages.On(dob, TodayUtc);
        if (age < p.MinimumAge)
            throw new AppException(400, ErrorCodes.AuthTooYoung, $"You need to be at least {p.MinimumAge} years old to use Sathi.");
        var minor = age < p.AgeOfMajority;
        string? guardian = null;
        if (minor)
        {
            if (string.IsNullOrWhiteSpace(req.GuardianEmail) || !EmailAddresses.IsValid(req.GuardianEmail.Trim()))
                throw AppException.Validation("guardianEmail", "Because you're under 18, enter a parent or guardian's email address.");
            guardian = EmailAddresses.Normalize(req.GuardianEmail);
            if (guardian == EmailAddresses.Normalize(emailAddr))
                throw AppException.Validation("guardianEmail", "Your parent or guardian's email must be different from yours.");
        }

        StaffInvite? staffInvite = null;
        if (!string.IsNullOrWhiteSpace(req.StaffInviteToken))
        {
            staffInvite = await UsableStaffInviteAsync(db, req.StaffInviteToken.Trim(), ct);
            if (staffInvite.EmailNormalized != EmailAddresses.Normalize(emailAddr))
                throw AppException.Validation("email", "Use the email address the invitation was sent to.");
        }

        if (await users.FindByEmailAsync(emailAddr) is not null)
            throw new AppException(409, ErrorCodes.AuthEmailTaken, "An account with this email already exists. Try signing in.");

        var user = new AppUser
        {
            UserName = emailAddr, Email = emailAddr, DisplayName = req.DisplayName.Trim(), CreatedAt = DateTime.UtcNow,
            DateOfBirth = dob, IsMinor = minor, GuardianEmailNormalized = guardian,
            GuardianConsentStatus = minor ? GuardianConsentStatuses.Pending : GuardianConsentStatuses.NotRequired,
        };
        var result = await users.CreateAsync(user, req.Password);
        if (!result.Succeeded)
        {
            if (result.Errors.Any(e => e.Code is "DuplicateEmail" or "DuplicateUserName"))
                throw new AppException(409, ErrorCodes.AuthEmailTaken, "An account with this email already exists. Try signing in.");
            throw new AppException(400, ErrorCodes.ValidationFailed, "Some fields need attention.",
                new Dictionary<string, string[]> { ["password"] = result.Errors.Select(e => e.Description).ToArray() });
        }
        await users.AddToRoleAsync(user, Roles.Student);
        db.UserPreferences.Add(new UserPreference { UserId = user.Id });
        db.Audit(user.Id, AuditActions.Register, "user", user.Id, new { minor, staffInvite = staffInvite is not null });
        if (staffInvite is not null) await ApplyStaffInviteAsync(staffInvite, user, users, db, ct);
        string? consentToken = null;
        if (minor) consentToken = GuardianConsentEndpoints.AddConsentRequest(db, user, p);
        await db.SaveChangesAsync(ct);

        await SendVerificationAsync(user, users, email, app.Value, logger, ct);
        if (consentToken is not null) await GuardianConsentEndpoints.SendRequestAsync(db, user, consentToken, email, app.Value, logger, ct);
        logger.LogInformation(AuthEvent, "User registered {registered_user_hash} (minor {minor}, staff invite {staff_invite})",
            hasher.Hash(user.Id), minor, staffInvite is not null);
        return TypedResults.Accepted((string?)null, new MessageResponse("Check your email"));
    }

    private static async Task<NoContent> VerifyEmailAsync(VerifyEmailRequest req, UserManager<AppUser> users)
    {
        var user = await users.FindByIdAsync(req.UserId.ToString());
        var token = Decode(req.Token);
        if (user is null || token is null || user.DeletedAt is not null)
            throw new AppException(400, ErrorCodes.AuthInvalidToken, "This verification link is invalid or has expired.");
        if (user.EmailConfirmed) return TypedResults.NoContent();
        var result = await users.ConfirmEmailAsync(user, token);
        if (!result.Succeeded)
            throw new AppException(400, ErrorCodes.AuthInvalidToken, "This verification link is invalid or has expired.");
        return TypedResults.NoContent();
    }

    private static async Task<Accepted<MessageResponse>> ResendAsync(EmailRequest req, UserManager<AppUser> users, IAppEmailSender email,
        IOptions<AppUrlOptions> app, ILogger<EmailRequest> logger, CancellationToken ct)
    {
        var user = await users.FindByEmailAsync(req.Email.Trim());
        if (user is { EmailConfirmed: false, DeletedAt: null })
            await SendVerificationAsync(user, users, email, app.Value, logger, ct);
        return TypedResults.Accepted((string?)null, new MessageResponse("If an account needs verification, we've sent a new link."));
    }

    private static async Task<Accepted<MessageResponse>> ResendGuardianConsentAsync(EmailRequest req, UserManager<AppUser> users, AppDbContext db,
        IAppEmailSender email, IOptions<AppUrlOptions> app, IOptions<PrivacyOptions> privacy, ILogger<EmailRequest> logger, CancellationToken ct)
    {
        var user = await users.FindByEmailAsync(req.Email.Trim());
        if (user is { DeletedAt: null, IsMinor: true, GuardianConsentStatus: GuardianConsentStatuses.Pending } && user.GuardianEmailNormalized is not null)
        {
            var token = await GuardianConsentEndpoints.RefreshRequestAsync(db, user, privacy.Value, ct);
            await db.SaveChangesAsync(ct);
            await GuardianConsentEndpoints.SendRequestAsync(db, user, token, email, app.Value, logger, ct);
        }
        return TypedResults.Accepted((string?)null, new MessageResponse("If a guardian's consent is pending, we've emailed them again."));
    }

    // ---------------- sign-in ----------------

    private static async Task<MeDto> LoginAsync(LoginRequest req, HttpContext ctx, UserManager<AppUser> users, SignInManager<AppUser> signIn,
        AppDbContext db, IAntiforgery af, IHostEnvironment env, UserIdHasher hasher, IOptions<PrivacyOptions> privacy, ILogger<LoginRequest> logger)
    {
        var user = await users.FindByEmailAsync(req.Email.Trim());
        if (user is null)
        {
            logger.LogInformation(LoginFailed, "Login failed: unknown account");
            throw new AppException(401, ErrorCodes.AuthInvalidCredentials, "Wrong email or password.");
        }

        using var _ = Serilog.Context.LogContext.PushProperty("user_id_hash", hasher.Hash(user.Id));
        if (user.DeletedAt is not null)
        {
            // A guardian declined/withdrew consent: tell the learner (only with the right password), otherwise it's an unknown account.
            if (user.GuardianConsentStatus is GuardianConsentStatuses.Declined or GuardianConsentStatuses.Withdrawn
                && await users.CheckPasswordAsync(user, req.Password))
            {
                logger.LogInformation(LoginFailed, "Login failed: guardian consent declined");
                throw new AppException(403, ErrorCodes.AuthGuardianConsentDeclined,
                    "Your parent or guardian did not give consent, so this account was closed.");
            }
            logger.LogInformation(LoginFailed, "Login failed: deleted account");
            throw new AppException(401, ErrorCodes.AuthInvalidCredentials, "Wrong email or password.");
        }
        if (await users.IsLockedOutAsync(user))
        {
            logger.LogInformation(LoginFailed, "Login failed: locked out");
            throw new AppException(423, ErrorCodes.AuthLockedOut, "Too many failed attempts. Try again in 15 minutes or reset your password.");
        }
        if (!await users.CheckPasswordAsync(user, req.Password))
        {
            await users.AccessFailedAsync(user);
            if (await users.IsLockedOutAsync(user))
            {
                logger.LogWarning(LoginFailed, "Login failed: account locked after repeated failures");
                throw new AppException(423, ErrorCodes.AuthLockedOut, "Too many failed attempts. Try again in 15 minutes or reset your password.");
            }
            logger.LogInformation(LoginFailed, "Login failed: wrong password");
            throw new AppException(401, ErrorCodes.AuthInvalidCredentials, "Wrong email or password.");
        }
        if (!user.EmailConfirmed)
        {
            logger.LogInformation(LoginFailed, "Login failed: email not confirmed");
            throw new AppException(403, ErrorCodes.AuthEmailNotConfirmed, "Please verify your email first. We can send a new link.");
        }
        switch (user.GuardianConsentStatus)
        {
            case GuardianConsentStatuses.Pending:
                logger.LogInformation(LoginFailed, "Login failed: guardian consent pending");
                throw new AppException(403, ErrorCodes.AuthGuardianConsentPending,
                    "We're waiting for your parent or guardian to give consent. We can email them again.");
            case GuardianConsentStatuses.Declined or GuardianConsentStatuses.Withdrawn:
                logger.LogInformation(LoginFailed, "Login failed: guardian consent declined");
                throw new AppException(403, ErrorCodes.AuthGuardianConsentDeclined, "Your parent or guardian did not give consent.");
        }

        await users.ResetAccessFailedCountAsync(user);
        user.LastActiveAt = DateTime.UtcNow;
        if (user is { IsMinor: true, DateOfBirth: { } dob } && Ages.On(dob, TodayUtc) >= privacy.Value.AgeOfMajority) user.IsMinor = false;
        await users.UpdateAsync(user);
        await signIn.SignInAsync(user, isPersistent: req.RememberMe);
        db.Audit(user.Id, AuditActions.Login, "user", user.Id);
        await db.SaveChangesAsync();

        // Token bound to the new identity, so the SPA can make its next mutation without another round-trip.
        ctx.User = await signIn.CreateUserPrincipalAsync(user);
        CsrfCookie.Issue(ctx, af, Secure(env));
        logger.LogInformation(AuthEvent, "User signed in");
        return await BuildMeAsync(user, users, db);
    }

    private static async Task<NoContent> LogoutAsync(HttpContext ctx, SignInManager<AppUser> signIn, AppDbContext db, IAntiforgery af, IHostEnvironment env)
    {
        if (ctx.User.Identity?.IsAuthenticated == true)
        {
            db.Audit(ctx.User.GetUserId(), AuditActions.Logout, "user", ctx.User.GetUserId());
            await db.SaveChangesAsync();
        }
        await signIn.SignOutAsync();
        ctx.User = new ClaimsPrincipal(new ClaimsIdentity());
        CsrfCookie.Issue(ctx, af, Secure(env));
        return TypedResults.NoContent();
    }

    private static async Task<Accepted<MessageResponse>> ForgotAsync(EmailRequest req, UserManager<AppUser> users, IAppEmailSender email,
        IOptions<AppUrlOptions> app, ILogger<EmailRequest> logger, CancellationToken ct)
    {
        var user = await users.FindByEmailAsync(req.Email.Trim());
        if (user is { EmailConfirmed: true, DeletedAt: null })
        {
            var token = Encode(await users.GeneratePasswordResetTokenAsync(user));
            var link = $"{app.Value.BaseUrl.TrimEnd('/')}/auth/reset-password?email={Uri.EscapeDataString(user.Email!)}&token={Uri.EscapeDataString(token)}";
            try
            {
                await email.SendAsync(EmailTemplates.ResetPassword(user.Email!, user.DisplayName, link), ct);
            }
            catch (Exception ex) when (ex is not OperationCanceledException)
            {
                logger.LogWarning(AuthEvent, ex, "Password reset email could not be sent");
            }
        }
        return TypedResults.Accepted((string?)null, new MessageResponse("If an account exists, we've sent a reset link."));
    }

    private static async Task<NoContent> ResetAsync(ResetPasswordRequest req, UserManager<AppUser> users)
    {
        var user = await users.FindByEmailAsync(req.Email.Trim());
        var token = Decode(req.Token);
        if (user is null || token is null || user.DeletedAt is not null)
            throw new AppException(400, ErrorCodes.AuthInvalidToken, "This reset link is invalid or has expired.");
        // ResetPasswordAsync also rotates the security stamp, so other sessions end within the validation interval.
        var result = await users.ResetPasswordAsync(user, token, req.NewPassword);
        if (!result.Succeeded)
        {
            if (result.Errors.Any(e => e.Code == "InvalidToken"))
                throw new AppException(400, ErrorCodes.AuthInvalidToken, "This reset link is invalid or has expired.");
            throw new AppException(400, ErrorCodes.ValidationFailed, "Some fields need attention.",
                new Dictionary<string, string[]> { ["newPassword"] = result.Errors.Select(e => e.Description).ToArray() });
        }
        await users.SetLockoutEndDateAsync(user, null);
        await users.ResetAccessFailedCountAsync(user);
        return TypedResults.NoContent();
    }

    // ---------------- me ----------------

    private static async Task<MeDto> UpdatePreferencesAsync(PreferencesRequest req, HttpContext ctx, UserManager<AppUser> users, AppDbContext db, CancellationToken ct)
    {
        var userId = ctx.User.GetUserId();
        var user = await users.FindByIdAsync(userId.ToString()) ?? throw new AppException(401, ErrorCodes.AuthUnauthenticated, "Please sign in.");
        var p = await db.UserPreferences.FirstOrDefaultAsync(x => x.UserId == userId, ct);
        if (p is null) { p = new UserPreference { UserId = userId }; db.UserPreferences.Add(p); }
        if (req.Level is not null) p.Level = req.Level;
        if (req.Timezone is not null) p.Timezone = req.Timezone;
        if (req.ReminderHour is not null) p.ReminderHour = req.ReminderHour.Value;
        if (req.RemindersEnabled is not null) p.RemindersEnabled = req.RemindersEnabled.Value;
        if (req.ActiveCourseId is { } courseId)
        {
            if (!await CourseAccess.Catalog(db, ctx.User.Viewer()).AnyAsync(c => c.Id == courseId, ct))
                throw AppException.Validation("activeCourseId", "Unknown course.");
            p.ActiveCourseId = courseId;
        }
        await db.SaveChangesAsync(ct);
        return await BuildMeAsync(user, users, db);
    }

    private static async Task<MeDto> UpdateProfileAsync(ProfileRequest req, HttpContext ctx, UserManager<AppUser> users, AppDbContext db, CancellationToken ct)
    {
        var user = await users.FindByIdAsync(ctx.User.GetUserId().ToString()) ?? throw new AppException(401, ErrorCodes.AuthUnauthenticated, "Please sign in.");
        var name = req.DisplayName.Trim();
        if (name != user.DisplayName)
        {
            user.DisplayName = name;
            await users.UpdateAsync(user);
            db.Audit(user.Id, AuditActions.ProfileUpdated, "user", user.Id);
            await db.SaveChangesAsync(ct);
        }
        return await BuildMeAsync(user, users, db);
    }

    /// <summary>Soft-delete + session end + user.deleted outbox event (chunks, uploads removed asynchronously).</summary>
    public static async Task SoftDeleteAccountAsync(AppDbContext db, UserManager<AppUser> users, AppUser user, Guid? actor, string reason, CancellationToken ct)
    {
        var now = DateTime.UtcNow;
        user.DeletedAt = now;
        await users.UpdateAsync(user);
        await users.UpdateSecurityStampAsync(user);
        await db.Conversations.Where(c => c.UserId == user.Id && c.DeletedAt == null).ExecuteUpdateAsync(s => s.SetProperty(c => c.DeletedAt, now), ct);
        await db.ClassMembers.Where(m => m.UserId == user.Id && m.RemovedAt == null).ExecuteUpdateAsync(s => s.SetProperty(m => m.RemovedAt, now), ct);
        db.Outbox(OutboxTypes.UserDeleted, new { userId = user.Id });
        db.Audit(actor, AuditActions.UserDeleteRequested, "user", user.Id, new { reason });
        await db.SaveChangesAsync(ct);
    }

    private static async Task<Accepted<MessageResponse>> DeleteMeAsync(HttpContext ctx, UserManager<AppUser> users, SignInManager<AppUser> signIn, AppDbContext db,
        IAntiforgery af, IHostEnvironment env, ILogger<DeleteMeRequest> logger, CancellationToken ct)
    {
        DeleteMeRequest? req = null;
        try { req = await ctx.Request.ReadFromJsonAsync<DeleteMeRequest>(ct); } catch (System.Text.Json.JsonException) { }
        if (string.IsNullOrEmpty(req?.Password)) throw AppException.Validation("password", "Password is required.");

        var user = await users.FindByIdAsync(ctx.User.GetUserId().ToString()) ?? throw new AppException(401, ErrorCodes.AuthUnauthenticated, "Please sign in.");
        if (!await users.CheckPasswordAsync(user, req.Password))
            throw new AppException(401, ErrorCodes.AuthInvalidCredentials, "That password is not correct.");

        await SoftDeleteAccountAsync(db, users, user, user.Id, "self", ct);
        await signIn.SignOutAsync();
        ctx.User = new ClaimsPrincipal(new ClaimsIdentity());
        CsrfCookie.Issue(ctx, af, Secure(env));
        logger.LogInformation(AuthEvent, "Account deletion requested");
        return TypedResults.Accepted((string?)null, new MessageResponse("Your account is being deleted."));
    }
}
