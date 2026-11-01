using System.Text.Json;
using Microsoft.EntityFrameworkCore;
using Sathi.Core.Ai;
using Sathi.Core.Data;
using Sathi.Core.Domain;
using Sathi.Core.Security;

namespace Sathi.Core.Jobs;

/// <summary>Helpers for the AI run ledger (app.ai_runs / app.ai_run_steps).</summary>
public static class RunLedger
{
    public static AiRun NewRun(string type, Guid? userId, UserIdHasher hasher, Guid? runId = null)
    {
        var traceId = TraceIds.Current();
        return new AiRun
        {
            Id = runId ?? Guid.CreateVersion7(),
            Type = type,
            Status = AiRunStatuses.Running,
            TraceId = traceId,
            ReferenceId = ReferenceId.ToStored(traceId),
            UserId = userId,
            UserIdHash = userId is { } u ? hasher.Hash(u) : "",
            StartedAt = DateTime.UtcNow,
            HangfireJobId = JobContext.Current?.JobId,
        };
    }

    /// <summary>Loads the run by id, or creates it (jobs triggered without an API-created run).</summary>
    public static async Task<AiRun> GetOrCreateAsync(AppDbContext db, Guid runId, string type, Guid? userId, UserIdHasher hasher, CancellationToken ct)
    {
        var run = await db.AiRuns.FirstOrDefaultAsync(r => r.Id == runId, ct);
        if (run is null)
        {
            run = NewRun(type, userId, hasher, runId);
            db.AiRuns.Add(run);
        }
        if (JobContext.Current is { } jc) run.HangfireJobId = jc.JobId;
        return run;
    }

    public static void AddStep(AppDbContext db, Guid runId, string step, DateTime startedAt, string outcome, object? metrics = null)
    {
        db.AiRunSteps.Add(new AiRunStep
        {
            RunId = runId,
            Step = step,
            StartedAt = startedAt,
            EndedAt = DateTime.UtcNow,
            Outcome = outcome,
            MetricsJson = JsonSerializer.Serialize(metrics ?? new { }, AiJson.Options),
        });
    }

    public static void Succeed(AiRun run)
    {
        run.Status = AiRunStatuses.Succeeded;
        run.FinishedAt = DateTime.UtcNow;
        run.LatencyMs = (int)(run.FinishedAt.Value - run.StartedAt).TotalMilliseconds;
        run.ErrorCode = null;
        run.ErrorMessage = null;
    }

    public static void Fail(AiRun run, string code, string? message)
    {
        run.Status = AiRunStatuses.Failed;
        run.FinishedAt = DateTime.UtcNow;
        run.LatencyMs = (int)(run.FinishedAt.Value - run.StartedAt).TotalMilliseconds;
        run.ErrorCode = code;
        run.ErrorMessage = message is { Length: > 500 } ? message[..500] : message;
    }
}
