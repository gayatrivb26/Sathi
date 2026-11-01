using FluentValidation;
using Microsoft.AspNetCore.Http.HttpResults;
using Microsoft.EntityFrameworkCore;
using Sathi.Api.Infrastructure;
using Sathi.Core.Access;
using Sathi.Core.Data;
using Sathi.Core.Domain;
using Sathi.Core.Errors;
using Sathi.Core.Jobs;
using Sathi.Core.Learning;

namespace Sathi.Api.Modules;

public sealed record ClassRef(Guid Id, string Name);

/// <summary>Contract §5.2 + §11.1 (visibility, the student's classes for the course).</summary>
public sealed record CourseSummary(Guid Id, string Slug, string Title, string Description, int ModuleCount, int LessonCount, bool Enrolled,
    bool DiagnosticCompleted, string Visibility, IReadOnlyList<ClassRef> Classes);

public sealed record LessonOutlineDto(Guid Id, string Title, string Summary, int Position, int EstimatedMinutes, string Status, int Percent);
public sealed record ModuleOutlineDto(Guid Id, string Title, string Summary, int Position, IReadOnlyList<LessonOutlineDto> Lessons);
public sealed record ConceptDto(Guid Id, string Slug, string Name, string Description);
public sealed record CourseDetailDto(Guid Id, string Slug, string Title, string Description, string Visibility,
    IReadOnlyList<ModuleOutlineDto> Modules, IReadOnlyList<ConceptDto> Concepts);

public sealed record IdTitle(Guid Id, string Title);
public sealed record IdName(Guid Id, string Name);
public sealed record ModuleRefDto(Guid Id, string Title, int Position);
public sealed record ProgressStateDto(string Status, int Percent);
public sealed record LessonDto(Guid Id, string Title, string Summary, string ContentMarkdown, int EstimatedMinutes, int Position, int LessonCount,
    ModuleRefDto Module, IdTitle Course, IReadOnlyList<string> Objectives, IReadOnlyList<IdName> Concepts, ProgressStateDto Progress,
    Guid? PreviousLessonId, Guid? NextLessonId);

public sealed record ContinueLessonDto(Guid LessonId, string Title, string Summary, string CourseTitle, string ModuleTitle, int ModulePosition,
    int LessonPosition, int LessonCount, int Percent);
public sealed record RevisionSummaryDto(int DueCount, int EstimatedMinutes);
public sealed record HomeDto(IdTitle Course, ContinueLessonDto? ContinueLesson, RevisionSummaryDto Revision, IReadOnlyList<ConceptMasteryDto> Mastery,
    IReadOnlyList<StudyNextItem> StudyNext, int StreakDays);

public sealed record MasteryTrendPoint(string Date, double Average);
public sealed record QuizResultDto(Guid AttemptId, string Title, DateTime? CompletedAt, int Correct, int Total);
public sealed record ProgressDto(IReadOnlyList<ConceptMasteryDto> Mastery, IReadOnlyList<MasteryTrendPoint> MasteryTrend, IReadOnlyList<QuizResultDto> Quizzes,
    int LessonsCompleted, int LessonCount, int StreakDays, int QuestionsAsked);

public sealed record LessonProgressRequest(int Percent, bool Completed);

public sealed class LessonProgressValidator : AbstractValidator<LessonProgressRequest>
{
    public LessonProgressValidator() => RuleFor(x => x.Percent).InclusiveBetween(0, 100);
}

public sealed record ConceptMasteryDto(Guid ConceptId, string Name, double Mastery, int Attempts, bool NeedsWork);

public static class CoursesEndpoints
{
    public static void MapCourses(this RouteGroupBuilder api)
    {
        var g = api.MapGroup("").WithTags("Courses").WithProblems(401, 404);
        g.MapGet("/courses", ListCoursesAsync).Doc("ListCourses", "Course catalogue: public courses and private courses of the student's classes");
        g.MapGet("/courses/{courseId:guid}", GetCourseAsync).Doc("GetCourse", "Course outline with the student's lesson progress");
        g.MapPost("/courses/{courseId:guid}/enroll", EnrollAsync).Doc("EnrollInCourse", "Enrol (idempotent) and make the course active");
        g.MapGet("/lessons/{lessonId:guid}", GetLessonAsync).Doc("GetLesson", "Lesson content, objectives, concepts and navigation");
        g.MapPost("/lessons/{lessonId:guid}/progress", UpdateProgressAsync).Validate<LessonProgressRequest>().WithProblems(400)
            .Doc("UpdateLessonProgress", "Record reading progress or completion");
        g.MapGet("/home", HomeAsync).Doc("GetHome", "Home dashboard for a course (default: the active course)");
        g.MapGet("/progress", ProgressAsync).Doc("GetProgress", "Progress page data for a course (default: the active course)");
    }

    // ---------------- helpers shared with other modules ----------------

    /// <summary>A course the user may open (contract §11.1), else 404 NOT_FOUND.</summary>
    public static async Task<Course> GetVisibleCourseAsync(AppDbContext db, HttpContext ctx, Guid courseId, CancellationToken ct) =>
        await CourseAccess.Visible(db, ctx.User.Viewer()).AsNoTracking().FirstOrDefaultAsync(c => c.Id == courseId, ct)
        ?? throw AppException.NotFound("Course not found.");

    /// <summary>Throws 404 unless the user may open the course.</summary>
    public static async Task EnsureVisibleAsync(AppDbContext db, HttpContext ctx, Guid courseId, CancellationToken ct)
    {
        if (!await CourseAccess.CanSeeAsync(db, ctx.User.Viewer(), courseId, ct)) throw AppException.NotFound("Course not found.");
    }

    public static async Task<Enrollment> EnsureEnrollmentAsync(AppDbContext db, Guid userId, Guid courseId, CancellationToken ct)
    {
        var e = await db.Enrollments.FirstOrDefaultAsync(x => x.UserId == userId && x.CourseId == courseId, ct);
        if (e is not null) return e;
        e = new Enrollment { UserId = userId, CourseId = courseId, EnrolledAt = DateTime.UtcNow };
        db.Enrollments.Add(e);
        try
        {
            await db.SaveChangesAsync(ct);
        }
        catch (DbUpdateException)
        {
            db.Entry(e).State = EntityState.Detached;
            e = await db.Enrollments.FirstAsync(x => x.UserId == userId && x.CourseId == courseId, ct);
        }
        return e;
    }

    /// <summary>Resolves ?courseId=, else the active course, else the first enrolment — skipping courses the user can no longer open.</summary>
    public static async Task<Guid> ResolveCourseIdAsync(AppDbContext db, HttpContext ctx, Guid? courseId, CancellationToken ct)
    {
        if (courseId is { } id)
        {
            await EnsureVisibleAsync(db, ctx, id, ct);
            return id;
        }
        var viewer = ctx.User.Viewer();
        var visible = CourseAccess.Visible(db, viewer);
        var active = await db.UserPreferences.Where(p => p.UserId == viewer.UserId).Select(p => p.ActiveCourseId).FirstOrDefaultAsync(ct);
        if (active is { } a && await visible.AnyAsync(c => c.Id == a, ct)) return a;
        var first = await db.Enrollments.Where(e => e.UserId == viewer.UserId && visible.Any(c => c.Id == e.CourseId))
            .OrderBy(e => e.EnrolledAt).Select(e => (Guid?)e.CourseId).FirstOrDefaultAsync(ct);
        return first ?? throw AppException.NotFound("Choose a course first.");
    }

    public static async Task<TimeZoneInfo> UserTimeZoneAsync(AppDbContext db, Guid userId, CancellationToken ct) =>
        TimeZones.FindOrUtc(await db.UserPreferences.Where(p => p.UserId == userId).Select(p => p.Timezone).FirstOrDefaultAsync(ct));

    /// <summary>Consecutive local days with learning activity, ending today or yesterday.</summary>
    public static async Task<int> StreakDaysAsync(AppDbContext db, Guid userId, TimeZoneInfo tz, CancellationToken ct)
    {
        var since = DateTime.UtcNow.AddDays(-90);
        var times = new List<DateTime>();
        times.AddRange(await db.ConceptMasteryHistory.Where(h => h.UserId == userId && h.CreatedAt >= since).Select(h => h.CreatedAt).ToListAsync(ct));
        times.AddRange(await db.Messages.Where(m => m.Role == MessageRoles.User && m.CreatedAt >= since
                                                    && db.Conversations.Any(c => c.Id == m.ConversationId && c.UserId == userId))
            .Select(m => m.CreatedAt).ToListAsync(ct));
        times.AddRange(await db.LessonProgress.Where(p => p.UserId == userId && p.LastViewedAt >= since).Select(p => p.LastViewedAt).ToListAsync(ct));
        times.AddRange(await db.LessonProgress.Where(p => p.UserId == userId && p.CompletedAt != null && p.CompletedAt >= since)
            .Select(p => p.CompletedAt!.Value).ToListAsync(ct));
        times.AddRange(await db.QuizAttempts.Where(a => a.UserId == userId && a.StartedAt >= since).Select(a => a.StartedAt).ToListAsync(ct));

        var days = times.Select(t => DateOnly.FromDateTime(TimeZoneInfo.ConvertTimeFromUtc(DateTime.SpecifyKind(t, DateTimeKind.Utc), tz))).ToHashSet();
        var today = DateOnly.FromDateTime(TimeZoneInfo.ConvertTimeFromUtc(DateTime.UtcNow, tz));
        var cursor = days.Contains(today) ? today : today.AddDays(-1);
        var streak = 0;
        while (days.Contains(cursor)) { streak++; cursor = cursor.AddDays(-1); }
        return streak;
    }

    public static async Task<List<ConceptMasteryDto>> MasteryAsync(AppDbContext db, Guid userId, Guid courseId, bool includeUnpracticed, CancellationToken ct)
    {
        var concepts = await db.Concepts.AsNoTracking().Where(c => c.CourseId == courseId).OrderBy(c => c.Id).ToListAsync(ct);
        var ids = concepts.Select(c => c.Id).ToList();
        var rows = await db.ConceptMastery.AsNoTracking().Where(m => m.UserId == userId && ids.Contains(m.ConceptId)).ToDictionaryAsync(m => m.ConceptId, ct);
        return concepts
            .Where(c => includeUnpracticed || rows.ContainsKey(c.Id))
            .Select(c =>
            {
                var m = rows.TryGetValue(c.Id, out var r) ? r.Mastery : MasteryModel.DefaultPrior;
                var attempts = r?.Attempts ?? 0;
                return new ConceptMasteryDto(c.Id, c.Name, Math.Round(m, 4), attempts, m < MasteryModel.NeedsWorkThreshold);
            })
            .OrderByDescending(x => x.Mastery).ThenBy(x => x.Name)
            .ToList();
    }

    public static async Task<List<CourseSummary>> SummariesAsync(AppDbContext db, Guid userId, IQueryable<Course> courses, CancellationToken ct)
    {
        var list = await courses.AsNoTracking()
            .Select(c => new
            {
                c.Id, c.Slug, c.Title, c.Description, c.Visibility,
                Modules = db.CourseModules.Count(m => m.CourseId == c.Id),
                Lessons = db.Lessons.Count(l => l.Module!.CourseId == c.Id),
                Enrollment = db.Enrollments.Where(e => e.UserId == userId && e.CourseId == c.Id).Select(e => new { e.DiagnosticCompletedAt }).FirstOrDefault(),
            })
            .OrderBy(c => c.Title)
            .ToListAsync(ct);
        var ids = list.Select(c => c.Id).ToList();
        var classes = await CourseAccess.ActiveMemberships(db).Where(m => m.UserId == userId)
            .Join(db.Classes.Where(k => ids.Contains(k.CourseId)), m => m.ClassId, k => k.Id, (m, k) => new { k.Id, k.Name, k.CourseId })
            .OrderBy(k => k.Name).ToListAsync(ct);
        return list.Select(c => new CourseSummary(c.Id, c.Slug, c.Title, c.Description, c.Modules, c.Lessons, c.Enrollment is not null,
            c.Enrollment?.DiagnosticCompletedAt is not null, c.Visibility,
            classes.Where(k => k.CourseId == c.Id).Select(k => new ClassRef(k.Id, k.Name)).ToList())).ToList();
    }

    /// <summary>The lesson if its course is visible to the user (404 otherwise).</summary>
    private static IQueryable<Lesson> VisibleLessons(AppDbContext db, HttpContext ctx)
    {
        var visible = CourseAccess.Visible(db, ctx.User.Viewer());
        return db.Lessons.Where(l => visible.Any(c => c.Id == l.Module!.CourseId));
    }

    // ---------------- endpoints ----------------

    private static async Task<List<CourseSummary>> ListCoursesAsync(HttpContext ctx, AppDbContext db, CancellationToken ct) =>
        await SummariesAsync(db, ctx.User.GetUserId(), CourseAccess.Catalog(db, ctx.User.Viewer()), ct);

    private static async Task<CourseDetailDto> GetCourseAsync(Guid courseId, HttpContext ctx, AppDbContext db, CancellationToken ct)
    {
        var userId = ctx.User.GetUserId();
        var course = await GetVisibleCourseAsync(db, ctx, courseId, ct);
        var modules = await db.CourseModules.AsNoTracking().Where(m => m.CourseId == courseId).OrderBy(m => m.Position)
            .Include(m => m.Lessons).ToListAsync(ct);
        var lessonIds = modules.SelectMany(m => m.Lessons).Select(l => l.Id).ToList();
        var progress = await db.LessonProgress.AsNoTracking().Where(p => p.UserId == userId && lessonIds.Contains(p.LessonId))
            .ToDictionaryAsync(p => p.LessonId, ct);
        var concepts = await db.Concepts.AsNoTracking().Where(c => c.CourseId == courseId).OrderBy(c => c.Id)
            .Select(c => new ConceptDto(c.Id, c.Slug, c.Name, c.Description)).ToListAsync(ct);

        return new CourseDetailDto(course.Id, course.Slug, course.Title, course.Description, course.Visibility,
            modules.Select(m => new ModuleOutlineDto(m.Id, m.Title, m.Summary, m.Position,
                m.Lessons.OrderBy(l => l.Position).Select(l => new LessonOutlineDto(l.Id, l.Title, l.Summary, l.Position, l.EstimatedMinutes,
                    progress.TryGetValue(l.Id, out var p) ? p.Status : LessonStatuses.NotStarted,
                    progress.TryGetValue(l.Id, out var p2) ? p2.Percent : 0)).ToList())).ToList(),
            concepts);
    }

    private static async Task<CourseSummary> EnrollAsync(Guid courseId, HttpContext ctx, AppDbContext db, CancellationToken ct)
    {
        var userId = ctx.User.GetUserId();
        await GetVisibleCourseAsync(db, ctx, courseId, ct);
        await EnsureEnrollmentAsync(db, userId, courseId, ct);
        var prefs = await db.UserPreferences.FirstOrDefaultAsync(p => p.UserId == userId, ct);
        if (prefs is null) { prefs = new UserPreference { UserId = userId }; db.UserPreferences.Add(prefs); }
        prefs.ActiveCourseId = courseId;
        await db.SaveChangesAsync(ct);
        return (await SummariesAsync(db, userId, db.Courses.Where(c => c.Id == courseId), ct)).Single();
    }

    private static async Task<LessonDto> GetLessonAsync(Guid lessonId, HttpContext ctx, AppDbContext db, CancellationToken ct)
    {
        var userId = ctx.User.GetUserId();
        var lesson = await VisibleLessons(db, ctx).AsNoTracking().Include(l => l.Module!).ThenInclude(m => m.Course)
            .Include(l => l.Objectives).Include(l => l.LessonConcepts).ThenInclude(lc => lc.Concept)
            .FirstOrDefaultAsync(l => l.Id == lessonId, ct)
            ?? throw AppException.NotFound("Lesson not found.");
        var module = lesson.Module!;
        var course = module.Course!;

        var ordered = await db.Lessons.AsNoTracking().Where(l => l.Module!.CourseId == course.Id)
            .OrderBy(l => l.Module!.Position).ThenBy(l => l.Position)
            .Select(l => new { l.Id, l.ModuleId }).ToListAsync(ct);
        var idx = ordered.FindIndex(l => l.Id == lessonId);
        var progress = await db.LessonProgress.AsNoTracking().FirstOrDefaultAsync(p => p.UserId == userId && p.LessonId == lessonId, ct);

        return new LessonDto(lesson.Id, lesson.Title, lesson.Summary, lesson.ContentMarkdown, lesson.EstimatedMinutes, lesson.Position,
            ordered.Count(l => l.ModuleId == module.Id),
            new ModuleRefDto(module.Id, module.Title, module.Position),
            new IdTitle(course.Id, course.Title),
            lesson.Objectives.OrderBy(o => o.Position).Select(o => o.Text).ToList(),
            lesson.LessonConcepts.Where(lc => lc.Concept is not null).Select(lc => new IdName(lc.ConceptId, lc.Concept!.Name)).ToList(),
            new ProgressStateDto(progress?.Status ?? LessonStatuses.NotStarted, progress?.Percent ?? 0),
            idx > 0 ? ordered[idx - 1].Id : null,
            idx >= 0 && idx < ordered.Count - 1 ? ordered[idx + 1].Id : null);
    }

    private static async Task<NoContent> UpdateProgressAsync(Guid lessonId, LessonProgressRequest req, HttpContext ctx, AppDbContext db, CancellationToken ct)
    {
        var userId = ctx.User.GetUserId();
        var lesson = await VisibleLessons(db, ctx).AsNoTracking().Where(l => l.Id == lessonId)
            .Select(l => new { l.Id, l.Module!.CourseId }).FirstOrDefaultAsync(ct) ?? throw AppException.NotFound("Lesson not found.");

        var now = DateTime.UtcNow;
        var p = await db.LessonProgress.FirstOrDefaultAsync(x => x.UserId == userId && x.LessonId == lessonId, ct);
        if (p is null) { p = new LessonProgress { UserId = userId, LessonId = lessonId }; db.LessonProgress.Add(p); }
        p.Percent = Math.Max(p.Percent, req.Completed ? 100 : req.Percent);
        p.LastViewedAt = now;
        if (req.Completed || p.Percent >= 100)
        {
            p.Percent = 100;
            if (p.Status != LessonStatuses.Completed) p.CompletedAt = now;
            p.Status = LessonStatuses.Completed;
        }
        else if (p.Status != LessonStatuses.Completed) p.Status = LessonStatuses.InProgress;

        var enrollment = await EnsureEnrollmentAsync(db, userId, lesson.CourseId, ct);
        enrollment.CurrentLessonId = lessonId;
        await db.SaveChangesAsync(ct);
        return TypedResults.NoContent();
    }

    private static async Task<HomeDto> HomeAsync(Guid? courseId, HttpContext ctx, AppDbContext db, RecommendationService recs, CancellationToken ct)
    {
        var userId = ctx.User.GetUserId();
        var cid = await ResolveCourseIdAsync(db, ctx, courseId, ct);
        var course = await GetVisibleCourseAsync(db, ctx, cid, ct);
        var tz = await UserTimeZoneAsync(db, userId, ct);

        var lessons = await db.Lessons.AsNoTracking().Where(l => l.Module!.CourseId == cid)
            .OrderBy(l => l.Module!.Position).ThenBy(l => l.Position)
            .Select(l => new { l.Id, l.Title, l.Summary, l.Position, l.ModuleId, ModuleTitle = l.Module!.Title, ModulePosition = l.Module.Position })
            .ToListAsync(ct);
        var lessonIds = lessons.Select(l => l.Id).ToList();
        var progress = await db.LessonProgress.AsNoTracking().Where(p => p.UserId == userId && lessonIds.Contains(p.LessonId))
            .ToDictionaryAsync(p => p.LessonId, ct);
        var current = await db.Enrollments.AsNoTracking().Where(e => e.UserId == userId && e.CourseId == cid).Select(e => e.CurrentLessonId).FirstOrDefaultAsync(ct);

        var next = lessons.FirstOrDefault(l => l.Id == current && !(progress.TryGetValue(l.Id, out var p) && p.Status == LessonStatuses.Completed))
                   ?? lessons.FirstOrDefault(l => !(progress.TryGetValue(l.Id, out var p) && p.Status == LessonStatuses.Completed));

        var nowLocal = TimeZoneInfo.ConvertTimeFromUtc(DateTime.UtcNow, tz);
        var endOfTodayUtc = TimeZoneInfo.ConvertTimeToUtc(nowLocal.Date.AddDays(1), tz);
        var due = await db.RevisionCards.CountAsync(c => c.UserId == userId && c.CourseId == cid && c.DueAt < endOfTodayUtc, ct);

        var studyNext = await recs.GetOrComputeAsync(userId, cid, TimeSpan.FromHours(6), ct);

        return new HomeDto(
            new IdTitle(course.Id, course.Title),
            next is null ? null : new ContinueLessonDto(next.Id, next.Title, next.Summary, course.Title, next.ModuleTitle, next.ModulePosition, next.Position,
                lessons.Count(l => l.ModuleId == next.ModuleId), progress.TryGetValue(next.Id, out var np) ? np.Percent : 0),
            new RevisionSummaryDto(due, Sm2.EstimatedMinutes(due)),
            await MasteryAsync(db, userId, cid, includeUnpracticed: false, ct),
            studyNext.Take(3).ToList(),
            await StreakDaysAsync(db, userId, tz, ct));
    }

    private static async Task<ProgressDto> ProgressAsync(Guid? courseId, HttpContext ctx, AppDbContext db, CancellationToken ct)
    {
        var userId = ctx.User.GetUserId();
        var cid = await ResolveCourseIdAsync(db, ctx, courseId, ct);
        var tz = await UserTimeZoneAsync(db, userId, ct);

        var conceptIds = await db.Concepts.Where(c => c.CourseId == cid).Select(c => c.Id).ToListAsync(ct);
        var since = DateTime.UtcNow.AddDays(-30);
        var history = await db.ConceptMasteryHistory.AsNoTracking()
            .Where(h => h.UserId == userId && conceptIds.Contains(h.ConceptId))
            .OrderBy(h => h.CreatedAt).Select(h => new { h.ConceptId, h.After, h.CreatedAt }).ToListAsync(ct);

        // Daily average of each practised concept's latest value as of that local day.
        var trend = new List<MasteryTrendPoint>();
        var latest = new Dictionary<Guid, double>();
        var byDay = history.GroupBy(h => DateOnly.FromDateTime(TimeZoneInfo.ConvertTimeFromUtc(h.CreatedAt, tz))).OrderBy(g => g.Key);
        foreach (var day in byDay)
        {
            foreach (var h in day) latest[h.ConceptId] = h.After;
            if (day.Max(h => h.CreatedAt) >= since)
                trend.Add(new MasteryTrendPoint(day.Key.ToString("yyyy-MM-dd"), Math.Round(latest.Values.Average(), 4)));
        }

        var quizzes = await db.QuizAttempts.AsNoTracking()
            .Where(a => a.UserId == userId && a.CompletedAt != null)
            .Join(db.Quizzes.Where(q => q.CourseId == cid), a => a.QuizId, q => q.Id, (a, q) => new { a.Id, q.Title, a.CompletedAt, a.CorrectCount, a.QuestionCount })
            .OrderByDescending(x => x.CompletedAt).Take(20)
            .Select(x => new QuizResultDto(x.Id, x.Title, x.CompletedAt, x.CorrectCount, x.QuestionCount))
            .ToListAsync(ct);

        var lessonIds = await db.Lessons.Where(l => l.Module!.CourseId == cid).Select(l => l.Id).ToListAsync(ct);
        var completed = await db.LessonProgress.CountAsync(p => p.UserId == userId && lessonIds.Contains(p.LessonId) && p.Status == LessonStatuses.Completed, ct);
        var questionsAsked = await db.Messages.CountAsync(m => m.Role == MessageRoles.User
            && db.Conversations.Any(c => c.Id == m.ConversationId && c.UserId == userId && c.CourseId == cid), ct);

        return new ProgressDto(await MasteryAsync(db, userId, cid, includeUnpracticed: true, ct), trend, quizzes, completed, lessonIds.Count,
            await StreakDaysAsync(db, userId, tz, ct), questionsAsked);
    }
}
