using System.Text.Json;
using FluentValidation;
using Microsoft.AspNetCore.Http.HttpResults;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Options;
using Sathi.Api.Infrastructure;
using Sathi.Core.Access;
using Sathi.Core.Ai;
using Sathi.Core.Data;
using Sathi.Core.Domain;
using Sathi.Core.Errors;
using Sathi.Core.Jobs;
using Sathi.Core.Options;
using Sathi.Core.Security;
using Sathi.Core.Usage;

namespace Sathi.Api.Modules.Tutor;

public sealed record CreateConversationRequest(Guid CourseId, Guid? LessonId);
public sealed record FeedbackRequest(int Rating, string? Comment);

public sealed record MessageDto(
    Guid Id, string Role, string Content, string Level, string Mode, string? Adjust, bool WebSearch, IReadOnlyList<Citation> Citations,
    IReadOnlyList<string> AnswerBasis, string Status, string? ErrorCode, string? ReferenceId, int? Feedback, DateTime CreatedAt);

public sealed record ConversationListItemDto(Guid Id, string Title, Guid CourseId, Guid? LessonId, DateTime UpdatedAt, string? LastMessagePreview);
public sealed record ConversationCreatedDto(Guid Id, string Title, Guid CourseId, Guid? LessonId, DateTime CreatedAt);
public sealed record ConversationDetailDto(Guid Id, string Title, Guid CourseId, Guid? LessonId, string? LessonTitle, IReadOnlyList<MessageDto> Messages);

public sealed class CreateConversationValidator : AbstractValidator<CreateConversationRequest>
{
    public CreateConversationValidator() => RuleFor(x => x.CourseId).NotEmpty().WithMessage("Course is required.");
}

public sealed class StreamMessageValidator : AbstractValidator<StreamMessageRequest>
{
    public StreamMessageValidator()
    {
        RuleFor(x => x.Level).Must(l => Levels.All.Contains(l)).WithMessage("Level must be beginner, intermediate or advanced.");
        RuleFor(x => x.Mode).Must(m => TutorModes.All.Contains(m)).WithMessage("Mode must be explain, hint or quiz_me.");
        RuleFor(x => x.Adjust).Must(a => a is null || Adjustments.All.Contains(a)).WithMessage("Adjust must be simpler or harder.");
        RuleFor(x => x.Content).NotEmpty().WithMessage("Ask a question.").When(x => x.Adjust is null);
        RuleFor(x => x.Content).MaximumLength(4000).WithMessage("Questions can be at most 4000 characters.");
        RuleFor(x => x.ReplyToMessageId).NotEmpty().WithMessage("Choose the answer to re-explain.").When(x => x.Adjust is not null);
    }
}

public sealed class FeedbackValidator : AbstractValidator<FeedbackRequest>
{
    public FeedbackValidator()
    {
        RuleFor(x => x.Rating).Must(r => r is 1 or -1).WithMessage("Rating must be 1 or -1.");
        RuleFor(x => x.Comment).MaximumLength(1000);
    }
}

public static class TutorEndpoints
{
    private static readonly EventId CancelEvent = new(3102, "tutor.cancel");

    public static void MapTutor(this RouteGroupBuilder api)
    {
        var g = api.MapGroup("").WithTags("Tutor").WithProblems(401);
        g.MapGet("/conversations", ListAsync).WithProblems(400, 404).Doc("ListConversations", "The student's conversations, newest first (cursor paging)");
        g.MapPost("/conversations", CreateAsync).Validate<CreateConversationRequest>().WithProblems(400, 404)
            .Doc("CreateConversation", "Start a conversation for a course (optionally a lesson)");
        g.MapGet("/conversations/{id:guid}", GetAsync).WithProblems(404)
            .Doc("GetConversation", "Conversation with its messages (stale streams are reported as failed/STREAM_INTERRUPTED)");
        g.MapDelete("/conversations/{id:guid}", DeleteAsync).WithProblems(404).Doc("DeleteConversation", "Delete a conversation");
        g.MapPost("/conversations/{id:guid}/messages/stream",
                (Guid id, StreamMessageRequest body, HttpContext ctx, TutorStreamService svc) => svc.StreamAsync(ctx, id, body))
            .Validate<StreamMessageRequest>()
            .Produces<string>(StatusCodes.Status200OK, "text/event-stream")
            .WithProblems(400, 404, 409, 429)
            .Doc("StreamMessage", "Ask the tutor; the answer streams back as server-sent events (start, status, token, citation, usage, done | error)");
        g.MapPost("/conversations/{id:guid}/messages/{messageId:guid}/cancel", CancelAsync).WithProblems(404)
            .Doc("CancelMessage", "Stop a streaming answer; the text so far is kept with status 'cancelled' (idempotent)");
        g.MapPost("/messages/{messageId:guid}/feedback", FeedbackAsync).Validate<FeedbackRequest>().WithProblems(400, 404)
            .Doc("RateMessage", "Thumbs up/down on an answer");
    }

    /// <summary>The user's conversation whose course they can still open (404 otherwise).</summary>
    private static async Task<Conversation> OwnedVisibleAsync(AppDbContext db, HttpContext ctx, Guid id, bool track, CancellationToken ct)
    {
        var userId = ctx.User.GetUserId();
        var visible = CourseAccess.Visible(db, ctx.User.Viewer());
        var q = db.Conversations.Where(x => x.Id == id && x.UserId == userId && x.DeletedAt == null && visible.Any(c => c.Id == x.CourseId));
        return await (track ? q : q.AsNoTracking()).FirstOrDefaultAsync(ct) ?? throw AppException.NotFound("Conversation not found.");
    }

    private static async Task<Page<ConversationListItemDto>> ListAsync(Guid? courseId, string? cursor, int? limit, HttpContext ctx, AppDbContext db,
        CancellationToken ct)
    {
        var userId = ctx.User.GetUserId();
        var take = Cursor.Limit(limit);
        var after = Cursor.DecodeKeyset(cursor);
        var visible = CourseAccess.Visible(db, ctx.User.Viewer());
        var q = db.Conversations.AsNoTracking().Where(c => c.UserId == userId && c.DeletedAt == null && visible.Any(v => v.Id == c.CourseId));
        if (courseId is { } cid)
        {
            await CoursesEndpoints.EnsureVisibleAsync(db, ctx, cid, ct);
            q = q.Where(c => c.CourseId == cid);
        }
        if (after is { } k)
        {
            var at = k.At;
            if (k.Id is { } lastId) q = q.Where(c => c.UpdatedAt < at || (c.UpdatedAt == at && c.Id.CompareTo(lastId) < 0));
            else q = q.Where(c => c.UpdatedAt < at);
        }
        var rows = await q.OrderByDescending(c => c.UpdatedAt).ThenByDescending(c => c.Id).Take(take + 1)
            .Select(c => new
            {
                c.Id, c.Title, c.CourseId, c.LessonId, c.UpdatedAt,
                Last = db.Messages.Where(m => m.ConversationId == c.Id && m.Content != "").OrderByDescending(m => m.CreatedAt).Select(m => m.Content).FirstOrDefault(),
            })
            .ToListAsync(ct);
        var items = rows.Take(take).Select(r => new ConversationListItemDto(r.Id, r.Title, r.CourseId, r.LessonId, r.UpdatedAt,
            r.Last is null ? null : r.Last.Length <= 120 ? r.Last : r.Last[..117] + "…")).ToList();
        var next = rows.Count > take ? Cursor.EncodeKeyset(rows[take - 1].UpdatedAt, rows[take - 1].Id) : null;
        return new Page<ConversationListItemDto>(items, next);
    }

    private static async Task<Created<ConversationCreatedDto>> CreateAsync(CreateConversationRequest req, HttpContext ctx, AppDbContext db, CancellationToken ct)
    {
        var userId = ctx.User.GetUserId();
        await CoursesEndpoints.GetVisibleCourseAsync(db, ctx, req.CourseId, ct);
        if (req.LessonId is { } lid && !await db.Lessons.AnyAsync(l => l.Id == lid && l.Module!.CourseId == req.CourseId, ct))
            throw AppException.Validation("lessonId", "That lesson is not part of this course.");
        await CoursesEndpoints.EnsureEnrollmentAsync(db, userId, req.CourseId, ct);

        var c = new Conversation { UserId = userId, CourseId = req.CourseId, LessonId = req.LessonId };
        db.Conversations.Add(c);
        await db.SaveChangesAsync(ct);
        return TypedResults.Created($"/api/v1/conversations/{c.Id}", new ConversationCreatedDto(c.Id, c.Title, c.CourseId, c.LessonId, c.CreatedAt));
    }

    private static async Task<ConversationDetailDto> GetAsync(Guid id, HttpContext ctx, AppDbContext db, ActiveTutorRuns runs, IOptions<TutorOptions> tutor,
        ILogger<CreateConversationRequest> logger, CancellationToken ct)
    {
        var userId = ctx.User.GetUserId();
        var c = await OwnedVisibleAsync(db, ctx, id, track: false, ct);

        // Contract §11.5: a stream still "streaming" after Tutor:StaleStreamMinutes that is not live on this instance is interrupted.
        var interrupted = await StaleStreams.InterruptAsync(db, TimeSpan.FromMinutes(tutor.Value.StaleStreamMinutes), id, runs.IsActive, ct);
        if (interrupted.Count > 0)
            logger.LogWarning(CancelEvent, "Marked {count} stale tutor streams as {error_code}", interrupted.Count, ErrorCodes.StreamInterrupted);

        var lessonTitle = c.LessonId is { } lid ? await db.Lessons.Where(l => l.Id == lid).Select(l => l.Title).FirstOrDefaultAsync(ct) : null;
        var messages = await db.Messages.AsNoTracking().Where(m => m.ConversationId == id).OrderBy(m => m.CreatedAt).ToListAsync(ct);
        var runIds = messages.Where(m => m.RunId != null).Select(m => m.RunId!.Value).ToList();
        var refs = await db.AiRuns.AsNoTracking().Where(r => runIds.Contains(r.Id)).ToDictionaryAsync(r => r.Id, r => r.ReferenceId, ct);
        var messageIds = messages.Select(m => m.Id).ToList();
        var feedback = await db.MessageFeedback.AsNoTracking().Where(f => f.UserId == userId && messageIds.Contains(f.MessageId))
            .ToDictionaryAsync(f => f.MessageId, f => (int)f.Rating, ct);

        return new ConversationDetailDto(c.Id, c.Title, c.CourseId, c.LessonId, lessonTitle,
            messages.Select(m => ToDto(m, m.RunId is { } r && refs.TryGetValue(r, out var rf) ? rf : null,
                feedback.TryGetValue(m.Id, out var fb) ? fb : null)).ToList());
    }

    public static MessageDto ToDto(Message m, string? reference, int? feedback) => new(
        m.Id, m.Role, m.Content, m.Level, m.Mode, m.Adjust, m.WebSearch,
        JsonSerializer.Deserialize<List<Citation>>(string.IsNullOrEmpty(m.CitationsJson) ? "[]" : m.CitationsJson, AiJson.Options) ?? [],
        m.AnswerBasis, m.Status, m.ErrorCode, reference is null ? null : ReferenceId.Format(reference), feedback, m.CreatedAt);

    private static async Task<NoContent> DeleteAsync(Guid id, HttpContext ctx, AppDbContext db, CancellationToken ct)
    {
        // Deliberately not access-checked: a student can always delete their own conversation, even after leaving a class.
        var userId = ctx.User.GetUserId();
        var c = await db.Conversations.FirstOrDefaultAsync(x => x.Id == id && x.UserId == userId && x.DeletedAt == null, ct)
                ?? throw AppException.NotFound("Conversation not found.");
        c.DeletedAt = DateTime.UtcNow;
        await db.SaveChangesAsync(ct);
        return TypedResults.NoContent();
    }

    /// <summary>
    /// Contract §11.5: if the stream is live on this instance its upstream request is aborted and the stream handler saves the partial
    /// text as "cancelled"; otherwise a message still "streaming" is marked cancelled directly. Idempotent.
    /// </summary>
    private static async Task<Accepted> CancelAsync(Guid id, Guid messageId, HttpContext ctx, AppDbContext db, ActiveTutorRuns runs,
        ILogger<CreateConversationRequest> logger, CancellationToken ct)
    {
        var userId = ctx.User.GetUserId();
        var convo = await OwnedVisibleAsync(db, ctx, id, track: false, ct);
        var message = await db.Messages.FirstOrDefaultAsync(m => m.Id == messageId && m.ConversationId == convo.Id && m.Role == MessageRoles.Assistant, ct)
                      ?? throw AppException.NotFound("Message not found.");

        if (runs.TryCancel(messageId))
        {
            logger.LogInformation(CancelEvent, "Cancel requested for live stream {message_id}", messageId);
        }
        else if (message.Status == MessageStatuses.Streaming)
        {
            var now = DateTime.UtcNow;
            message.Status = MessageStatuses.Cancelled;
            message.CompletedAt = now;
            if (message.RunId is { } runId && await db.AiRuns.FirstOrDefaultAsync(r => r.Id == runId && r.Status == AiRunStatuses.Running, ct) is { } run)
            {
                run.Status = AiRunStatuses.Cancelled;
                run.FinishedAt = now;
                run.LatencyMs = (int)Math.Min(int.MaxValue, (now - run.StartedAt).TotalMilliseconds);
                run.ErrorMessage = "Cancelled by the user (stream not active on this instance).";
            }
            db.Audit(userId, AuditActions.MessageCancelled, "message", message.Id, new { live = false });
            await db.SaveChangesAsync(ct);
            logger.LogInformation(CancelEvent, "Stream {message_id} not active on this instance; marked cancelled", messageId);
        }
        return TypedResults.Accepted((string?)null);
    }

    private static async Task<NoContent> FeedbackAsync(Guid messageId, FeedbackRequest req, HttpContext ctx, AppDbContext db, CancellationToken ct)
    {
        var userId = ctx.User.GetUserId();
        var visible = CourseAccess.Visible(db, ctx.User.Viewer());
        var owned = await db.Messages.AnyAsync(m => m.Id == messageId && m.Role == MessageRoles.Assistant
            && db.Conversations.Any(c => c.Id == m.ConversationId && c.UserId == userId && c.DeletedAt == null && visible.Any(v => v.Id == c.CourseId)), ct);
        if (!owned) throw AppException.NotFound("Message not found.");

        var f = await db.MessageFeedback.FirstOrDefaultAsync(x => x.MessageId == messageId && x.UserId == userId, ct);
        if (f is null) { f = new MessageFeedback { MessageId = messageId, UserId = userId }; db.MessageFeedback.Add(f); }
        f.Rating = (short)req.Rating;
        f.Comment = string.IsNullOrWhiteSpace(req.Comment) ? null : req.Comment.Trim();
        f.CreatedAt = DateTime.UtcNow;
        await db.SaveChangesAsync(ct);
        return TypedResults.NoContent();
    }
}
