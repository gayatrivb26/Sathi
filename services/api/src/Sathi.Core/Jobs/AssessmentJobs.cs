using System.Text.Json;
using Hangfire;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;
using Sathi.Core.Ai;
using Sathi.Core.Data;
using Sathi.Core.Domain;
using Sathi.Core.Errors;
using Sathi.Core.Learning;
using Sathi.Core.Observability;
using Sathi.Core.Options;
using Sathi.Core.Security;
using Sathi.Core.Usage;

namespace Sathi.Core.Jobs;

/// <summary>
/// GradeAnswerJob(gradingResultId, traceParent, runId) — queue critical. Calls /internal/v1/grade; confidence ≥
/// Grading:AutoAcceptConfidence → auto_accepted (mastery + revision card applied), else needs_review (GRADING_LOW_CONFIDENCE).
/// </summary>
public sealed class GradeAnswerJob(
    AppDbContext db, AiServiceClient ai, AnswerEffects effects, UsageService usage, UserIdHasher hasher,
    IOptions<GradingOptions> grading, SathiMetrics metrics, ILogger<GradeAnswerJob> logger)
{
    private static readonly EventId GradingRouted = new(4201, "grading.routed");

    [Queue(JobQueues.Critical)]
    [AutomaticRetry(Attempts = 3, DelaysInSeconds = new[] { 10, 60, 300 }, ExceptOn = new[] { typeof(NonRetryableJobException) },
        OnAttemptsExceeded = AttemptsExceededAction.Fail)]
    public async Task ExecuteAsync(Guid gradingResultId, string? traceParent, Guid runId, CancellationToken cancellationToken)
    {
        using var cts = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        cts.CancelAfter(TimeSpan.FromMinutes(5));
        var ct = cts.Token;

        var gr = await db.GradingResults.FirstOrDefaultAsync(g => g.Id == gradingResultId, ct);
        if (gr is null) { logger.LogWarning(GradingRouted, "Grading result {grading_id} not found", gradingResultId); return; }
        if (gr.Status != GradingStatuses.Pending)
        {
            logger.LogInformation(GradingRouted, "Grading result {grading_id} already {status}; nothing to do", gradingResultId, gr.Status);
            return;
        }

        var answer = await db.SubmittedAnswers.FirstAsync(a => a.Id == gr.SubmittedAnswerId, ct);
        var attempt = await db.QuizAttempts.FirstAsync(a => a.Id == answer.AttemptId, ct);
        var question = await db.Questions.FirstAsync(q => q.Id == answer.QuestionId, ct);
        var rubric = await db.Rubrics.Where(r => r.QuestionId == question.Id).OrderByDescending(r => r.Version).FirstOrDefaultAsync(ct);
        var run = await RunLedger.GetOrCreateAsync(db, runId, AiRunTypes.Grading, attempt.UserId, hasher, ct);
        gr.RunId = run.Id;

        if (rubric is null)
        {
            gr.Status = GradingStatuses.NeedsReview;
            RunLedger.Fail(run, ErrorCodes.GradingFailed, "No rubric for question");
            await db.SaveChangesAsync(CancellationToken.None);
            logger.LogWarning(GradingRouted, "No rubric for question {question_id}; routed to review", question.Id);
            return;
        }

        var criteria = JsonSerializer.Deserialize<List<RubricCriterion>>(rubric.CriteriaJson, AiJson.Options) ?? [];
        var started = DateTime.UtcNow;
        GradeResponse resp;
        try
        {
            resp = await ai.GradeAsync(new GradeRequest(question.Stem, new GradeRubric(rubric.Version, criteria, rubric.ModelAnswer),
                answer.FreeText ?? ""), new AiCallContext(attempt.UserId, [ServiceScopes.Grade], [question.CourseId], attempt.UserId, run.Id), ct);
        }
        catch (Exception ex) when (!cancellationToken.IsCancellationRequested)
        {
            var code = ex is AiServiceException a ? a.Code : ErrorCodes.GradingFailed;
            var final = ex is AiServiceException { IsTransient: false } || JobContext.Current is not { IsFinalAttempt: false };
            RunLedger.AddStep(db, run.Id, "grade", started, StepOutcomes.Failed, new { errorCode = code });
            if (final)
            {
                gr.Status = GradingStatuses.Failed;
                RunLedger.Fail(run, ErrorCodes.GradingFailed, ex.Message);
                metrics.RecordGradingRouted("failed");
            }
            else logger.LogWarning(GradingRouted, "Grading {grading_id} failed with {error_code}; will retry", gradingResultId, code);
            await db.SaveChangesAsync(CancellationToken.None);
            if (ex is AiServiceException { IsTransient: false }) throw new NonRetryableJobException(code, ex.Message, ex);
            throw;
        }

        gr.RubricVersion = rubric.Version;
        gr.Score = resp.Score;
        gr.MaxScore = resp.MaxScore;
        gr.Confidence = resp.Confidence;
        gr.Feedback = resp.Feedback ?? "";
        gr.CriteriaScoresJson = JsonSerializer.Serialize(resp.CriteriaScores ?? [], AiJson.Options);

        var autoAccept = resp.Confidence >= grading.Value.AutoAcceptConfidence;
        var outcome = autoAccept ? GradingStatuses.AutoAccepted : GradingStatuses.NeedsReview;
        gr.Status = outcome;
        if (autoAccept)
        {
            var fraction = resp.MaxScore > 0 ? resp.Score / resp.MaxScore : 0;
            await effects.ApplyAsync(answer, question, attempt.UserId, fraction >= AnswerEffects.CorrectFraction, fraction,
                MasterySources.Grading, ct);
        }

        RunLedger.AddStep(db, run.Id, "grade", started, StepOutcomes.Ok,
            new { rubricVersion = rubric.Version, confidence = resp.Confidence, routed = outcome });
        run.Model = resp.Model;
        run.PromptHash = resp.PromptHash;
        run.InputTokens = resp.InputTokens;
        run.OutputTokens = resp.OutputTokens;
        run.EstimatedCostUsd = resp.CostUsd;
        RunLedger.Succeed(run);
        await db.SaveChangesAsync(CancellationToken.None);
        await usage.IncrementAsync(attempt.UserId, UsageKinds.Grading, 1, resp.InputTokens, resp.OutputTokens, resp.CostUsd, CancellationToken.None);

        metrics.RecordGradingRouted(outcome);
        if (resp.CostUsd > 0) metrics.AiCostUsd.Add((double)resp.CostUsd, new KeyValuePair<string, object?>("type", AiRunTypes.Grading));

        if (autoAccept)
            logger.LogInformation(GradingRouted, "Grading routed {outcome} for question {question_id} (rubric v{rubric_version}, confidence {confidence:0.00})",
                outcome, question.Id, rubric.Version, resp.Confidence);
        else
            using (Serilog.Context.LogContext.PushProperty("error_code", ErrorCodes.GradingLowConfidence))
                logger.LogInformation(GradingRouted, "Grading routed {outcome} for question {question_id} (rubric v{rubric_version}, confidence {confidence:0.00})",
                    outcome, question.Id, rubric.Version, resp.Confidence);
    }
}

/// <summary>GenerateQuestionsJob(courseId, conceptId, count, difficulty, requestedBy, traceParent, runId) — queue ai-heavy. Creates draft questions.</summary>
public sealed class GenerateQuestionsJob(AppDbContext db, AiServiceClient ai, UsageService usage, UserIdHasher hasher, SathiMetrics metrics,
    ILogger<GenerateQuestionsJob> logger)
{
    private static readonly EventId Generate = new(4301, "quiz.generate");

    [Queue(JobQueues.AiHeavy)]
    [AutomaticRetry(Attempts = 3, DelaysInSeconds = new[] { 10, 60, 300 }, ExceptOn = new[] { typeof(NonRetryableJobException) },
        OnAttemptsExceeded = AttemptsExceededAction.Fail)]
    public async Task ExecuteAsync(Guid courseId, Guid conceptId, int count, double difficulty, Guid requestedBy, string? traceParent, Guid runId,
        CancellationToken cancellationToken)
    {
        using var cts = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        cts.CancelAfter(TimeSpan.FromMinutes(10));
        var ct = cts.Token;

        var run = await RunLedger.GetOrCreateAsync(db, runId, AiRunTypes.QuizGeneration, requestedBy, hasher, ct);
        if (run.Status == AiRunStatuses.Succeeded)
        {
            logger.LogInformation(Generate, "Generation run {run_id} already succeeded; nothing to do", runId);
            return;
        }
        var concept = await db.Concepts.FirstOrDefaultAsync(c => c.Id == conceptId && c.CourseId == courseId, ct);
        if (concept is null)
        {
            RunLedger.Fail(run, ErrorCodes.QuizGenerationFailed, "Concept not found");
            await db.SaveChangesAsync(CancellationToken.None);
            throw new NonRetryableJobException(ErrorCodes.QuizGenerationFailed, "Concept not found");
        }
        var lessonTitles = await db.LessonConcepts.Where(lc => lc.ConceptId == conceptId)
            .Join(db.Lessons, lc => lc.LessonId, l => l.Id, (lc, l) => l.Title).ToListAsync(ct);

        var started = DateTime.UtcNow;
        QuizGenerateResponse resp;
        try
        {
            resp = await ai.GenerateQuizAsync(new QuizGenerateRequest(courseId, new QuizConceptRef(concept.Id, concept.Name, concept.Description),
                    Math.Clamp(count, 1, 10), difficulty, lessonTitles),
                new AiCallContext(requestedBy, [ServiceScopes.Quiz], [courseId], null, run.Id), ct);
        }
        catch (Exception ex) when (!cancellationToken.IsCancellationRequested)
        {
            var code = ex is AiServiceException a ? a.Code : ErrorCodes.QuizGenerationFailed;
            var final = ex is AiServiceException { IsTransient: false } || JobContext.Current is not { IsFinalAttempt: false };
            RunLedger.AddStep(db, run.Id, "generate", started, StepOutcomes.Failed, new { errorCode = code });
            if (final) RunLedger.Fail(run, ErrorCodes.QuizGenerationFailed, ex.Message);
            else logger.LogWarning(Generate, "Question generation failed with {error_code}; will retry", code);
            await db.SaveChangesAsync(CancellationToken.None);
            if (ex is AiServiceException { IsTransient: false }) throw new NonRetryableJobException(code, ex.Message, ex);
            throw;
        }

        var created = 0;
        var rejected = 0;
        var now = DateTime.UtcNow;
        foreach (var g in resp.Questions ?? [])
        {
            var options = g.Options ?? [];
            if (string.IsNullOrWhiteSpace(g.Stem) || options.Count is < 2 or > 6 || options.Count(o => o.IsCorrect) != 1)
            {
                rejected++;
                continue;
            }
            var q = new Question
            {
                CourseId = courseId, ConceptId = conceptId, Type = QuestionTypes.Mcq, Stem = g.Stem.Trim(), Explanation = g.Explanation ?? "",
                Difficulty = Math.Clamp(g.Difficulty, 0, 1), Source = QuestionSources.Generated, Status = QuestionStatuses.Draft,
                CreatedBy = requestedBy, CreatedAt = now, UpdatedAt = now,
            };
            db.Questions.Add(q);
            var pos = 0;
            foreach (var o in options)
                db.QuestionOptions.Add(new QuestionOption
                {
                    QuestionId = q.Id, Label = string.IsNullOrWhiteSpace(o.Label) ? ((char)('A' + pos)).ToString() : o.Label.Trim(),
                    Text = o.Text, IsCorrect = o.IsCorrect, Position = pos++,
                });
            created++;
        }

        RunLedger.AddStep(db, run.Id, "generate", started, created > 0 ? StepOutcomes.Ok : StepOutcomes.Empty, new { created, rejected });
        run.Model = resp.Model;
        run.PromptHash = resp.PromptHash;
        run.InputTokens = resp.InputTokens;
        run.OutputTokens = resp.OutputTokens;
        run.EstimatedCostUsd = resp.CostUsd;
        RunLedger.Succeed(run);
        await db.SaveChangesAsync(CancellationToken.None);
        await usage.IncrementAsync(requestedBy, UsageKinds.QuizGeneration, 1, resp.InputTokens, resp.OutputTokens, resp.CostUsd, CancellationToken.None);
        if (resp.CostUsd > 0) metrics.AiCostUsd.Add((double)resp.CostUsd, new KeyValuePair<string, object?>("type", AiRunTypes.QuizGeneration));
        logger.LogInformation(Generate, "Generated {created} draft questions for concept {concept_id} ({rejected} rejected by validation)",
            created, conceptId, rejected);
    }
}

/// <summary>RecomputeRecommendationsJob(userId, courseId) — queue default.</summary>
public sealed class RecomputeRecommendationsJob(RecommendationService recommendations)
{
    [Queue(JobQueues.Default)]
    [AutomaticRetry(Attempts = 3, DelaysInSeconds = new[] { 10, 60, 300 })]
    public async Task ExecuteAsync(Guid userId, Guid courseId, CancellationToken cancellationToken)
    {
        await recommendations.ComputeAsync(userId, courseId, cancellationToken);
    }
}
