using FluentValidation;
using Microsoft.AspNetCore.Http.HttpResults;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Options;
using Npgsql;
using Sathi.Api.Infrastructure;
using Sathi.Core.Access;
using Sathi.Core.Data;
using Sathi.Core.Domain;
using Sathi.Core.Email;
using Sathi.Core.Errors;
using Sathi.Core.Options;
using Sathi.Core.Usage;

namespace Sathi.Api.Modules;

public sealed record CreateClassRequest(string Name, string? Description);
public sealed record UpdateClassRequest(string Name, string? Description, bool JoinEnabled);
public sealed record ClassInvitesRequest(List<string> Emails);

/// <summary>Contract §11.1 ClassSummary (joinCode displayed XXXX-XXXX).</summary>
public sealed record ClassSummaryDto(Guid Id, Guid CourseId, string Name, string? Description, string JoinCode, bool JoinEnabled, int MemberCount,
    int PendingInvites, DateTime CreatedAt, DateTime? ArchivedAt);
public sealed record ClassMemberDto(Guid UserId, string DisplayName, string Email, DateTime JoinedAt, string JoinedVia, DateTime? LastActiveAt,
    double? AverageMastery);
public sealed record ClassInvitesResultDto(int Invited, IReadOnlyList<string> AlreadyMembers, IReadOnlyList<string> Invalid);
public sealed record ClassInviteDto(Guid Id, string Email, DateTime CreatedAt, DateTime ExpiresAt, string Status);

public sealed class CreateClassValidator : AbstractValidator<CreateClassRequest>
{
    public CreateClassValidator()
    {
        RuleFor(x => x.Name).NotEmpty().WithMessage("Name the class.").MaximumLength(120);
        RuleFor(x => x.Description).MaximumLength(1000);
    }
}

public sealed class UpdateClassValidator : AbstractValidator<UpdateClassRequest>
{
    public UpdateClassValidator()
    {
        RuleFor(x => x.Name).NotEmpty().WithMessage("Name the class.").MaximumLength(120);
        RuleFor(x => x.Description).MaximumLength(1000);
    }
}

public sealed class ClassInvitesValidator : AbstractValidator<ClassInvitesRequest>
{
    public ClassInvitesValidator() =>
        RuleFor(x => x.Emails).NotNull().Must(e => e is { Count: >= 1 and <= 100 }).WithMessage("Invite between 1 and 100 email addresses at a time.");
}

/// <summary>Instructor class management (contract §11.1). Course instructors of the class's course, or Admin.</summary>
public static class InstructorClassesEndpoints
{
    private static readonly EventId ClassAdmin = new(3402, "class.admin");
    public static readonly TimeSpan InviteLifetime = TimeSpan.FromDays(14);

    public static void MapInstructorClasses(this RouteGroupBuilder api)
    {
        var g = api.MapGroup("/instructor").RequireAuthorization("Staff").WithTags("Instructor classes").WithProblems(401, 403, 404);
        g.MapGet("/courses/{courseId:guid}/classes", ListAsync).Doc("ListClasses", "Classes of a managed course");
        g.MapPost("/courses/{courseId:guid}/classes", CreateAsync).Validate<CreateClassRequest>().WithProblems(400).Doc("CreateClass", "Create a class with a fresh join code");
        g.MapPut("/classes/{id:guid}", UpdateAsync).Validate<UpdateClassRequest>().WithProblems(400).Doc("UpdateClass", "Rename, describe, enable/disable joining");
        g.MapPost("/classes/{id:guid}/regenerate-code", RegenerateAsync).Doc("RegenerateClassCode", "Replace the join code (the old one stops working)");
        g.MapPost("/classes/{id:guid}/archive", (Guid id, HttpContext ctx, AppDbContext db, CancellationToken ct) => SetArchivedAsync(id, true, ctx, db, ct))
            .Doc("ArchiveClass", "Archive a class (its members lose access through it)");
        g.MapPost("/classes/{id:guid}/unarchive", (Guid id, HttpContext ctx, AppDbContext db, CancellationToken ct) => SetArchivedAsync(id, false, ctx, db, ct))
            .Doc("UnarchiveClass", "Restore an archived class");
        g.MapGet("/classes/{id:guid}/members", MembersAsync).Doc("ListClassMembers", "Active members with last activity and average mastery");
        g.MapDelete("/classes/{id:guid}/members/{userId:guid}", RemoveMemberAsync).Doc("RemoveClassMember", "Remove a student from the class");
        g.MapPost("/classes/{id:guid}/invites", InviteAsync).Validate<ClassInvitesRequest>().WithProblems(400, 409)
            .Doc("InviteToClass", "Email invitations (≤ 100 addresses); each address gets its own link");
        g.MapGet("/classes/{id:guid}/invites", ListInvitesAsync).Doc("ListClassInvites", "Invitations of a class with their status");
        g.MapDelete("/invites/{inviteId:guid}", RevokeInviteAsync).Doc("RevokeClassInvite", "Revoke a pending invitation");
        g.MapPost("/invites/{inviteId:guid}/resend", ResendInviteAsync).WithProblems(409).Doc("ResendClassInvite", "Send a pending invitation again with a new link");
    }

    // ---------------- helpers ----------------

    private static async Task<CourseClass> ManagedClassAsync(AppDbContext db, HttpContext ctx, Guid classId, CancellationToken ct)
    {
        var manageable = CourseAccess.Manageable(db, ctx.User.Viewer()).Select(c => c.Id);
        return await db.Classes.FirstOrDefaultAsync(k => k.Id == classId && manageable.Contains(k.CourseId), ct)
               ?? throw AppException.NotFound("Class not found.");
    }

    private static async Task<List<ClassSummaryDto>> SummariesAsync(AppDbContext db, IQueryable<CourseClass> classes, CancellationToken ct)
    {
        var now = DateTime.UtcNow;
        var rows = await classes.AsNoTracking().OrderBy(k => k.ArchivedAt != null).ThenBy(k => k.Name).Select(k => new
            {
                k,
                Members = db.ClassMembers.Count(m => m.ClassId == k.Id && m.RemovedAt == null),
                Pending = db.ClassInvites.Count(i => i.ClassId == k.Id && i.AcceptedAt == null && i.RevokedAt == null && i.ExpiresAt > now),
            })
            .ToListAsync(ct);
        return rows.Select(r => ToSummary(r.k, r.Members, r.Pending)).ToList();
    }

    private static ClassSummaryDto ToSummary(CourseClass k, int members, int pending) =>
        new(k.Id, k.CourseId, k.Name, k.Description, JoinCodes.Format(k.JoinCode), k.JoinEnabled, members, pending, k.CreatedAt, k.ArchivedAt);

    private static async Task<ClassSummaryDto> SummaryAsync(AppDbContext db, Guid classId, CancellationToken ct) =>
        (await SummariesAsync(db, db.Classes.Where(k => k.Id == classId), ct)).Single();

    /// <summary>Saves with a new unique join code (retries on the rare collision).</summary>
    private static async Task SaveWithNewCodeAsync(AppDbContext db, CourseClass cls, CancellationToken ct)
    {
        for (var attempt = 1; ; attempt++)
        {
            string code;
            do code = JoinCodes.Generate();
            while (await db.Classes.AnyAsync(k => k.JoinCode == code, ct));
            cls.JoinCode = code;
            try
            {
                await db.SaveChangesAsync(ct);
                return;
            }
            catch (DbUpdateException ex) when (attempt < 5 && ex.InnerException is PostgresException { SqlState: PostgresErrorCodes.UniqueViolation })
            {
                // Someone took the same code between the check and the insert; try another.
            }
        }
    }

    private static string InviteLink(AppUrlOptions app, string rawToken) => $"{app.BaseUrl.TrimEnd('/')}/join/{rawToken}";

    private static async Task SendInviteAsync(IAppEmailSender email, AppUrlOptions app, ClassInvite invite, string rawToken, CourseClass cls,
        string courseTitle, string inviterName, ILogger logger, CancellationToken ct)
    {
        try
        {
            await email.SendAsync(EmailTemplates.ClassInvite(invite.EmailNormalized, cls.Name, courseTitle, inviterName, InviteLink(app, rawToken), invite.ExpiresAt), ct);
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            logger.LogWarning(ClassAdmin, ex, "Class invitation email could not be sent (invite {invite_id})", invite.Id);
        }
    }

    // ---------------- classes ----------------

    private static async Task<List<ClassSummaryDto>> ListAsync(Guid courseId, HttpContext ctx, AppDbContext db, CancellationToken ct)
    {
        await InstructorEndpoints.EditableCourseAsync(db, ctx, courseId, ct);
        return await SummariesAsync(db, db.Classes.Where(k => k.CourseId == courseId), ct);
    }

    private static async Task<Created<ClassSummaryDto>> CreateAsync(Guid courseId, CreateClassRequest req, HttpContext ctx, AppDbContext db, CancellationToken ct)
    {
        await InstructorEndpoints.EditableCourseAsync(db, ctx, courseId, ct);
        var userId = ctx.User.GetUserId();
        var cls = new CourseClass
        {
            CourseId = courseId, Name = req.Name.Trim(), Description = string.IsNullOrWhiteSpace(req.Description) ? null : req.Description.Trim(),
            JoinEnabled = true, CreatedBy = userId, CreatedAt = DateTime.UtcNow,
        };
        db.Classes.Add(cls);
        db.Audit(userId, AuditActions.ClassCreated, "class", cls.Id, new { courseId });
        await SaveWithNewCodeAsync(db, cls, ct);
        return TypedResults.Created($"/api/v1/instructor/classes/{cls.Id}", ToSummary(cls, 0, 0));
    }

    private static async Task<ClassSummaryDto> UpdateAsync(Guid id, UpdateClassRequest req, HttpContext ctx, AppDbContext db, CancellationToken ct)
    {
        var cls = await ManagedClassAsync(db, ctx, id, ct);
        cls.Name = req.Name.Trim();
        cls.Description = string.IsNullOrWhiteSpace(req.Description) ? null : req.Description.Trim();
        if (cls.JoinEnabled != req.JoinEnabled)
            db.Audit(ctx.User.GetUserId(), AuditActions.ClassUpdated, "class", cls.Id, new { joinEnabled = req.JoinEnabled });
        cls.JoinEnabled = req.JoinEnabled;
        await db.SaveChangesAsync(ct);
        return await SummaryAsync(db, id, ct);
    }

    private static async Task<ClassSummaryDto> RegenerateAsync(Guid id, HttpContext ctx, AppDbContext db, CancellationToken ct)
    {
        var cls = await ManagedClassAsync(db, ctx, id, ct);
        db.Audit(ctx.User.GetUserId(), AuditActions.ClassCodeRegenerated, "class", cls.Id);
        await SaveWithNewCodeAsync(db, cls, ct);
        return await SummaryAsync(db, id, ct);
    }

    private static async Task<ClassSummaryDto> SetArchivedAsync(Guid id, bool archived, HttpContext ctx, AppDbContext db, CancellationToken ct)
    {
        var cls = await ManagedClassAsync(db, ctx, id, ct);
        if (archived && cls.ArchivedAt is null)
        {
            cls.ArchivedAt = DateTime.UtcNow;
            db.Audit(ctx.User.GetUserId(), AuditActions.ClassArchived, "class", cls.Id);
        }
        else if (!archived && cls.ArchivedAt is not null)
        {
            cls.ArchivedAt = null;
            db.Audit(ctx.User.GetUserId(), AuditActions.ClassUnarchived, "class", cls.Id);
        }
        await db.SaveChangesAsync(ct);
        return await SummaryAsync(db, id, ct);
    }

    // ---------------- members ----------------

    private static async Task<List<ClassMemberDto>> MembersAsync(Guid id, HttpContext ctx, AppDbContext db, CancellationToken ct)
    {
        var cls = await ManagedClassAsync(db, ctx, id, ct);
        var conceptIds = db.Concepts.Where(c => c.CourseId == cls.CourseId).Select(c => c.Id);
        var rows = await (from m in db.ClassMembers
                          join u in db.Users on m.UserId equals u.Id
                          where m.ClassId == id && m.RemovedAt == null
                          orderby u.DisplayName
                          select new
                          {
                              u.Id, u.DisplayName, u.Email, m.JoinedAt, m.JoinedVia, u.LastActiveAt,
                              Mastery = db.ConceptMastery.Where(x => x.UserId == u.Id && conceptIds.Contains(x.ConceptId)).Average(x => (double?)x.Mastery),
                          }).AsNoTracking().ToListAsync(ct);
        return rows.Select(r => new ClassMemberDto(r.Id, r.DisplayName, r.Email ?? "", r.JoinedAt, r.JoinedVia, r.LastActiveAt,
            r.Mastery is { } v ? Math.Round(v, 4) : null)).ToList();
    }

    private static async Task<NoContent> RemoveMemberAsync(Guid id, Guid userId, HttpContext ctx, AppDbContext db, ILogger<CreateClassRequest> logger,
        CancellationToken ct)
    {
        var cls = await ManagedClassAsync(db, ctx, id, ct);
        var member = await db.ClassMembers.FirstOrDefaultAsync(m => m.ClassId == cls.Id && m.UserId == userId && m.RemovedAt == null, ct)
                     ?? throw AppException.NotFound("That student isn't in this class.");
        member.RemovedAt = DateTime.UtcNow;
        db.Audit(ctx.User.GetUserId(), AuditActions.ClassMemberRemoved, "class", cls.Id, new { userId });
        await db.SaveChangesAsync(ct);
        logger.LogInformation(ClassAdmin, "Member removed from class {class_id}", cls.Id);
        return TypedResults.NoContent();
    }

    // ---------------- invites ----------------

    private static async Task<ClassInvitesResultDto> InviteAsync(Guid id, ClassInvitesRequest req, HttpContext ctx, AppDbContext db, IAppEmailSender email,
        IOptions<AppUrlOptions> app, ILogger<CreateClassRequest> logger, CancellationToken ct)
    {
        var cls = await ManagedClassAsync(db, ctx, id, ct);
        if (cls.ArchivedAt is not null) throw AppException.Conflict("Unarchive the class before inviting students.");
        var courseTitle = await db.Courses.Where(c => c.Id == cls.CourseId).Select(c => c.Title).FirstAsync(ct);
        var inviterId = ctx.User.GetUserId();
        var inviterName = await db.Users.Where(u => u.Id == inviterId).Select(u => u.DisplayName).FirstOrDefaultAsync(ct) ?? "Your instructor";

        var invalid = new List<string>();
        var wanted = new List<string>();
        foreach (var raw in req.Emails)
        {
            var trimmed = (raw ?? "").Trim();
            if (!EmailAddresses.IsValid(trimmed)) { if (trimmed.Length > 0) invalid.Add(trimmed); continue; }
            var normalized = EmailAddresses.Normalize(trimmed);
            if (!wanted.Contains(normalized)) wanted.Add(normalized);
        }

        var upper = wanted.Select(e => e.ToUpperInvariant()).ToList();
        var members = await (from m in db.ClassMembers
                             join u in db.Users on m.UserId equals u.Id
                             where m.ClassId == cls.Id && m.RemovedAt == null && upper.Contains(u.NormalizedEmail!)
                             select u.NormalizedEmail!).ToListAsync(ct);
        var alreadyMembers = wanted.Where(e => members.Contains(e.ToUpperInvariant())).ToList();
        var toInvite = wanted.Except(alreadyMembers).ToList();

        var pending = await db.ClassInvites.Where(i => i.ClassId == cls.Id && toInvite.Contains(i.EmailNormalized) && i.AcceptedAt == null && i.RevokedAt == null)
            .ToDictionaryAsync(i => i.EmailNormalized, ct);
        var now = DateTime.UtcNow;
        var outgoing = new List<(ClassInvite Invite, string Raw)>();
        foreach (var address in toInvite)
        {
            var (raw, hash) = SecureTokens.Create();
            if (!pending.TryGetValue(address, out var invite))
            {
                invite = new ClassInvite { ClassId = cls.Id, EmailNormalized = address, InvitedBy = inviterId, CreatedAt = now };
                db.ClassInvites.Add(invite);
            }
            // A repeated invite refreshes the link and expiry (the old link stops working).
            invite.TokenHash = hash;
            invite.ExpiresAt = now + InviteLifetime;
            invite.InvitedBy = inviterId;
            outgoing.Add((invite, raw));
        }
        if (outgoing.Count > 0) db.Audit(inviterId, AuditActions.ClassInvitesSent, "class", cls.Id, new { count = outgoing.Count });
        await db.SaveChangesAsync(ct);

        foreach (var (invite, raw) in outgoing)
            await SendInviteAsync(email, app.Value, invite, raw, cls, courseTitle, inviterName, logger, ct);
        logger.LogInformation(ClassAdmin, "Class {class_id}: {invited} invitations sent, {already} already members, {invalid} invalid",
            cls.Id, outgoing.Count, alreadyMembers.Count, invalid.Count);
        return new ClassInvitesResultDto(outgoing.Count, alreadyMembers, invalid);
    }

    private static async Task<List<ClassInviteDto>> ListInvitesAsync(Guid id, HttpContext ctx, AppDbContext db, CancellationToken ct)
    {
        var cls = await ManagedClassAsync(db, ctx, id, ct);
        var rows = await db.ClassInvites.AsNoTracking().Where(i => i.ClassId == cls.Id).OrderByDescending(i => i.CreatedAt).Take(1000).ToListAsync(ct);
        return rows.Select(i => new ClassInviteDto(i.Id, i.EmailNormalized, i.CreatedAt, i.ExpiresAt,
            ClassesEndpoints.InviteStatus(i.AcceptedAt, i.RevokedAt, i.ExpiresAt, InviteStatuses.Pending))).ToList();
    }

    private static async Task<ClassInvite> ManagedInviteAsync(AppDbContext db, HttpContext ctx, Guid inviteId, CancellationToken ct)
    {
        var manageable = CourseAccess.Manageable(db, ctx.User.Viewer()).Select(c => c.Id);
        return await db.ClassInvites.FirstOrDefaultAsync(i => i.Id == inviteId && db.Classes.Any(k => k.Id == i.ClassId && manageable.Contains(k.CourseId)), ct)
               ?? throw AppException.NotFound("Invitation not found.");
    }

    private static async Task<NoContent> RevokeInviteAsync(Guid inviteId, HttpContext ctx, AppDbContext db, CancellationToken ct)
    {
        var invite = await ManagedInviteAsync(db, ctx, inviteId, ct);
        if (invite.AcceptedAt is null && invite.RevokedAt is null)
        {
            invite.RevokedAt = DateTime.UtcNow;
            db.Audit(ctx.User.GetUserId(), AuditActions.ClassInviteRevoked, "class_invite", invite.Id, new { invite.ClassId });
            await db.SaveChangesAsync(ct);
        }
        return TypedResults.NoContent();
    }

    private static async Task<NoContent> ResendInviteAsync(Guid inviteId, HttpContext ctx, AppDbContext db, IAppEmailSender email, IOptions<AppUrlOptions> app,
        ILogger<CreateClassRequest> logger, CancellationToken ct)
    {
        var invite = await ManagedInviteAsync(db, ctx, inviteId, ct);
        if (invite.AcceptedAt is not null || invite.RevokedAt is not null)
            throw AppException.Conflict("Only pending invitations can be sent again.");
        var cls = await db.Classes.FirstAsync(k => k.Id == invite.ClassId, ct);
        if (cls.ArchivedAt is not null) throw AppException.Conflict("Unarchive the class before inviting students.");
        var courseTitle = await db.Courses.Where(c => c.Id == cls.CourseId).Select(c => c.Title).FirstAsync(ct);
        var userId = ctx.User.GetUserId();
        var inviterName = await db.Users.Where(u => u.Id == userId).Select(u => u.DisplayName).FirstOrDefaultAsync(ct) ?? "Your instructor";

        var (raw, hash) = SecureTokens.Create();
        invite.TokenHash = hash;
        invite.ExpiresAt = DateTime.UtcNow + InviteLifetime;
        db.Audit(userId, AuditActions.ClassInviteResent, "class_invite", invite.Id, new { invite.ClassId });
        await db.SaveChangesAsync(ct);
        await SendInviteAsync(email, app.Value, invite, raw, cls, courseTitle, inviterName, logger, ct);
        return TypedResults.NoContent();
    }
}
