using Hangfire;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;
using Sathi.Core.Data;
using Sathi.Core.Domain;
using Sathi.Core.Errors;
using Sathi.Core.Options;

namespace Sathi.Core.Jobs;

/// <summary>
/// Stale tutor streams (contract §11.5): an assistant message still "streaming" more than Tutor:StaleStreamMinutes after creation
/// (e.g. the API process died mid-stream) is persisted as failed/STREAM_INTERRUPTED and its ai_runs row is failed too.
/// </summary>
public static class StaleStreams
{
    /// <summary>Interrupts stale streaming messages (optionally of one conversation), skipping <paramref name="activeMessageIds"/>.
    /// Returns the interrupted messages (tracked, already saved).</summary>
    public static async Task<List<Message>> InterruptAsync(AppDbContext db, TimeSpan staleAfter, Guid? conversationId,
        Func<Guid, bool>? isActive, CancellationToken ct)
    {
        var cutoff = DateTime.UtcNow - staleAfter;
        var q = db.Messages.Where(m => m.Role == MessageRoles.Assistant && m.Status == MessageStatuses.Streaming && m.CreatedAt < cutoff);
        if (conversationId is { } cid) q = q.Where(m => m.ConversationId == cid);
        var stale = await q.OrderBy(m => m.CreatedAt).Take(500).ToListAsync(ct);
        if (isActive is not null) stale = stale.Where(m => !isActive(m.Id)).ToList();
        if (stale.Count == 0) return stale;

        var now = DateTime.UtcNow;
        foreach (var m in stale)
        {
            m.Status = MessageStatuses.Failed;
            m.ErrorCode = ErrorCodes.StreamInterrupted;
            m.CompletedAt = now;
        }
        var runIds = stale.Where(m => m.RunId != null).Select(m => m.RunId!.Value).ToList();
        var runs = await db.AiRuns.Where(r => runIds.Contains(r.Id) && r.Status == AiRunStatuses.Running).ToListAsync(ct);
        foreach (var r in runs)
        {
            r.Status = AiRunStatuses.Failed;
            r.ErrorCode = ErrorCodes.StreamInterrupted;
            r.ErrorMessage = "The stream was interrupted before it finished.";
            r.FinishedAt = now;
            r.LatencyMs ??= (int)Math.Min(int.MaxValue, (now - r.StartedAt).TotalMilliseconds);
        }
        await db.SaveChangesAsync(CancellationToken.None);
        return stale;
    }
}

/// <summary>RecoverStaleStreamsJob — every 5 minutes; interrupts stale streaming messages for all users (contract §10 / §11.5).</summary>
public sealed class RecoverStaleStreamsJob(AppDbContext db, IOptions<TutorOptions> options, ILogger<RecoverStaleStreamsJob> logger)
{
    private static readonly EventId Recover = new(4407, "tutor.stale_streams");

    [Queue(JobQueues.Default)]
    [AutomaticRetry(Attempts = 0)]
    [DisableConcurrentExecution(timeoutInSeconds: 60)]
    public async Task ExecuteAsync(CancellationToken cancellationToken)
    {
        var interrupted = await StaleStreams.InterruptAsync(db, TimeSpan.FromMinutes(options.Value.StaleStreamMinutes), null, null, cancellationToken);
        if (interrupted.Count > 0)
            logger.LogWarning(Recover, "Marked {count} stale tutor streams as {error_code}", interrupted.Count, ErrorCodes.StreamInterrupted);
        else
            logger.LogDebug(Recover, "No stale tutor streams");
    }
}
