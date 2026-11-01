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
using Sathi.Core.Usage;

namespace Sathi.Api.Modules;

public sealed record UpdateRolesRequest(List<string> Roles);
public sealed record LockUserRequest(int? Minutes);
public sealed record CreateStaffInviteRequest(string Email, string Role, Guid? CourseId);

/// <summary>Contract §11.2 AdminUser.</summary>
public sealed record AdminUserDto(Guid Id, string Email, string DisplayName, IReadOnlyList<string> Roles, bool EmailConfirmed, bool LockedOut,
    string AccountStatus, bool IsMinor, DateTime CreatedAt, DateTime? LastActiveAt);
public sealed record AdminUserCourseDto(Guid Id, string Title, string Role);
public sealed record AdminUserClassDto(Guid Id, string Name, string CourseTitle);
public sealed record AdminUserDetailDto(Guid Id, string Email, string DisplayName, IReadOnlyList<string> Roles, bool EmailConfirmed, bool LockedOut,
    string AccountStatus, bool IsMinor, DateTime CreatedAt, DateTime? LastActiveAt, IReadOnlyList<AdminUserCourseDto> Courses,
    IReadOnlyList<AdminUserClassDto> Classes);
public sealed record StaffInviteCreatedDto(Guid Id, string Email, string Role, Guid? CourseId, DateTime ExpiresAt);
public sealed record StaffInviteDto(Guid Id, string Email, string Role, string? CourseTitle, DateTime CreatedAt, DateTime ExpiresAt, string Status);

public sealed class UpdateRolesValidator : AbstractValidator<UpdateRolesRequest>
{
    public UpdateRolesValidator() =>
        RuleFor(x => x.Roles).NotNull().Must(r => r is { Count: > 0 } && r.All(x => Roles.Canonical(x) is not null))
            .WithMessage("Choose at least one of Student, Instructor or Admin.");
}

public sealed class LockUserValidator : AbstractValidator<LockUserRequest>
{
    public LockUserValidator() => RuleFor(x => x.Minutes).InclusiveBetween(1, 525_600).When(x => x.Minutes is not null);
}

public sealed class CreateStaffInviteValidator : AbstractValidator<CreateStaffInviteRequest>
{
    public CreateStaffInviteValidator()
    {
        RuleFor(x => x.Email).NotEmpty().WithMessage("Email is required.").EmailAddress().WithMessage("Enter a valid email address.").MaximumLength(254);
        RuleFor(x => x.Role).Must(r => r is Roles.Instructor or Roles.Admin).WithMessage("Role must be Instructor or Admin.");
    }
}

/// <summary>User administration and staff invitations (contract §11.2). Admin only. Every action is audited.</summary>
public static class AdminUsersEndpoints
{
    private static readonly EventId AdminEvent = new(3302, "admin.users");
    public static readonly TimeSpan StaffInviteLifetime = TimeSpan.FromDays(7);

    public static void MapAdminUsers(this RouteGroupBuilder api)
    {
        var g = api.MapGroup("/admin").RequireAuthorization("Admin").WithTags("Admin users").WithProblems(401, 403);
        g.MapGet("/users", ListAsync).WithProblems(400).Doc("ListUsers", "Search users (query matches email or name; role and status filters; cursor paging)");
        g.MapGet("/users/{id:guid}", GetAsync).WithProblems(404).Doc("GetUser", "A user with their courses (as instructor) and classes");
        g.MapPut("/users/{id:guid}/roles", UpdateRolesAsync).Validate<UpdateRolesRequest>().WithProblems(400, 404, 409)
            .Doc("UpdateUserRoles", "Replace a user's roles (409 ROLE_SELF_DEMOTION / ROLE_LAST_ADMIN)");
        g.MapPost("/users/{id:guid}/lock", LockAsync).Validate<LockUserRequest>().WithProblems(400, 404, 409)
            .Doc("LockUser", "Lock an account for N minutes or until unlocked (ends their sessions within a minute)");
        g.MapPost("/users/{id:guid}/unlock", UnlockAsync).WithProblems(404).Doc("UnlockUser", "Unlock an account");
        g.MapPost("/users/{id:guid}/resend-verification", ResendVerificationAsync).WithProblems(404)
            .Doc("ResendUserVerification", "Send the user a new email verification link");
        g.MapPost("/staff-invites", CreateInviteAsync).Validate<CreateStaffInviteRequest>().WithProblems(400, 404)
            .Doc("CreateStaffInvite", "Invite someone as Instructor (optionally for a course) or Admin");
        g.MapGet("/staff-invites", ListInvitesAsync).Doc("ListStaffInvites", "Staff invitations with their status");
        g.MapDelete("/staff-invites/{id:guid}", RevokeInviteAsync).WithProblems(404).Doc("RevokeStaffInvite", "Revoke a staff invitation");
    }

    private static string StatusOf(AppUser u) =>
        u.DeletedAt is not null ? AccountStatuses.Deleted
        : u.GuardianConsentStatus == GuardianConsentStatuses.Pending ? AccountStatuses.PendingGuardian
        : AccountStatuses.Active;

    private static bool IsLocked(AppUser u) => u.LockoutEnd is { } end && end > DateTimeOffset.UtcNow;

    private static async Task<Dictionary<Guid, List<string>>> RolesOfAsync(AppDbContext db, IReadOnlyCollection<Guid> userIds, CancellationToken ct)
    {
        var rows = await (from ur in db.UserRoles
                          join r in db.Roles on ur.RoleId equals r.Id
                          where userIds.Contains(ur.UserId)
                          select new { ur.UserId, r.Name }).ToListAsync(ct);
        return rows.GroupBy(r => r.UserId).ToDictionary(g => g.Key, g => g.Select(x => x.Name!).OrderBy(n => n).ToList());
    }

    private static AdminUserDto ToDto(AppUser u, IReadOnlyList<string> roles) =>
        new(u.Id, u.Email ?? "", u.DisplayName, roles, u.EmailConfirmed, IsLocked(u), StatusOf(u), u.IsMinor, u.CreatedAt, u.LastActiveAt);

    private static async Task<AdminUserDto> DtoAsync(AppDbContext db, Guid userId, CancellationToken ct)
    {
        var u = await db.Users.AsNoTracking().FirstAsync(x => x.Id == userId, ct);
        var roles = await RolesOfAsync(db, [userId], ct);
        return ToDto(u, roles.GetValueOrDefault(userId) ?? []);
    }

    private static async Task<AppUser> FindAsync(UserManager<AppUser> users, Guid id) =>
        await users.FindByIdAsync(id.ToString()) ?? throw new AppException(404, ErrorCodes.UserNotFound, "User not found.");

    // ---------------- users ----------------

    private static async Task<Page<AdminUserDto>> ListAsync(string? query, string? role, string? status, string? cursor, int? limit, AppDbContext db,
        CancellationToken ct)
    {
        var take = Cursor.Limit(limit);
        var after = Cursor.DecodeKeyset(cursor);
        var q = db.Users.AsNoTracking().AsQueryable();
        if (!string.IsNullOrWhiteSpace(query))
        {
            var upper = query.Trim().ToUpperInvariant();
            var lower = query.Trim().ToLowerInvariant();
            q = q.Where(u => u.NormalizedEmail!.Contains(upper) || u.DisplayName.ToLower().Contains(lower));
        }
        if (!string.IsNullOrWhiteSpace(role))
        {
            var name = Roles.Canonical(role) ?? throw AppException.Validation("role", "Role must be Student, Instructor or Admin.");
            var normalized = name.ToUpperInvariant();
            q = q.Where(u => db.UserRoles.Any(ur => ur.UserId == u.Id && db.Roles.Any(r => r.Id == ur.RoleId && r.NormalizedName == normalized)));
        }
        switch (status)
        {
            case null or "": break;
            case AccountStatuses.Deleted: q = q.Where(u => u.DeletedAt != null); break;
            case AccountStatuses.PendingGuardian: q = q.Where(u => u.DeletedAt == null && u.GuardianConsentStatus == GuardianConsentStatuses.Pending); break;
            case AccountStatuses.Active: q = q.Where(u => u.DeletedAt == null && u.GuardianConsentStatus != GuardianConsentStatuses.Pending); break;
            default: throw AppException.Validation("status", "Status must be active, pending_guardian or deleted.");
        }
        if (after is { } k)
        {
            var at = k.At;
            if (k.Id is { } lastId) q = q.Where(u => u.CreatedAt < at || (u.CreatedAt == at && u.Id.CompareTo(lastId) < 0));
            else q = q.Where(u => u.CreatedAt < at);
        }
        var rows = await q.OrderByDescending(u => u.CreatedAt).ThenByDescending(u => u.Id).Take(take + 1).ToListAsync(ct);
        var page = rows.Take(take).ToList();
        var roles = await RolesOfAsync(db, page.Select(u => u.Id).ToList(), ct);
        var next = rows.Count > take ? Cursor.EncodeKeyset(page[^1].CreatedAt, page[^1].Id) : null;
        return new Page<AdminUserDto>(page.Select(u => ToDto(u, roles.GetValueOrDefault(u.Id) ?? [])).ToList(), next);
    }

    private static async Task<AdminUserDetailDto> GetAsync(Guid id, AppDbContext db, CancellationToken ct)
    {
        var u = await db.Users.AsNoTracking().FirstOrDefaultAsync(x => x.Id == id, ct) ?? throw new AppException(404, ErrorCodes.UserNotFound, "User not found.");
        var roles = (await RolesOfAsync(db, [id], ct)).GetValueOrDefault(id) ?? [];
        var courses = await (from ci in db.CourseInstructors
                             join c in db.Courses on ci.CourseId equals c.Id
                             where ci.UserId == id
                             orderby c.Title
                             select new AdminUserCourseDto(c.Id, c.Title, ci.Role)).ToListAsync(ct);
        var classes = await (from m in CourseAccess.ActiveMemberships(db)
                             join k in db.Classes on m.ClassId equals k.Id
                             join c in db.Courses on k.CourseId equals c.Id
                             where m.UserId == id
                             orderby k.Name
                             select new AdminUserClassDto(k.Id, k.Name, c.Title)).ToListAsync(ct);
        return new AdminUserDetailDto(u.Id, u.Email ?? "", u.DisplayName, roles, u.EmailConfirmed, IsLocked(u), StatusOf(u), u.IsMinor, u.CreatedAt,
            u.LastActiveAt, courses, classes);
    }

    private static async Task<AdminUserDto> UpdateRolesAsync(Guid id, UpdateRolesRequest req, HttpContext ctx, AppDbContext db, UserManager<AppUser> users,
        SignInManager<AppUser> signIn, ILogger<UpdateRolesRequest> logger, CancellationToken ct)
    {
        var target = await FindAsync(users, id);
        var me = ctx.User.GetUserId();
        var wanted = req.Roles.Select(r => Roles.Canonical(r)!).Distinct().OrderBy(r => r).ToList();
        var current = (await users.GetRolesAsync(target)).OrderBy(r => r).ToList();

        if (current.Contains(Roles.Admin) && !wanted.Contains(Roles.Admin))
        {
            if (target.Id == me)
                throw new AppException(409, ErrorCodes.RoleSelfDemotion, "You can't remove your own Admin role. Ask another administrator.");
            var adminRoleId = await db.Roles.Where(r => r.NormalizedName == Roles.Admin.ToUpperInvariant()).Select(r => r.Id).FirstAsync(ct);
            var otherAdmins = await db.UserRoles.CountAsync(ur => ur.RoleId == adminRoleId && ur.UserId != target.Id
                                                                  && db.Users.Any(u => u.Id == ur.UserId && u.DeletedAt == null), ct);
            if (otherAdmins == 0) throw new AppException(409, ErrorCodes.RoleLastAdmin, "Sathi needs at least one administrator.");
        }

        var add = wanted.Except(current).ToList();
        var remove = current.Except(wanted).ToList();
        if (add.Count > 0 || remove.Count > 0)
        {
            if (add.Count > 0) EnsureSucceeded(await users.AddToRolesAsync(target, add));
            if (remove.Count > 0) EnsureSucceeded(await users.RemoveFromRolesAsync(target, remove));
            // Contract §11.2: the new roles reach the user's active sessions within the 1-minute validation interval.
            await users.UpdateSecurityStampAsync(target);
            if (target.Id == me) await signIn.RefreshSignInAsync(target); // keep the acting admin signed in, with the new roles
            db.Audit(me, AuditActions.RolesChanged, "user", target.Id, new { before = current, after = wanted });
            await db.SaveChangesAsync(ct);
            logger.LogInformation(AdminEvent, "User roles changed: +[{added}] -[{removed}]", string.Join(",", add),
                string.Join(",", remove));
        }
        return await DtoAsync(db, target.Id, ct);
    }

    private static void EnsureSucceeded(IdentityResult r)
    {
        if (!r.Succeeded) throw new InvalidOperationException("Role update failed: " + string.Join(",", r.Errors.Select(e => e.Code)));
    }

    private static async Task<NoContent> LockAsync(Guid id, LockUserRequest req, HttpContext ctx, AppDbContext db, UserManager<AppUser> users,
        CancellationToken ct)
    {
        var target = await FindAsync(users, id);
        var me = ctx.User.GetUserId();
        if (target.Id == me) throw new AppException(409, ErrorCodes.RoleSelfDemotion, "You can't lock your own account.");
        var until = req.Minutes is { } m ? DateTimeOffset.UtcNow.AddMinutes(m) : DateTimeOffset.MaxValue;
        await users.SetLockoutEnabledAsync(target, true);
        await users.SetLockoutEndDateAsync(target, until);
        await users.UpdateSecurityStampAsync(target); // ends active sessions within the validation interval
        db.Audit(me, AuditActions.UserLocked, "user", target.Id, new { minutes = req.Minutes });
        await db.SaveChangesAsync(ct);
        return TypedResults.NoContent();
    }

    private static async Task<NoContent> UnlockAsync(Guid id, HttpContext ctx, AppDbContext db, UserManager<AppUser> users, CancellationToken ct)
    {
        var target = await FindAsync(users, id);
        await users.SetLockoutEndDateAsync(target, null);
        await users.ResetAccessFailedCountAsync(target);
        db.Audit(ctx.User.GetUserId(), AuditActions.UserUnlocked, "user", target.Id);
        await db.SaveChangesAsync(ct);
        return TypedResults.NoContent();
    }

    private static async Task<Accepted> ResendVerificationAsync(Guid id, HttpContext ctx, AppDbContext db, UserManager<AppUser> users, IAppEmailSender email,
        IOptions<AppUrlOptions> app, ILogger<UpdateRolesRequest> logger, CancellationToken ct)
    {
        var target = await FindAsync(users, id);
        if (target is { EmailConfirmed: false, DeletedAt: null })
        {
            await IdentityEndpoints.SendVerificationAsync(target, users, email, app.Value, logger, ct);
            db.Audit(ctx.User.GetUserId(), AuditActions.VerificationResent, "user", target.Id);
            await db.SaveChangesAsync(ct);
        }
        return TypedResults.Accepted((string?)null);
    }

    // ---------------- staff invites ----------------

    private static async Task<Created<StaffInviteCreatedDto>> CreateInviteAsync(CreateStaffInviteRequest req, HttpContext ctx, AppDbContext db,
        IAppEmailSender email, IOptions<AppUrlOptions> app, ILogger<CreateStaffInviteRequest> logger, CancellationToken ct)
    {
        string? courseTitle = null;
        if (req.CourseId is { } courseId)
            courseTitle = await db.Courses.Where(c => c.Id == courseId).Select(c => c.Title).FirstOrDefaultAsync(ct)
                          ?? throw AppException.NotFound("Course not found.");
        var me = ctx.User.GetUserId();
        var (raw, hash) = SecureTokens.Create();
        var now = DateTime.UtcNow;
        var invite = new StaffInvite
        {
            EmailNormalized = EmailAddresses.Normalize(req.Email), Role = req.Role, CourseId = req.CourseId, TokenHash = hash, InvitedBy = me,
            CreatedAt = now, ExpiresAt = now + StaffInviteLifetime,
        };
        db.StaffInvites.Add(invite);
        db.Audit(me, AuditActions.StaffInviteCreated, "staff_invite", invite.Id, new { invite.Role, invite.CourseId });
        await db.SaveChangesAsync(ct);

        var link = $"{app.Value.BaseUrl.TrimEnd('/')}/auth/register?staffInvite={raw}";
        try
        {
            await email.SendAsync(EmailTemplates.StaffInvite(invite.EmailNormalized, invite.Role, courseTitle, link, invite.ExpiresAt), ct);
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            logger.LogWarning(AdminEvent, ex, "Staff invitation email could not be sent (invite {invite_id})", invite.Id);
        }
        return TypedResults.Created($"/api/v1/admin/staff-invites/{invite.Id}",
            new StaffInviteCreatedDto(invite.Id, invite.EmailNormalized, invite.Role, invite.CourseId, invite.ExpiresAt));
    }

    private static async Task<List<StaffInviteDto>> ListInvitesAsync(AppDbContext db, CancellationToken ct)
    {
        var rows = await db.StaffInvites.AsNoTracking().OrderByDescending(i => i.CreatedAt).Take(500)
            .Select(i => new { i, CourseTitle = db.Courses.Where(c => c.Id == i.CourseId).Select(c => c.Title).FirstOrDefault() })
            .ToListAsync(ct);
        return rows.Select(r => new StaffInviteDto(r.i.Id, r.i.EmailNormalized, r.i.Role, r.CourseTitle, r.i.CreatedAt, r.i.ExpiresAt,
            ClassesEndpoints.InviteStatus(r.i.AcceptedAt, r.i.RevokedAt, r.i.ExpiresAt, InviteStatuses.Pending))).ToList();
    }

    private static async Task<NoContent> RevokeInviteAsync(Guid id, HttpContext ctx, AppDbContext db, CancellationToken ct)
    {
        var invite = await db.StaffInvites.FirstOrDefaultAsync(i => i.Id == id, ct) ?? throw AppException.NotFound("Invitation not found.");
        if (invite.AcceptedAt is null && invite.RevokedAt is null)
        {
            invite.RevokedAt = DateTime.UtcNow;
            db.Audit(ctx.User.GetUserId(), AuditActions.StaffInviteRevoked, "staff_invite", invite.Id);
            await db.SaveChangesAsync(ct);
        }
        return TypedResults.NoContent();
    }
}
