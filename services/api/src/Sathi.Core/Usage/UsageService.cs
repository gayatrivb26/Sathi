using System.Text.Json;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Options;
using Sathi.Core.Data;
using Sathi.Core.Domain;
using Sathi.Core.Errors;
using Sathi.Core.Options;
using Sathi.Core.Security;

namespace Sathi.Core.Usage;

/// <summary>Daily per-user quotas (usage_records, UTC day) — contract §5.</summary>
public sealed class UsageService(AppDbContext db, IOptions<QuotaOptions> quotas)
{
    private readonly QuotaOptions _q = quotas.Value;

    public static DateOnly Today => DateOnly.FromDateTime(DateTime.UtcNow);

    public Task<int> CountTodayAsync(Guid userId, string kind, CancellationToken ct) =>
        db.UsageRecords.Where(u => u.UserId == userId && u.Day == Today && u.Kind == kind).Select(u => u.Count).FirstOrDefaultAsync(ct);

    public async Task EnsureChatQuotaAsync(Guid userId, bool webSearch, CancellationToken ct)
    {
        var chats = await CountTodayAsync(userId, UsageKinds.Chat, ct);
        if (chats >= _q.ChatMessagesPerDay)
            throw new AppException(429, ErrorCodes.QuotaExceeded,
                $"You have used today's {_q.ChatMessagesPerDay} tutor messages. They reset at midnight (UTC).");
        if (webSearch)
        {
            var searches = await CountTodayAsync(userId, UsageKinds.WebSearch, ct);
            if (searches >= _q.WebSearchesPerDay)
                throw new AppException(429, ErrorCodes.WebSearchQuotaExceeded,
                    $"You have used today's {_q.WebSearchesPerDay} web searches. They reset at midnight (UTC).");
        }
    }

    public async Task EnsureUploadQuotaAsync(Guid userId, CancellationToken ct)
    {
        var uploads = await CountTodayAsync(userId, UsageKinds.Upload, ct);
        if (uploads >= _q.UploadsPerDay)
            throw new AppException(429, ErrorCodes.QuotaExceeded,
                $"You have used today's {_q.UploadsPerDay} uploads. They reset at midnight (UTC).");
    }

    /// <summary>Atomic upsert-increment of (user, today, kind).</summary>
    public Task IncrementAsync(Guid userId, string kind, int count = 1, long inputTokens = 0, long outputTokens = 0, decimal costUsd = 0m,
        CancellationToken ct = default)
    {
        var id = Guid.CreateVersion7();
        var day = Today;
        return db.Database.ExecuteSqlInterpolatedAsync($"""
            INSERT INTO app.usage_records (id, user_id, day, kind, count, input_tokens, output_tokens, cost_usd)
            VALUES ({id}, {userId}, {day}, {kind}, {count}, {inputTokens}, {outputTokens}, {costUsd})
            ON CONFLICT (user_id, day, kind) DO UPDATE SET
                count = usage_records.count + EXCLUDED.count,
                input_tokens = usage_records.input_tokens + EXCLUDED.input_tokens,
                output_tokens = usage_records.output_tokens + EXCLUDED.output_tokens,
                cost_usd = usage_records.cost_usd + EXCLUDED.cost_usd
            """, ct);
    }
}

public static class AuditExtensions
{
    /// <summary>Adds an audit event (who did what). Caller saves.</summary>
    public static void Audit(this AppDbContext db, Guid? actor, string action, string entityType, Guid? entityId, object? metadata = null)
    {
        db.AuditEvents.Add(new AuditEvent
        {
            ActorUserId = actor,
            Action = action,
            EntityType = entityType,
            EntityId = entityId,
            MetadataJson = JsonSerializer.Serialize(metadata ?? new { }, Ai.AiJson.Options),
            TraceId = TraceIds.Current(),
            CreatedAt = DateTime.UtcNow,
        });
    }

    /// <summary>Adds an outbox event in the same transaction as the change. Caller saves.</summary>
    public static void Outbox(this AppDbContext db, string type, object payload)
    {
        db.OutboxMessages.Add(new OutboxMessage
        {
            Type = type,
            PayloadJson = JsonSerializer.Serialize(payload, Ai.AiJson.Options),
            CreatedAt = DateTime.UtcNow,
        });
    }
}
