using FluentValidation;
using Microsoft.AspNetCore.Http.HttpResults;
using Microsoft.AspNetCore.Identity;
using Microsoft.EntityFrameworkCore;
using Sathi.Api.Infrastructure;
using Sathi.Core.Access;
using Sathi.Core.Data;
using Sathi.Core.Domain;
using Sathi.Core.Errors;
using Sathi.Core.Usage;

namespace Sathi.Api.Modules;

public sealed record JoinClassRequest(string Code);
public sealed record JoinClassResponse(Guid ClassId, string ClassName, CourseSummary Course);
public sealed record ClassInviteLookupDto(string ClassName, string CourseTitle, string InstructorName, string EmailMasked, string Status);
public sealed record MyClassDto(Guid ClassId, string Name, IdTitle Course, DateTime JoinedAt);

public sealed class JoinClassValidator : AbstractValidator<JoinClassRequest>
{
    public JoinClassValidator() => RuleFor(x => x.Code).NotEmpty().WithMessage("Enter the class code.").MaximumLength(20);
}

/// <summary>Student side of classes (contract §11.1): join by code, invite lookup/accept, my classes, leave.</summary>
public static class ClassesEndpoints
{
    private static readonly EventId ClassEvent = new(3401, "class.membership");

    public static void MapClasses(this RouteGroupBuilder api)
    {
        var g = api.MapGroup("").WithTags("Classes").WithProblems(401);
        g.MapPost("/classes/join", JoinByCodeAsync).Validate<JoinClassRequest>().WithProblems(400, 404, 409)
            .Doc("JoinClass", "Join a class with its code (enrols in the course)");
        g.MapGet("/classes/invites/{token}", LookupInviteAsync).AllowAnonymous().WithProblems(404)
            .Doc("GetClassInvite", "Public summary of a class invitation (no sign-in needed)");
        g.MapPost("/classes/invites/{token}/accept", AcceptInviteAsync).WithProblems(403, 404, 410)
            .Doc("AcceptClassInvite", "Accept a class invitation as the invited (signed-in) email");
        g.MapGet("/me/classes", MyClassesAsync).Doc("ListMyClasses", "Classes the student belongs to");
        g.MapDelete("/me/classes/{classId:guid}", LeaveAsync).WithProblems(404).Doc("LeaveClass", "Leave a class");
    }

    public static string InviteStatus(DateTime? acceptedAt, DateTime? revokedAt, DateTime expiresAt, string validName = InviteStatuses.Valid) =>
        revokedAt is not null ? InviteStatuses.Revoked
        : acceptedAt is not null ? InviteStatuses.Accepted
        : expiresAt <= DateTime.UtcNow ? InviteStatuses.Expired
        : validName;

    /// <summary>Adds (or re-activates) the membership, enrols in the course and sets the active course when empty.</summary>
    public static async Task<JoinClassResponse> JoinAsync(AppDbContext db, Guid userId, CourseClass cls, string via, CancellationToken ct)
    {
        var now = DateTime.UtcNow;
        var member = await db.ClassMembers.FirstOrDefaultAsync(m => m.ClassId == cls.Id && m.UserId == userId, ct);
        var changed = false;
        if (member is null)
        {
            db.ClassMembers.Add(new ClassMember { ClassId = cls.Id, UserId = userId, JoinedAt = now, JoinedVia = via });
            changed = true;
        }
        else if (member.RemovedAt is not null)
        {
            member.RemovedAt = null;
            member.JoinedAt = now;
            member.JoinedVia = via;
            changed = true;
        }
        var prefs = await db.UserPreferences.FirstOrDefaultAsync(p => p.UserId == userId, ct);
        if (prefs is null) { prefs = new UserPreference { UserId = userId }; db.UserPreferences.Add(prefs); }
        prefs.ActiveCourseId ??= cls.CourseId;
        if (changed) db.Audit(userId, AuditActions.ClassJoined, "class", cls.Id, new { via });
        await db.SaveChangesAsync(ct);
        await CoursesEndpoints.EnsureEnrollmentAsync(db, userId, cls.CourseId, ct);
        var summary = (await CoursesEndpoints.SummariesAsync(db, userId, db.Courses.Where(c => c.Id == cls.CourseId), ct)).Single();
        return new JoinClassResponse(cls.Id, cls.Name, summary);
    }

    private static async Task<JoinClassResponse> JoinByCodeAsync(JoinClassRequest req, HttpContext ctx, AppDbContext db, ILogger<JoinClassRequest> logger,
        CancellationToken ct)
    {
        var code = JoinCodes.Normalize(req.Code);
        var cls = code is null ? null : await db.Classes.FirstOrDefaultAsync(c => c.JoinCode == code && c.ArchivedAt == null, ct);
        if (cls is null) throw new AppException(404, ErrorCodes.ClassCodeInvalid, "We couldn't find a class with that code. Check it with your instructor.");
        if (!cls.JoinEnabled) throw new AppException(409, ErrorCodes.ClassJoinDisabled, "Joining this class is turned off. Ask your instructor.");
        var result = await JoinAsync(db, ctx.User.GetUserId(), cls, ClassJoinMethods.Code, ct);
        logger.LogInformation(ClassEvent, "Student joined class {class_id} by code", cls.Id);
        return result;
    }

    private static async Task<ClassInviteLookupDto> LookupInviteAsync(string token, AppDbContext db, CancellationToken ct)
    {
        var hash = SecureTokens.Hash(token);
        var row = await (from i in db.ClassInvites
                         join k in db.Classes on i.ClassId equals k.Id
                         join c in db.Courses on k.CourseId equals c.Id
                         join u in db.Users on i.InvitedBy equals u.Id into inviters
                         from u in inviters.DefaultIfEmpty()
                         where i.TokenHash == hash
                         select new { i, k.Name, k.ArchivedAt, CourseTitle = c.Title, Inviter = u == null ? null : u.DisplayName })
                  .AsNoTracking().FirstOrDefaultAsync(ct)
                  ?? throw AppException.NotFound("This invitation link is not valid.");
        var status = row.ArchivedAt is not null && row.i.AcceptedAt is null && row.i.RevokedAt is null
            ? InviteStatuses.Expired
            : InviteStatus(row.i.AcceptedAt, row.i.RevokedAt, row.i.ExpiresAt);
        return new ClassInviteLookupDto(row.Name, row.CourseTitle, row.Inviter ?? "Your instructor", EmailAddresses.Mask(row.i.EmailNormalized), status);
    }

    private static async Task<JoinClassResponse> AcceptInviteAsync(string token, HttpContext ctx, AppDbContext db, UserManager<AppUser> users,
        ILogger<JoinClassRequest> logger, CancellationToken ct)
    {
        var userId = ctx.User.GetUserId();
        var hash = SecureTokens.Hash(token);
        var invite = await db.ClassInvites.FirstOrDefaultAsync(i => i.TokenHash == hash, ct) ?? throw AppException.NotFound("This invitation link is not valid.");
        var cls = await db.Classes.FirstAsync(k => k.Id == invite.ClassId, ct);

        if (invite.AcceptedAt is not null)
        {
            if (invite.AcceptedUserId == userId) return await JoinAsync(db, userId, cls, ClassJoinMethods.Invite, ct);
            throw new AppException(410, ErrorCodes.ClassInviteExpired, "This invitation has already been used.");
        }
        if (invite.RevokedAt is not null || invite.ExpiresAt <= DateTime.UtcNow || cls.ArchivedAt is not null)
            throw new AppException(410, ErrorCodes.ClassInviteExpired, "This invitation has expired. Ask your instructor for a new one.");

        var user = await users.FindByIdAsync(userId.ToString()) ?? throw new AppException(401, ErrorCodes.AuthUnauthenticated, "Please sign in.");
        if (!string.Equals(EmailAddresses.Normalize(user.Email ?? ""), invite.EmailNormalized, StringComparison.Ordinal))
            throw new AppException(403, ErrorCodes.ClassInviteEmailMismatch,
                $"This invitation was sent to {EmailAddresses.Mask(invite.EmailNormalized)}. Sign in with that email address to accept it.");

        invite.AcceptedAt = DateTime.UtcNow;
        invite.AcceptedUserId = userId;
        var result = await JoinAsync(db, userId, cls, ClassJoinMethods.Invite, ct);
        logger.LogInformation(ClassEvent, "Student accepted an invitation to class {class_id}", cls.Id);
        return result;
    }

    private static async Task<List<MyClassDto>> MyClassesAsync(HttpContext ctx, AppDbContext db, CancellationToken ct)
    {
        var userId = ctx.User.GetUserId();
        return await (from m in CourseAccess.ActiveMemberships(db)
                      join k in db.Classes on m.ClassId equals k.Id
                      join c in db.Courses on k.CourseId equals c.Id
                      where m.UserId == userId
                      orderby m.JoinedAt descending
                      select new MyClassDto(k.Id, k.Name, new IdTitle(c.Id, c.Title), m.JoinedAt)).AsNoTracking().ToListAsync(ct);
    }

    private static async Task<NoContent> LeaveAsync(Guid classId, HttpContext ctx, AppDbContext db, ILogger<JoinClassRequest> logger, CancellationToken ct)
    {
        var viewer = ctx.User.Viewer();
        var member = await db.ClassMembers.FirstOrDefaultAsync(m => m.ClassId == classId && m.UserId == viewer.UserId && m.RemovedAt == null, ct)
                     ?? throw AppException.NotFound("You're not in that class.");
        member.RemovedAt = DateTime.UtcNow;
        db.Audit(viewer.UserId, AuditActions.ClassLeft, "class", classId);
        await db.SaveChangesAsync(ct);
        await ClearInaccessibleActiveCourseAsync(db, viewer, ct);
        logger.LogInformation(ClassEvent, "Student left class {class_id}", classId);
        return TypedResults.NoContent();
    }

    /// <summary>After losing access (leave/removal/archive), an active course the user can no longer open is cleared.</summary>
    public static async Task ClearInaccessibleActiveCourseAsync(AppDbContext db, CourseViewer viewer, CancellationToken ct)
    {
        var prefs = await db.UserPreferences.FirstOrDefaultAsync(p => p.UserId == viewer.UserId, ct);
        if (prefs?.ActiveCourseId is { } active && !await CourseAccess.CanSeeAsync(db, viewer, active, ct))
        {
            prefs.ActiveCourseId = null;
            await db.SaveChangesAsync(ct);
        }
    }
}
