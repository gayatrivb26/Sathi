using FluentValidation;
using Microsoft.EntityFrameworkCore;
using Sathi.Api.Infrastructure;
using Sathi.Core.Access;
using Sathi.Core.Data;
using Sathi.Core.Domain;
using Sathi.Core.Errors;
using Sathi.Core.Jobs;
using Sathi.Core.Learning;
using Sathi.Core.Security;

namespace Sathi.Api.Modules;

public sealed record PracticeRequest(Guid CourseId, Guid? ConceptId, Guid? LessonId, int? Count);
public sealed record AnswerRequest(Guid QuestionId, Guid? SelectedOptionId, string? FreeText);
public sealed record ReviewRequest(Guid? SelectedOptionId, string? FreeText, int? Quality);

public sealed record OptionDto(Guid Id, string Label, string Text);
public sealed record AttemptQuestionDto(Guid Id, int Position, string Type, string Stem, Guid ConceptId, string ConceptName, IReadOnlyList<OptionDto> Options);
public sealed record MasteryDelta(Guid ConceptId, string Name, double Before, double After);
public sealed record GradingDto(string Status, double? Score, double? MaxScore, string? Feedback);
public sealed record AnswerResultDto(Guid AnswerId, Guid QuestionId, bool? IsCorrect, Guid? SelectedOptionId, Guid? CorrectOptionId, string Explanation,
    MasteryDelta? Mastery, GradingDto? Grading);
public sealed record CompleteAttemptDto(Guid AttemptId, int Correct, int Total, IReadOnlyList<MasteryDelta> MasteryChanges, IReadOnlyList<StudyNextItem> StudyNext);
public sealed record RevisionCardDto(Guid CardId, DateTime DueAt, AttemptQuestionDto Question);
public sealed record RevisionDueDto(int DueCount, IReadOnlyList<RevisionCardDto> Cards);
public sealed record ReviewResultDto(bool? IsCorrect, Guid? CorrectOptionId, string Explanation, DateTime NextDueAt, int IntervalDays);
public sealed record ScheduleDayDto(string Date, int Count);
public sealed record RevisionScheduleDto(IReadOnlyList<ScheduleDayDto> Days);
public sealed record AttemptDto(Guid AttemptId, Guid QuizId, string Title, string Kind, string? ConceptName, IReadOnlyList<AttemptQuestionDto> Questions,
    IReadOnlyList<AnswerResultDto> Answers, bool Completed);

public sealed class PracticeValidator : AbstractValidator<PracticeRequest>
{
    public PracticeValidator()
    {
        RuleFor(x => x.CourseId).NotEmpty();
        RuleFor(x => x.Count).InclusiveBetween(1, 20).When(x => x.Count is not null);
    }
}

public sealed class AnswerValidator : AbstractValidator<AnswerRequest>
{
    public AnswerValidator()
    {
        RuleFor(x => x.QuestionId).NotEmpty();
        RuleFor(x => x.FreeText).MaximumLength(4000);
        RuleFor(x => x).Must(x => x.SelectedOptionId is not null || !string.IsNullOrWhiteSpace(x.FreeText))
            .WithName("selectedOptionId").WithMessage("Choose an option or write an answer.");
    }
}

public sealed class ReviewValidator : AbstractValidator<ReviewRequest>
{
    public ReviewValidator()
    {
        RuleFor(x => x.Quality).InclusiveBetween(0, 5).When(x => x.Quality is not null);
        RuleFor(x => x.FreeText).MaximumLength(4000);
    }
}

public static class AssessmentsEndpoints
{
    private static readonly EventId GradingRouted = new(3201, "grading.routed");

    public static void MapAssessments(this RouteGroupBuilder routes)
    {
        var api = routes.MapGroup("").WithTags("Practice").WithProblems(401, 404);
        api.MapPost("/courses/{courseId:guid}/diagnostic", DiagnosticAsync).Doc("StartDiagnostic", "Start (or resume) the course's diagnostic quiz");
        api.MapPost("/practice/sessions", PracticeAsync).Validate<PracticeRequest>().WithProblems(400)
            .Doc("StartPractice", "Practice session for a concept, a lesson, or the weakest concepts");
        api.MapGet("/attempts/{attemptId:guid}", async (Guid attemptId, HttpContext ctx, AppDbContext db, CancellationToken ct) =>
            await BuildAttemptAsync(db, await OwnedAttemptAsync(db, ctx, attemptId, ct), ct)).Doc("GetAttempt", "An attempt with its answers so far");
        api.MapPost("/attempts/{attemptId:guid}/answers", AnswerAsync).Validate<AnswerRequest>().WithProblems(400, 409)
            .Doc("AnswerQuestion", "Answer a question (MCQ graded instantly; short answers queued for grading)");
        api.MapGet("/attempts/{attemptId:guid}/answers/{answerId:guid}", async (Guid attemptId, Guid answerId, HttpContext ctx, AppDbContext db, CancellationToken ct) =>
        {
            var attempt = await OwnedAttemptAsync(db, ctx, attemptId, ct);
            var answer = await db.SubmittedAnswers.AsNoTracking().FirstOrDefaultAsync(a => a.Id == answerId && a.AttemptId == attempt.Id, ct)
                         ?? throw AppException.NotFound("Answer not found.");
            return (await AnswerResultsAsync(db, [answer], ct)).Single();
        }).Doc("GetAnswer", "One answer result (poll while grading is pending)");
        api.MapPost("/attempts/{attemptId:guid}/complete", CompleteAsync).Doc("CompleteAttempt", "Finish an attempt: score, mastery changes, what to study next");
        api.MapGet("/revision/due", RevisionDueAsync).Doc("GetRevisionDue", "Revision cards due now");
        api.MapPost("/revision/cards/{cardId:guid}/review", ReviewAsync).Validate<ReviewRequest>().WithProblems(400)
            .Doc("ReviewCard", "Review a revision card (SM-2)");
        api.MapGet("/revision/schedule", ScheduleAsync).Doc("GetRevisionSchedule", "Cards due per day for the next 14 days");
    }

    // ---------------- attempts ----------------

    /// <summary>The user's attempt for a quiz of a course they can still open (contract §11.1), else 404.</summary>
    private static async Task<QuizAttempt> OwnedAttemptAsync(AppDbContext db, HttpContext ctx, Guid attemptId, CancellationToken ct)
    {
        var userId = ctx.User.GetUserId();
        var visible = CourseAccess.Visible(db, ctx.User.Viewer());
        return await db.QuizAttempts.FirstOrDefaultAsync(a => a.Id == attemptId && a.UserId == userId
                                                              && db.Quizzes.Any(q => q.Id == a.QuizId && visible.Any(c => c.Id == q.CourseId)), ct)
               ?? throw AppException.NotFound("Attempt not found.");
    }

    private static async Task<AttemptDto> DiagnosticAsync(Guid courseId, HttpContext ctx, AppDbContext db, CancellationToken ct)
    {
        var userId = ctx.User.GetUserId();
        await CoursesEndpoints.GetVisibleCourseAsync(db, ctx, courseId, ct);
        await CoursesEndpoints.EnsureEnrollmentAsync(db, userId, courseId, ct);
        var quiz = await QuizFactory.GetOrCreateDiagnosticQuizAsync(db, courseId, ct)
                   ?? throw AppException.NotFound("This course has no diagnostic questions yet.");

        // Resume an unfinished diagnostic instead of starting another.
        var attempt = await db.QuizAttempts.Where(a => a.QuizId == quiz.Id && a.UserId == userId && a.CompletedAt == null)
            .OrderByDescending(a => a.StartedAt).FirstOrDefaultAsync(ct);
        if (attempt is null)
        {
            attempt = new QuizAttempt
            {
                QuizId = quiz.Id, UserId = userId, QuestionCount = await db.QuizQuestions.CountAsync(x => x.QuizId == quiz.Id, ct),
            };
            db.QuizAttempts.Add(attempt);
            await db.SaveChangesAsync(ct);
        }
        return await BuildAttemptAsync(db, attempt, ct);
    }

    private static async Task<AttemptDto> PracticeAsync(PracticeRequest req, HttpContext ctx, AppDbContext db, CancellationToken ct)
    {
        var userId = ctx.User.GetUserId();
        await CoursesEndpoints.GetVisibleCourseAsync(db, ctx, req.CourseId, ct);
        var count = req.Count ?? 8;

        var published = db.Questions.AsNoTracking().Where(q => q.CourseId == req.CourseId && q.Status == QuestionStatuses.Published);
        List<Guid> picked;
        string title;
        string? conceptName = null;
        if (req.ConceptId is { } conceptId)
        {
            var concept = await db.Concepts.AsNoTracking().FirstOrDefaultAsync(c => c.Id == conceptId && c.CourseId == req.CourseId, ct)
                          ?? throw AppException.NotFound("Concept not found.");
            conceptName = concept.Name;
            title = $"Practice: {concept.Name}";
            picked = await PickAsync(db, userId, published.Where(q => q.ConceptId == conceptId), count, ct);
        }
        else if (req.LessonId is { } lessonId)
        {
            var lesson = await db.Lessons.AsNoTracking().FirstOrDefaultAsync(l => l.Id == lessonId && l.Module!.CourseId == req.CourseId, ct)
                         ?? throw AppException.NotFound("Lesson not found.");
            title = $"Lesson check: {lesson.Title}";
            var lessonConcepts = db.LessonConcepts.Where(lc => lc.LessonId == lessonId).Select(lc => lc.ConceptId);
            picked = await PickAsync(db, userId, published.Where(q => q.LessonId == lessonId || lessonConcepts.Contains(q.ConceptId)), count, ct);
        }
        else
        {
            title = "Practice: Mixed";
            // Weakest concepts first (unpractised concepts count as the default prior).
            var concepts = await db.Concepts.AsNoTracking().Where(c => c.CourseId == req.CourseId).Select(c => c.Id).ToListAsync(ct);
            var mastery = await db.ConceptMastery.AsNoTracking().Where(m => m.UserId == userId && concepts.Contains(m.ConceptId))
                .ToDictionaryAsync(m => m.ConceptId, m => m.Mastery, ct);
            var ranked = concepts.OrderBy(c => mastery.TryGetValue(c, out var m) ? m : MasteryModel.DefaultPrior).ToList();
            var pool = await published.Select(q => new { q.Id, q.ConceptId }).ToListAsync(ct);
            var answered = await AnsweredRecentlyAsync(db, userId, ct);
            var queues = ranked.Select(c => new Queue<Guid>(pool.Where(p => p.ConceptId == c)
                .OrderBy(p => answered.Contains(p.Id) ? 1 : 0).ThenBy(_ => Random.Shared.Next()).Select(p => p.Id))).Where(q => q.Count > 0).Take(4).ToList();
            picked = [];
            while (picked.Count < count && queues.Any(q => q.Count > 0))
                foreach (var queue in queues.Where(q => q.Count > 0))
                {
                    if (picked.Count >= count) break;
                    picked.Add(queue.Dequeue());
                }
        }
        if (picked.Count == 0) throw AppException.NotFound("There are no practice questions for this yet.");

        var kind = req.LessonId is not null && req.ConceptId is null ? QuizKinds.LessonCheck : QuizKinds.Practice;
        var quiz = await QuizFactory.CreateQuizAsync(db, req.CourseId, title, kind, req.ConceptId, req.LessonId, userId, picked, ct);
        var attempt = new QuizAttempt { QuizId = quiz.Id, UserId = userId, QuestionCount = picked.Count };
        db.QuizAttempts.Add(attempt);
        await db.SaveChangesAsync(ct);
        var dto = await BuildAttemptAsync(db, attempt, ct);
        return dto with { ConceptName = conceptName ?? dto.ConceptName };
    }

    private static async Task<HashSet<Guid>> AnsweredRecentlyAsync(AppDbContext db, Guid userId, CancellationToken ct)
    {
        var since = DateTime.UtcNow.AddDays(-7);
        return (await db.SubmittedAnswers.Where(a => a.SubmittedAt >= since && db.QuizAttempts.Any(t => t.Id == a.AttemptId && t.UserId == userId))
            .Select(a => a.QuestionId).ToListAsync(ct)).ToHashSet();
    }

    private static async Task<List<Guid>> PickAsync(AppDbContext db, Guid userId, IQueryable<Question> source, int count, CancellationToken ct)
    {
        var pool = await source.Select(q => q.Id).ToListAsync(ct);
        var answered = await AnsweredRecentlyAsync(db, userId, ct);
        return pool.OrderBy(id => answered.Contains(id) ? 1 : 0).ThenBy(_ => Random.Shared.Next()).Take(count).ToList();
    }

    public static async Task<AttemptDto> BuildAttemptAsync(AppDbContext db, QuizAttempt attempt, CancellationToken ct)
    {
        var quiz = await db.Quizzes.AsNoTracking().FirstAsync(q => q.Id == attempt.QuizId, ct);
        var links = await db.QuizQuestions.AsNoTracking().Where(x => x.QuizId == quiz.Id).OrderBy(x => x.Position).ToListAsync(ct);
        var qids = links.Select(l => l.QuestionId).ToList();
        var questions = await db.Questions.AsNoTracking().Include(q => q.Options).Include(q => q.Concept)
            .Where(q => qids.Contains(q.Id)).ToDictionaryAsync(q => q.Id, ct);
        var answers = await db.SubmittedAnswers.AsNoTracking().Where(a => a.AttemptId == attempt.Id).OrderBy(a => a.SubmittedAt).ToListAsync(ct);
        string? conceptName = quiz.ConceptId is { } cid ? await db.Concepts.Where(c => c.Id == cid).Select(c => c.Name).FirstOrDefaultAsync(ct) : null;

        return new AttemptDto(attempt.Id, quiz.Id, quiz.Title, quiz.Kind, conceptName,
            links.Where(l => questions.ContainsKey(l.QuestionId)).Select(l => ToQuestion(questions[l.QuestionId], l.Position)).ToList(),
            await AnswerResultsAsync(db, answers, ct), attempt.CompletedAt is not null);
    }

    public static AttemptQuestionDto ToQuestion(Question q, int position) => new(
        q.Id, position, q.Type, q.Stem, q.ConceptId, q.Concept?.Name ?? "",
        q.Options.OrderBy(o => o.Position).Select(o => new OptionDto(o.Id, o.Label, o.Text)).ToList());

    private static async Task<List<AnswerResultDto>> AnswerResultsAsync(AppDbContext db, IReadOnlyList<SubmittedAnswer> answers, CancellationToken ct)
    {
        if (answers.Count == 0) return [];
        var qids = answers.Select(a => a.QuestionId).Distinct().ToList();
        var questions = await db.Questions.AsNoTracking().Include(q => q.Options).Include(q => q.Concept)
            .Where(q => qids.Contains(q.Id)).ToDictionaryAsync(q => q.Id, ct);
        var aids = answers.Select(a => a.Id).ToList();
        var gradings = (await db.GradingResults.AsNoTracking().Where(g => aids.Contains(g.SubmittedAnswerId)).OrderBy(g => g.CreatedAt).ToListAsync(ct))
            .GroupBy(g => g.SubmittedAnswerId).ToDictionary(g => g.Key, g => g.Last());

        return answers.Select(a =>
        {
            var q = questions[a.QuestionId];
            var correctOption = q.Type == QuestionTypes.Mcq ? q.Options.FirstOrDefault(o => o.IsCorrect)?.Id : null;
            GradingDto? grading = null;
            if (gradings.TryGetValue(a.Id, out var g))
            {
                var visible = g.Status is GradingStatuses.AutoAccepted or GradingStatuses.Reviewed;
                grading = new GradingDto(g.Status,
                    g.Status == GradingStatuses.Reviewed ? g.FinalScore : visible ? g.Score : null,
                    visible ? g.MaxScore : null,
                    g.Status == GradingStatuses.Reviewed ? g.ReviewerFeedback ?? g.Feedback : visible ? g.Feedback : null);
            }
            var mastery = a.MasteryBefore is { } before && a.MasteryAfter is { } after
                ? new MasteryDelta(q.ConceptId, q.Concept?.Name ?? "", Math.Round(before, 4), Math.Round(after, 4))
                : null;
            return new AnswerResultDto(a.Id, a.QuestionId, a.IsCorrect, a.SelectedOptionId, correctOption, q.Explanation, mastery, grading);
        }).ToList();
    }

    private static async Task<AnswerResultDto> AnswerAsync(Guid attemptId, AnswerRequest req, HttpContext ctx, AppDbContext db, AnswerEffects effects,
        JobScheduler jobs, UserIdHasher hasher, ILogger<AnswerRequest> logger, CancellationToken ct)
    {
        var attempt = await OwnedAttemptAsync(db, ctx, attemptId, ct);
        var quiz = await db.Quizzes.AsNoTracking().FirstAsync(q => q.Id == attempt.QuizId, ct);
        if (!await db.QuizQuestions.AnyAsync(x => x.QuizId == quiz.Id && x.QuestionId == req.QuestionId, ct))
            throw AppException.Validation("questionId", "That question is not part of this attempt.");

        // Idempotent: answering the same question again returns the stored result (also covers a repeated Idempotency-Key).
        var existing = await db.SubmittedAnswers.AsNoTracking().FirstOrDefaultAsync(a => a.AttemptId == attempt.Id && a.QuestionId == req.QuestionId, ct);
        if (existing is not null) return (await AnswerResultsAsync(db, [existing], ct)).Single();
        if (attempt.CompletedAt is not null) throw AppException.Conflict("This attempt is already complete.");

        var question = await db.Questions.Include(q => q.Options).FirstAsync(q => q.Id == req.QuestionId, ct);
        var answer = new SubmittedAnswer { AttemptId = attempt.Id, QuestionId = question.Id, SubmittedAt = DateTime.UtcNow };
        db.SubmittedAnswers.Add(answer);

        if (question.Type == QuestionTypes.Mcq)
        {
            var option = question.Options.FirstOrDefault(o => o.Id == req.SelectedOptionId)
                         ?? throw AppException.Validation("selectedOptionId", "Choose one of the options.");
            answer.SelectedOptionId = option.Id;
            var source = quiz.Kind == QuizKinds.Diagnostic ? MasterySources.Diagnostic : MasterySources.Practice;
            await effects.ApplyAsync(answer, question, attempt.UserId, option.IsCorrect, null, source, ct);
            await db.SaveChangesAsync(ct);
        }
        else
        {
            if (string.IsNullOrWhiteSpace(req.FreeText)) throw AppException.Validation("freeText", "Write your answer.");
            answer.FreeText = req.FreeText.Trim();
            var rubric = await db.Rubrics.AsNoTracking().Where(r => r.QuestionId == question.Id).OrderByDescending(r => r.Version).FirstOrDefaultAsync(ct);
            var run = RunLedger.NewRun(AiRunTypes.Grading, attempt.UserId, hasher);
            var grading = new GradingResult { SubmittedAnswerId = answer.Id, RubricVersion = rubric?.Version ?? 0, Status = GradingStatuses.Pending, RunId = run.Id };
            db.AiRuns.Add(run);
            db.GradingResults.Add(grading);
            await effects.EnsureCardAsync(attempt.UserId, question, ct);
            await db.SaveChangesAsync(ct);
            run.HangfireJobId = jobs.EnqueueGradeAnswer(grading.Id, TraceIds.CurrentTraceParent(), run.Id);
            await db.SaveChangesAsync(CancellationToken.None);
            logger.LogInformation(GradingRouted, "Short answer queued for grading (question {question_id}, rubric v{rubric_version})", question.Id, grading.RubricVersion);
        }
        return (await AnswerResultsAsync(db, [answer], ct)).Single();
    }

    private static async Task<CompleteAttemptDto> CompleteAsync(Guid attemptId, HttpContext ctx, AppDbContext db, RecommendationService recs, CancellationToken ct)
    {
        var attempt = await OwnedAttemptAsync(db, ctx, attemptId, ct);
        var quiz = await db.Quizzes.AsNoTracking().FirstAsync(q => q.Id == attempt.QuizId, ct);
        var answers = await db.SubmittedAnswers.AsNoTracking().Where(a => a.AttemptId == attempt.Id).OrderBy(a => a.SubmittedAt).ToListAsync(ct);

        if (attempt.CompletedAt is null)
        {
            attempt.CompletedAt = DateTime.UtcNow;
            attempt.CorrectCount = answers.Count(a => a.IsCorrect == true);
            attempt.QuestionCount = await db.QuizQuestions.CountAsync(x => x.QuizId == quiz.Id, ct);
            if (quiz.Kind == QuizKinds.Diagnostic)
            {
                var enrollment = await CoursesEndpoints.EnsureEnrollmentAsync(db, attempt.UserId, quiz.CourseId, ct);
                enrollment.DiagnosticCompletedAt ??= attempt.CompletedAt;
                var prefs = await db.UserPreferences.FirstOrDefaultAsync(p => p.UserId == attempt.UserId, ct);
                if (prefs is null) { prefs = new UserPreference { UserId = attempt.UserId }; db.UserPreferences.Add(prefs); }
                prefs.OnboardingCompletedAt ??= attempt.CompletedAt;
                prefs.ActiveCourseId ??= quiz.CourseId;
            }
            await db.SaveChangesAsync(ct);
        }

        var qids = answers.Select(a => a.QuestionId).ToList();
        var conceptOf = await db.Questions.AsNoTracking().Where(q => qids.Contains(q.Id))
            .Select(q => new { q.Id, q.ConceptId, ConceptName = q.Concept!.Name }).ToDictionaryAsync(q => q.Id, ct);
        var changes = answers.Where(a => a.MasteryBefore is not null && a.MasteryAfter is not null && conceptOf.ContainsKey(a.QuestionId))
            .GroupBy(a => conceptOf[a.QuestionId].ConceptId)
            .Select(g => new MasteryDelta(g.Key, conceptOf[g.First().QuestionId].ConceptName,
                Math.Round(g.First().MasteryBefore!.Value, 4), Math.Round(g.Last().MasteryAfter!.Value, 4)))
            .ToList();

        var studyNext = await recs.ComputeAsync(attempt.UserId, quiz.CourseId, ct);
        return new CompleteAttemptDto(attempt.Id, attempt.CorrectCount, attempt.QuestionCount, changes, studyNext.Take(3).ToList());
    }

    // ---------------- revision ----------------

    private static async Task<RevisionDueDto> RevisionDueAsync(Guid? courseId, HttpContext ctx, AppDbContext db, CancellationToken ct)
    {
        var userId = ctx.User.GetUserId();
        var cid = await CoursesEndpoints.ResolveCourseIdAsync(db, ctx, courseId, ct);
        var now = DateTime.UtcNow;
        var due = db.RevisionCards.AsNoTracking().Where(c => c.UserId == userId && c.CourseId == cid && c.DueAt <= now);
        var count = await due.CountAsync(ct);
        var cards = await due.OrderBy(c => c.DueAt).Take(50).ToListAsync(ct);
        var qids = cards.Select(c => c.QuestionId).ToList();
        var questions = await db.Questions.AsNoTracking().Include(q => q.Options).Include(q => q.Concept)
            .Where(q => qids.Contains(q.Id)).ToDictionaryAsync(q => q.Id, ct);
        return new RevisionDueDto(count, cards.Where(c => questions.ContainsKey(c.QuestionId))
            .Select((c, i) => new RevisionCardDto(c.Id, c.DueAt, ToQuestion(questions[c.QuestionId], i + 1))).ToList());
    }

    private static async Task<ReviewResultDto> ReviewAsync(Guid cardId, ReviewRequest req, HttpContext ctx, AppDbContext db, AnswerEffects effects,
        MasteryService mastery, CancellationToken ct)
    {
        var userId = ctx.User.GetUserId();
        var visible = CourseAccess.Visible(db, ctx.User.Viewer());
        var card = await db.RevisionCards.FirstOrDefaultAsync(c => c.Id == cardId && c.UserId == userId && visible.Any(v => v.Id == c.CourseId), ct)
                   ?? throw AppException.NotFound("Card not found.");
        var question = await db.Questions.Include(q => q.Options).FirstAsync(q => q.Id == card.QuestionId, ct);
        var correctOption = question.Options.FirstOrDefault(o => o.IsCorrect);

        bool? isCorrect = null;
        if (req.SelectedOptionId is { } sel)
        {
            if (question.Options.All(o => o.Id != sel)) throw AppException.Validation("selectedOptionId", "Choose one of the options.");
            isCorrect = correctOption?.Id == sel;
        }
        var quality = req.Quality ?? (isCorrect is { } c ? Sm2.QualityFor(c) : 1);
        var now = DateTime.UtcNow;
        Sm2.Apply(card, quality, now);
        if (isCorrect is { } correct)
            await mastery.ApplyAsync(userId, question.ConceptId, correct, question.Difficulty, null, MasterySources.Revision, card.Id, ct);
        await db.SaveChangesAsync(ct);

        return new ReviewResultDto(isCorrect, question.Type == QuestionTypes.Mcq ? correctOption?.Id : null, question.Explanation, card.DueAt, card.IntervalDays);
    }

    private static async Task<RevisionScheduleDto> ScheduleAsync(Guid? courseId, HttpContext ctx, AppDbContext db, CancellationToken ct)
    {
        var userId = ctx.User.GetUserId();
        var cid = await CoursesEndpoints.ResolveCourseIdAsync(db, ctx, courseId, ct);
        var tz = await CoursesEndpoints.UserTimeZoneAsync(db, userId, ct);
        var today = DateOnly.FromDateTime(TimeZoneInfo.ConvertTimeFromUtc(DateTime.UtcNow, tz));
        var horizon = DateTime.UtcNow.AddDays(15);
        var dues = await db.RevisionCards.AsNoTracking().Where(c => c.UserId == userId && c.CourseId == cid && c.DueAt < horizon)
            .Select(c => c.DueAt).ToListAsync(ct);
        var counts = dues.Select(d => DateOnly.FromDateTime(TimeZoneInfo.ConvertTimeFromUtc(d, tz)))
            .Select(d => d < today ? today : d)
            .GroupBy(d => d).ToDictionary(g => g.Key, g => g.Count());
        var days = Enumerable.Range(0, 14).Select(i => today.AddDays(i))
            .Select(d => new ScheduleDayDto(d.ToString("yyyy-MM-dd"), counts.GetValueOrDefault(d))).ToList();
        return new RevisionScheduleDto(days);
    }
}
