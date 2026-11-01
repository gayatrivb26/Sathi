using System.Text.Json;
using Hangfire;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;
using Sathi.Core.Access;
using Sathi.Core.Ai;
using Sathi.Core.Data;
using Sathi.Core.Domain;
using Sathi.Core.Email;
using Sathi.Core.Options;
using Sathi.Core.Security;
using Sathi.Core.Storage;
using Sathi.Core.Usage;

namespace Sathi.Core.Jobs;

/// <summary>Recurring job registrations (contract §10), applied by the jobs host at start-up.</summary>
public static class RecurringJobs
{
    public static void Register(IRecurringJobManager manager)
    {
        var utc = new RecurringJobOptions { TimeZone = TimeZoneInfo.Utc };
        var none = CancellationToken.None;
        manager.AddOrUpdate<HeartbeatJob>("heartbeat", JobQueues.Default, j => j.ExecuteAsync(none), "*/5 * * * *", utc);
        manager.AddOrUpdate<SyncLessonIndexJob>("sync-lesson-index", JobQueues.Default, j => j.ExecuteAsync(none), Cron.Hourly(), utc);
        manager.AddOrUpdate<ProcessOutboxJob>("process-outbox", JobQueues.Critical, j => j.ExecuteAsync(none), Cron.Minutely(), utc);
        manager.AddOrUpdate<SendRevisionRemindersJob>("revision-reminders", JobQueues.Default, j => j.ExecuteAsync(none), Cron.Hourly(), utc);
        manager.AddOrUpdate<UsageRollupJob>("usage-rollup", JobQueues.Default, j => j.ExecuteAsync(none), Cron.Daily(0, 15), utc);
        manager.AddOrUpdate<RetentionCleanupJob>("retention-cleanup", JobQueues.Default, j => j.ExecuteAsync(none), Cron.Daily(1, 0), utc);
        manager.AddOrUpdate<NightlyEvaluationJob>("nightly-evaluation", JobQueues.Default, j => j.ExecuteAsync(none), Cron.Daily(2, 0), utc);
        manager.AddOrUpdate<RecoverStaleStreamsJob>("recover-stale-streams", JobQueues.Default, j => j.ExecuteAsync(none), "*/5 * * * *", utc);
    }
}

/// <summary>HeartbeatJob — every 5 minutes, logs job.heartbeat.</summary>
public sealed class HeartbeatJob(ILogger<HeartbeatJob> logger)
{
    private static readonly EventId Heartbeat = new(4401, "job.heartbeat");

    [Queue(JobQueues.Default)]
    [AutomaticRetry(Attempts = 0)]
    public Task ExecuteAsync(CancellationToken cancellationToken)
    {
        logger.LogInformation(Heartbeat, "Jobs host heartbeat");
        return Task.CompletedTask;
    }
}

/// <summary>SendRevisionRemindersJob — hourly; emails users whose local hour = reminder_hour and who have due cards (once per local day).</summary>
public sealed class SendRevisionRemindersJob(AppDbContext db, IAppEmailSender email, IOptions<AppUrlOptions> app, ILogger<SendRevisionRemindersJob> logger)
{
    private static readonly EventId Reminders = new(4402, "reminders.run");

    [Queue(JobQueues.Default)]
    [AutomaticRetry(Attempts = 3, DelaysInSeconds = new[] { 10, 60, 300 })]
    public async Task ExecuteAsync(CancellationToken cancellationToken)
    {
        var now = DateTime.UtcNow;
        var candidates = await db.UserPreferences
            .Where(p => p.RemindersEnabled)
            .Join(db.Users.Where(u => u.DeletedAt == null && u.EmailConfirmed), p => p.UserId, u => u.Id,
                (p, u) => new { u.Id, u.Email, u.DisplayName, p.Timezone, p.ReminderHour })
            .ToListAsync(cancellationToken);

        int sent = 0, failed = 0;
        foreach (var c in candidates)
        {
            var tz = TimeZones.FindOrUtc(c.Timezone);
            var local = TimeZoneInfo.ConvertTimeFromUtc(now, tz);
            if (local.Hour != c.ReminderHour || string.IsNullOrEmpty(c.Email)) continue;

            // Only cards from courses the learner can still open (left a private course's class → no reminder).
            var openCourses = CourseAccess.Catalog(db, new CourseViewer(c.Id, IsAdmin: false, IsInstructor: false)).Select(k => k.Id);
            var due = await db.RevisionCards.CountAsync(r => r.UserId == c.Id && r.DueAt <= now && openCourses.Contains(r.CourseId), cancellationToken);
            if (due == 0) continue;

            var dayStartUtc = TimeZoneInfo.ConvertTimeToUtc(local.Date, tz);
            var already = await db.AuditEvents.AnyAsync(a => a.ActorUserId == c.Id && a.Action == AuditActions.ReminderSent
                                                             && a.CreatedAt >= dayStartUtc, cancellationToken);
            if (already) continue;

            try
            {
                await email.SendAsync(EmailTemplates.RevisionReminder(c.Email, c.DisplayName, due,
                    app.Value.BaseUrl.TrimEnd('/') + "/revision"), cancellationToken);
                db.Audit(c.Id, AuditActions.ReminderSent, "user", c.Id, new { due });
                await db.SaveChangesAsync(cancellationToken);
                sent++;
            }
            catch (Exception ex) when (ex is not OperationCanceledException)
            {
                failed++;
                logger.LogWarning(Reminders, ex, "Revision reminder could not be sent");
            }
        }
        logger.LogInformation(Reminders, "Revision reminders: {sent} sent, {failed} failed", sent, failed);
    }
}

/// <summary>ProcessOutboxJob — every minute; delivers document.deleted / user.deleted to the AI service and storage.</summary>
public sealed class ProcessOutboxJob(AppDbContext db, AiServiceClient ai, IObjectStorage storage, ILogger<ProcessOutboxJob> logger)
{
    private static readonly EventId Outbox = new(4403, "outbox.deliver");
    private const int MaxAttempts = 10;

    [Queue(JobQueues.Critical)]
    [AutomaticRetry(Attempts = 0)]
    [DisableConcurrentExecution(timeoutInSeconds: 60)]
    public async Task ExecuteAsync(CancellationToken cancellationToken)
    {
        var batch = await db.OutboxMessages
            .Where(m => m.ProcessedAt == null && m.Attempts < MaxAttempts)
            .OrderBy(m => m.CreatedAt).Take(50).ToListAsync(cancellationToken);
        foreach (var m in batch)
        {
            try
            {
                using var payload = JsonDocument.Parse(m.PayloadJson);
                switch (m.Type)
                {
                    case OutboxTypes.DocumentDeleted:
                        await DeliverDocumentDeletedAsync(payload.RootElement, cancellationToken);
                        break;
                    case OutboxTypes.UserDeleted:
                        await DeliverUserDeletedAsync(payload.RootElement, cancellationToken);
                        break;
                    default:
                        logger.LogWarning(Outbox, "Unknown outbox type {type}; marking processed", m.Type);
                        break;
                }
                m.ProcessedAt = DateTime.UtcNow;
                m.LastError = null;
                logger.LogInformation(Outbox, "Delivered outbox event {type} {outbox_id}", m.Type, m.Id);
            }
            catch (Exception ex) when (ex is not OperationCanceledException)
            {
                m.Attempts += 1;
                m.LastError = ex.Message.Length > 500 ? ex.Message[..500] : ex.Message;
                if (m.Attempts >= MaxAttempts)
                    logger.LogError(Outbox, ex, "Outbox event {type} {outbox_id} failed permanently after {attempts} attempts", m.Type, m.Id, m.Attempts);
                else
                    logger.LogWarning(Outbox, "Outbox event {type} {outbox_id} failed (attempt {attempts}); will retry", m.Type, m.Id, m.Attempts);
            }
            await db.SaveChangesAsync(CancellationToken.None);
        }
    }

    private async Task DeliverDocumentDeletedAsync(JsonElement p, CancellationToken ct)
    {
        var documentId = p.GetProperty("documentId").GetGuid();
        await IgnoreNotFound(() => ai.DeleteDocumentAsync(documentId, AiCallContext.System(ServiceScopes.Ingest), ct));
        if (p.TryGetProperty("storagePrefix", out var prefix) && prefix.ValueKind == JsonValueKind.String && prefix.GetString() is { Length: > 0 } s)
            await storage.DeletePrefixAsync(s, ct);
        await storage.DeletePrefixAsync($"parsed/{documentId}/", ct);
    }

    private async Task DeliverUserDeletedAsync(JsonElement p, CancellationToken ct)
    {
        var userId = p.GetProperty("userId").GetGuid();
        await IgnoreNotFound(() => ai.DeleteUserAsync(userId, AiCallContext.System(ServiceScopes.Admin), ct));
        await storage.DeletePrefixAsync($"uploads/{userId}/", ct);
        var now = DateTime.UtcNow;
        await db.Documents.Where(d => d.OwnerUserId == userId && d.DeletedAt == null)
            .ExecuteUpdateAsync(s => s.SetProperty(d => d.DeletedAt, now), ct);
    }

    private static async Task IgnoreNotFound(Func<Task> call)
    {
        try { await call(); }
        catch (AiServiceException ex) when (ex.Status == 404) { }
    }
}

/// <summary>UsageRollupJob — daily; logs yesterday's aggregate usage (usage.rollup) for dashboards/alerts.</summary>
public sealed class UsageRollupJob(AppDbContext db, ILogger<UsageRollupJob> logger)
{
    private static readonly EventId Rollup = new(4404, "usage.rollup");

    [Queue(JobQueues.Default)]
    [AutomaticRetry(Attempts = 3, DelaysInSeconds = new[] { 10, 60, 300 })]
    public async Task ExecuteAsync(CancellationToken cancellationToken)
    {
        var day = DateOnly.FromDateTime(DateTime.UtcNow.AddDays(-1));
        var rows = await db.UsageRecords.Where(u => u.Day == day)
            .GroupBy(u => u.Kind)
            .Select(g => new { Kind = g.Key, Count = g.Sum(x => x.Count), In = g.Sum(x => x.InputTokens), Out = g.Sum(x => x.OutputTokens), Cost = g.Sum(x => x.CostUsd), Users = g.Select(x => x.UserId).Distinct().Count() })
            .ToListAsync(cancellationToken);
        foreach (var r in rows)
            logger.LogInformation(Rollup, "Usage {day} {kind}: count {count}, input_tokens {input_tokens}, output_tokens {output_tokens}, cost_usd {cost_usd}, users {users}",
                day.ToString("yyyy-MM-dd"), r.Kind, r.Count, r.In, r.Out, r.Cost, r.Users);
        var active = await db.UsageRecords.Where(u => u.Day == day).Select(u => u.UserId).Distinct().CountAsync(cancellationToken);
        logger.LogInformation(Rollup, "Usage {day}: {active_users} active users", day.ToString("yyyy-MM-dd"), active);
    }
}

/// <summary>
/// RetentionCleanupJob — daily: purges soft-deleted conversations/documents after 30 days, anonymises users deleted 30+ days ago,
/// clears ai_run_steps metrics older than 90 days and removes processed outbox rows older than 30 days.
/// (Debug captures live in schema ai and are expired by the AI service itself.)
/// </summary>
public sealed class RetentionCleanupJob(AppDbContext db, ILogger<RetentionCleanupJob> logger)
{
    private static readonly EventId Retention = new(4405, "retention.cleanup");

    [Queue(JobQueues.Default)]
    [AutomaticRetry(Attempts = 3, DelaysInSeconds = new[] { 10, 60, 300 })]
    public async Task ExecuteAsync(CancellationToken cancellationToken)
    {
        var cutoff = DateTime.UtcNow.AddDays(-30);
        var metricsCutoff = DateTime.UtcNow.AddDays(-90);

        var conversations = await db.Conversations.Where(c => c.DeletedAt != null && c.DeletedAt < cutoff).ExecuteDeleteAsync(cancellationToken);
        var documents = await db.Documents.Where(d => d.DeletedAt != null && d.DeletedAt < cutoff).ExecuteDeleteAsync(cancellationToken);
        var steps = await db.AiRunSteps.Where(s => s.StartedAt < metricsCutoff && s.MetricsJson != "{}")
            .ExecuteUpdateAsync(s => s.SetProperty(x => x.MetricsJson, "{}"), cancellationToken);
        var outbox = await db.OutboxMessages.Where(m => m.ProcessedAt != null && m.ProcessedAt < cutoff).ExecuteDeleteAsync(cancellationToken);

        var users = await db.Users.Where(u => u.DeletedAt != null && u.DeletedAt < cutoff && !u.Email!.EndsWith("@deleted.invalid")).ToListAsync(cancellationToken);
        foreach (var u in users)
        {
            var anon = $"deleted-{u.Id:N}@deleted.invalid";
            u.Email = anon;
            u.NormalizedEmail = anon.ToUpperInvariant();
            u.UserName = anon;
            u.NormalizedUserName = anon.ToUpperInvariant();
            u.DisplayName = "Deleted user";
            u.DateOfBirth = null;
            u.GuardianEmailNormalized = null; // the guardian_consents record itself is kept (long retention)
            u.PasswordHash = null;
            u.SecurityStamp = Guid.NewGuid().ToString("N");
        }
        await db.SaveChangesAsync(cancellationToken);

        logger.LogInformation(Retention,
            "Retention cleanup: {conversations} conversations, {documents} documents purged; {steps} step metrics cleared; {outbox} outbox rows removed; {users} users anonymised",
            conversations, documents, steps, outbox, users.Count);
    }
}

/// <summary>NightlyEvaluationJob — daily 02:00 UTC; calls /internal/v1/eval/run and records an evaluation run.</summary>
public sealed class NightlyEvaluationJob(AppDbContext db, AiServiceClient ai, UserIdHasher hasher, ILogger<NightlyEvaluationJob> logger)
{
    private static readonly EventId Eval = new(4406, "eval.run");

    [Queue(JobQueues.Default)]
    [AutomaticRetry(Attempts = 3, DelaysInSeconds = new[] { 10, 60, 300 })]
    public async Task ExecuteAsync(CancellationToken cancellationToken)
    {
        var run = RunLedger.NewRun(AiRunTypes.Evaluation, null, hasher);
        db.AiRuns.Add(run);
        await db.SaveChangesAsync(cancellationToken);
        var started = DateTime.UtcNow;
        try
        {
            var result = await ai.RunEvaluationAsync(new EvalRunRequest("all"), new AiCallContext(null, [ServiceScopes.Eval], RunId: run.Id), cancellationToken);
            RunLedger.AddStep(db, run.Id, "generate", started, StepOutcomes.Ok, (object?)result);
            RunLedger.Succeed(run);
            await db.SaveChangesAsync(CancellationToken.None);
            logger.LogInformation(Eval, "Nightly evaluation completed (run {run_id})", run.Id);
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            RunLedger.Fail(run, ex is AiServiceException a ? a.Code : "EVALUATION_FAILED", ex.Message);
            await db.SaveChangesAsync(CancellationToken.None);
            throw;
        }
    }
}

public static class TimeZones
{
    public static TimeZoneInfo FindOrUtc(string? id)
    {
        if (!string.IsNullOrWhiteSpace(id) && TimeZoneInfo.TryFindSystemTimeZoneById(id, out var tz)) return tz;
        return TimeZoneInfo.Utc;
    }

    public static bool IsValid(string? id) => !string.IsNullOrWhiteSpace(id) && TimeZoneInfo.TryFindSystemTimeZoneById(id, out _);
}
