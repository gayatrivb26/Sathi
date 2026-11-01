using System.Security.Cryptography;
using System.Text;
using Hangfire;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Logging;
using Sathi.Core.Ai;
using Sathi.Core.Data;
using Sathi.Core.Domain;
using Sathi.Core.Errors;
using Sathi.Core.Observability;
using Sathi.Core.Security;

namespace Sathi.Core.Jobs;

public static class IngestionErrors
{
    /// <summary>Deterministic failures: fail immediately, no retries.</summary>
    public static readonly HashSet<string> NonRetryable =
        [ErrorCodes.IngestNoText, ErrorCodes.IngestParseFailed, ErrorCodes.IngestUnsupportedType];

    public static string FriendlyMessage(string code) => code switch
    {
        ErrorCodes.IngestNoText => "No selectable text found. Scanned PDFs aren't supported yet — try a PDF with selectable text.",
        ErrorCodes.IngestParseFailed => "We couldn't read this file. It may be damaged or password-protected.",
        ErrorCodes.IngestUnsupportedType => "This file type isn't supported. Upload a PDF, Word (.docx), Markdown or text file.",
        ErrorCodes.IngestIndexFailed => "We couldn't index this file. Please try again.",
        ErrorCodes.AiServiceUnavailable => "Processing is temporarily unavailable. Please try again in a few minutes.",
        _ => "Processing failed. Please try again.",
    };
}

/// <summary>
/// IngestDocumentJob(documentId, version, traceParent, runId) — queue ai-heavy. parse (30%) → index (70%) → ready (100%).
/// Idempotent per (document, version): a ready job is skipped; the AI service replaces chunks on re-index.
/// </summary>
public sealed class IngestDocumentJob(
    AppDbContext db, AiServiceClient ai, UserIdHasher hasher, SathiMetrics metrics, ILogger<IngestDocumentJob> logger)
{
    private static readonly EventId IngestStep = new(4101, "ingest.step");

    [Queue(JobQueues.AiHeavy)]
    [AutomaticRetry(Attempts = 3, DelaysInSeconds = new[] { 10, 60, 300 }, ExceptOn = new[] { typeof(NonRetryableJobException) },
        OnAttemptsExceeded = AttemptsExceededAction.Fail)]
    public async Task ExecuteAsync(Guid documentId, int version, string? traceParent, Guid runId, CancellationToken cancellationToken)
    {
        using var cts = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        cts.CancelAfter(TimeSpan.FromMinutes(15));
        var ct = cts.Token;

        var doc = await db.Documents.FirstOrDefaultAsync(d => d.Id == documentId, ct);
        var job = await db.IngestionJobs.FirstOrDefaultAsync(j => j.DocumentId == documentId && j.DocumentVersion == version, ct);
        if (doc is null || job is null)
        {
            logger.LogWarning(IngestStep, "Ingestion skipped: document {document_id} v{document_version} not found", documentId, version);
            return;
        }

        var run = await RunLedger.GetOrCreateAsync(db, runId, AiRunTypes.Ingestion, doc.OwnerUserId, hasher, ct);
        run.DocumentId = doc.Id;

        if (doc.DeletedAt is not null)
        {
            run.Status = AiRunStatuses.Cancelled;
            run.FinishedAt = DateTime.UtcNow;
            await db.SaveChangesAsync(ct);
            logger.LogInformation(IngestStep, "Ingestion cancelled: document {document_id} was deleted", documentId);
            return;
        }
        if (job.Status == IngestionStages.Ready)
        {
            logger.LogInformation(IngestStep, "Ingestion of {document_id} v{document_version} already complete; nothing to do", documentId, version);
            return;
        }

        var ver = await db.DocumentVersions.FirstAsync(v => v.DocumentId == documentId && v.Version == version, ct);
        job.HangfireJobId = JobContext.Current?.JobId ?? job.HangfireJobId;
        job.TraceId = TraceIds.Current();
        var ctx = new AiCallContext(doc.OwnerUserId, [ServiceScopes.Ingest],
            doc.CourseId is { } c ? [c] : [], doc.OwnerUserId, runId);

        var step = "parse";
        var stepStarted = DateTime.UtcNow;
        try
        {
            SetStage(job, doc, IngestionStages.Parsing);
            await db.SaveChangesAsync(ct);
            var parsed = await ai.ParseAsync(new ParseRequest(doc.Id, version, ver.StorageKey, doc.ContentType, doc.FileName), ctx, ct);
            RunLedger.AddStep(db, run.Id, "parse", stepStarted, StepOutcomes.Ok, new { parsed.PageCount, parsed.CharCount });
            logger.LogInformation(IngestStep, "Parsed {document_id} v{document_version}: {page_count} pages, {char_count} chars",
                documentId, version, parsed.PageCount, parsed.CharCount);

            step = "index";
            stepStarted = DateTime.UtcNow;
            SetStage(job, doc, IngestionStages.Indexing);
            await db.SaveChangesAsync(ct);
            var indexed = await ai.IndexAsync(new IndexRequest(doc.Id, version, parsed.ParsedKey, doc.Scope, doc.OwnerUserId,
                doc.CourseId, doc.LessonId, doc.SourceType, doc.FileName), ctx, ct);
            RunLedger.AddStep(db, run.Id, "index", stepStarted, StepOutcomes.Ok, new { indexed.PassageCount, indexed.EmbeddingModel });

            SetStage(job, doc, IngestionStages.Ready);
            job.PassageCount = indexed.PassageCount;
            job.CompletedAt = DateTime.UtcNow;
            job.ErrorCode = null;
            job.ErrorMessage = null;
            doc.Status = DocumentStatuses.Ready;
            RunLedger.Succeed(run);
            await db.SaveChangesAsync(CancellationToken.None);
            logger.LogInformation(IngestStep, "Indexed {document_id} v{document_version}: {passage_count} passages",
                documentId, version, indexed.PassageCount);
        }
        catch (AiServiceException ex) when (!ex.IsTransient || IngestionErrors.NonRetryable.Contains(ex.Code))
        {
            RunLedger.AddStep(db, run.Id, step, stepStarted, StepOutcomes.Failed, new { errorCode = ex.Code, status = ex.Status });
            await MarkFailedAsync(job, doc, run, ex.Code, ex.Message);
            throw new NonRetryableJobException(ex.Code, ex.Message, ex);
        }
        catch (Exception ex) when (ex is not NonRetryableJobException && !cancellationToken.IsCancellationRequested)
        {
            var code = ex is AiServiceException a ? a.Code : step == "index" ? ErrorCodes.IngestIndexFailed : ErrorCodes.IngestParseFailed;
            RunLedger.AddStep(db, run.Id, step, stepStarted, StepOutcomes.Failed, new { errorCode = code });
            if (JobContext.Current is not { IsFinalAttempt: false })
            {
                await MarkFailedAsync(job, doc, run, code, ex.Message);
            }
            else
            {
                job.ErrorCode = code;
                job.UpdatedAt = DateTime.UtcNow;
                await db.SaveChangesAsync(CancellationToken.None);
                logger.LogWarning(IngestStep, "Ingestion step {step} failed with {error_code}; will retry", step, code);
            }
            throw;
        }
    }

    private static void SetStage(IngestionJob job, Document doc, string stage)
    {
        job.Status = stage;
        job.Stage = stage;
        job.ProgressPercent = IngestionStages.Percent(stage);
        job.UpdatedAt = DateTime.UtcNow;
        doc.Status = stage == IngestionStages.Ready ? DocumentStatuses.Ready : DocumentStatuses.Processing;
        doc.UpdatedAt = DateTime.UtcNow;
    }

    private async Task MarkFailedAsync(IngestionJob job, Document doc, AiRun run, string code, string message)
    {
        job.Status = IngestionStages.Failed;
        job.Stage = IngestionStages.Failed;
        job.ErrorCode = code;
        job.ErrorMessage = IngestionErrors.FriendlyMessage(code);
        job.ReferenceId = ReferenceId.ToStored(TraceIds.Current());
        job.UpdatedAt = DateTime.UtcNow;
        job.CompletedAt = DateTime.UtcNow;
        doc.Status = DocumentStatuses.Failed;
        doc.UpdatedAt = DateTime.UtcNow;
        RunLedger.Fail(run, code, message);
        metrics.IngestionFailures.Add(1, new KeyValuePair<string, object?>("error_code", code));
        await db.SaveChangesAsync(CancellationToken.None);
    }
}

/// <summary>IndexLessonJob(lessonId, version, traceParent) — queue default. Indexes lesson markdown via /ingest/text.</summary>
public sealed class IndexLessonJob(AppDbContext db, AiServiceClient ai, UserIdHasher hasher, SathiMetrics metrics, ILogger<IndexLessonJob> logger)
{
    private static readonly EventId IngestStep = new(4102, "ingest.step");

    [Queue(JobQueues.Default)]
    [AutomaticRetry(Attempts = 3, DelaysInSeconds = new[] { 10, 60, 300 }, ExceptOn = new[] { typeof(NonRetryableJobException) },
        OnAttemptsExceeded = AttemptsExceededAction.Fail)]
    public async Task ExecuteAsync(Guid lessonId, int version, string? traceParent, CancellationToken cancellationToken)
    {
        using var cts = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        cts.CancelAfter(TimeSpan.FromMinutes(10));
        var ct = cts.Token;

        var lesson = await db.Lessons.Include(l => l.Module).FirstOrDefaultAsync(l => l.Id == lessonId, ct);
        if (lesson is null)
        {
            logger.LogInformation(IngestStep, "Lesson {lesson_id} no longer exists; skipping index", lessonId);
            return;
        }
        if (lesson.Version != version)
        {
            logger.LogInformation(IngestStep, "Lesson {lesson_id} is now v{current}; skipping stale v{lesson_version}", lessonId, lesson.Version, version);
            return;
        }

        var courseId = lesson.Module!.CourseId;
        var bytes = Encoding.UTF8.GetBytes(lesson.ContentMarkdown);
        var sha = Convert.ToHexStringLower(SHA256.HashData(bytes));

        Document? doc = lesson.DocumentId is { } did ? await db.Documents.FirstOrDefaultAsync(d => d.Id == did, ct) : null;
        if (doc is null)
        {
            doc = new Document
            {
                Scope = DocumentScopes.Course, CourseId = courseId, LessonId = lesson.Id, SourceType = SourceTypes.Course,
                FileName = lesson.Title + ".md", ContentType = "text/markdown", Status = DocumentStatuses.Queued,
            };
            db.Documents.Add(doc);
            lesson.DocumentId = doc.Id;
        }
        doc.FileName = lesson.Title + ".md";
        doc.CurrentVersion = version;
        doc.SizeBytes = bytes.Length;
        doc.Sha256 = sha;
        doc.UpdatedAt = DateTime.UtcNow;
        doc.DeletedAt = null;

        if (!await db.DocumentVersions.AnyAsync(v => v.DocumentId == doc.Id && v.Version == version, ct))
            db.DocumentVersions.Add(new DocumentVersion
            {
                DocumentId = doc.Id, Version = version, StorageKey = $"lessons/{lesson.Id}/v{version}.md", Sha256 = sha, SizeBytes = bytes.Length,
            });

        var job = await db.IngestionJobs.FirstOrDefaultAsync(j => j.DocumentId == doc.Id && j.DocumentVersion == version, ct);
        if (job is null)
        {
            var trace = TraceIds.Current();
            job = new IngestionJob
            {
                DocumentId = doc.Id, DocumentVersion = version, TraceId = trace, ReferenceId = ReferenceId.ToStored(trace),
            };
            db.IngestionJobs.Add(job);
        }
        if (job.Status == IngestionStages.Ready)
        {
            await db.SaveChangesAsync(ct);
            logger.LogInformation(IngestStep, "Lesson {lesson_id} v{lesson_version} already indexed", lessonId, version);
            return;
        }

        var run = await db.AiRuns.Where(r => r.DocumentId == doc.Id && r.Type == AiRunTypes.Ingestion && r.Status == AiRunStatuses.Running)
            .OrderByDescending(r => r.StartedAt).FirstOrDefaultAsync(ct);
        if (run is null)
        {
            run = RunLedger.NewRun(AiRunTypes.Ingestion, null, hasher);
            run.DocumentId = doc.Id;
            db.AiRuns.Add(run);
        }
        run.HangfireJobId = JobContext.Current?.JobId;
        job.HangfireJobId = JobContext.Current?.JobId;
        job.Status = IngestionStages.Indexing;
        job.Stage = IngestionStages.Indexing;
        job.ProgressPercent = IngestionStages.Percent(IngestionStages.Indexing);
        job.UpdatedAt = DateTime.UtcNow;
        doc.Status = DocumentStatuses.Processing;
        await db.SaveChangesAsync(ct);

        var started = DateTime.UtcNow;
        try
        {
            var resp = await ai.IngestTextAsync(new IngestTextRequest(doc.Id, version, DocumentScopes.Course, courseId, lesson.Id,
                SourceTypes.Course, lesson.Title, lesson.ContentMarkdown),
                new AiCallContext(null, [ServiceScopes.Ingest], [courseId], null, run.Id), ct);
            RunLedger.AddStep(db, run.Id, "index", started, StepOutcomes.Ok, new { resp.PassageCount, resp.EmbeddingModel });
            job.Status = IngestionStages.Ready;
            job.Stage = IngestionStages.Ready;
            job.ProgressPercent = 100;
            job.PassageCount = resp.PassageCount;
            job.CompletedAt = DateTime.UtcNow;
            job.ErrorCode = null;
            job.ErrorMessage = null;
            job.UpdatedAt = DateTime.UtcNow;
            doc.Status = DocumentStatuses.Ready;
            RunLedger.Succeed(run);
            await db.SaveChangesAsync(CancellationToken.None);
            logger.LogInformation(IngestStep, "Indexed lesson {lesson_id} v{lesson_version}: {passage_count} passages", lessonId, version, resp.PassageCount);
        }
        catch (Exception ex) when (!cancellationToken.IsCancellationRequested)
        {
            var code = ex is AiServiceException a ? a.Code : ErrorCodes.IngestIndexFailed;
            var final = ex is AiServiceException { IsTransient: false } || JobContext.Current is not { IsFinalAttempt: false };
            RunLedger.AddStep(db, run.Id, "index", started, StepOutcomes.Failed, new { errorCode = code });
            job.ErrorCode = code;
            job.UpdatedAt = DateTime.UtcNow;
            if (final)
            {
                job.Status = IngestionStages.Failed;
                job.Stage = IngestionStages.Failed;
                job.ErrorMessage = IngestionErrors.FriendlyMessage(code);
                job.ReferenceId = ReferenceId.ToStored(TraceIds.Current());
                doc.Status = DocumentStatuses.Failed;
                RunLedger.Fail(run, code, ex.Message);
                metrics.IngestionFailures.Add(1, new KeyValuePair<string, object?>("error_code", code));
            }
            else
            {
                logger.LogWarning(IngestStep, "Indexing lesson {lesson_id} failed with {error_code}; will retry", lessonId, code);
            }
            await db.SaveChangesAsync(CancellationToken.None);
            if (ex is AiServiceException { IsTransient: false }) throw new NonRetryableJobException(code, ex.Message, ex);
            throw;
        }
    }
}

/// <summary>SyncLessonIndexJob — recurring hourly + at jobs-host start-up: enqueues IndexLessonJob for lessons whose version is not indexed.</summary>
public sealed class SyncLessonIndexJob(AppDbContext db, JobScheduler scheduler, ILogger<SyncLessonIndexJob> logger)
{
    private static readonly EventId Sync = new(4103, "ingest.sync");

    [Queue(JobQueues.Default)]
    [AutomaticRetry(Attempts = 3, DelaysInSeconds = new[] { 10, 60, 300 })]
    public async Task ExecuteAsync(CancellationToken cancellationToken)
    {
        var staleBefore = DateTime.UtcNow.AddMinutes(-30);
        var lessons = await db.Lessons.Select(l => new { l.Id, l.Version, l.DocumentId }).ToListAsync(cancellationToken);
        var jobs = await db.IngestionJobs
            .Where(j => db.Lessons.Any(l => l.DocumentId == j.DocumentId))
            .Select(j => new { j.DocumentId, j.DocumentVersion, j.Status, j.UpdatedAt })
            .ToListAsync(cancellationToken);

        var enqueued = 0;
        foreach (var l in lessons)
        {
            var j = l.DocumentId is null ? null : jobs.FirstOrDefault(x => x.DocumentId == l.DocumentId && x.DocumentVersion == l.Version);
            if (j is not null)
            {
                if (j.Status == IngestionStages.Ready) continue;
                var inFlight = j.Status is IngestionStages.Queued or IngestionStages.Parsing or IngestionStages.Indexing;
                if (inFlight && j.UpdatedAt > staleBefore) continue;
            }
            scheduler.EnqueueIndexLesson(l.Id, l.Version, TraceIds.CurrentTraceParent());
            enqueued++;
        }
        logger.LogInformation(Sync, "Lesson index sync: {lesson_count} lessons, {enqueued} enqueued", lessons.Count, enqueued);
    }
}
