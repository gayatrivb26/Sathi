using System.Text.Json;
using FluentValidation;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Options;
using Sathi.Api.Infrastructure;
using Sathi.Core.Ai;
using Sathi.Core.Data;
using Sathi.Core.Domain;
using Sathi.Core.Errors;
using Sathi.Core.Observability;
using Sathi.Core.Options;
using Sathi.Core.Security;
using Sathi.Core.Usage;

namespace Sathi.Api.Modules;

public sealed record DebugCaptureEditRequest(bool Enabled, int Hours);
public sealed record LogLevelRequest(string Level);

public sealed record AiRunSummaryDto(Guid Id, string TraceId, string ReferenceId, string Type, string Status, DateTime StartedAt, DateTime? FinishedAt,
    string? Model, string? ErrorCode, int? LatencyMs, int? TtftMs, decimal? EstimatedCostUsd, string UserIdHash, Guid? ConversationId, Guid? DocumentId,
    string? HangfireJobId);
public sealed record AiRunInfoDto(Guid Id, string TraceId, string ReferenceId, string Type, string Status, DateTime StartedAt, DateTime? FinishedAt,
    string? Model, string? Provider, string? PromptHash, int? InputTokens, int? OutputTokens, decimal? EstimatedCostUsd, int? TtftMs, int? LatencyMs,
    string? ErrorCode, string? ErrorMessage, string? HangfireJobId, Guid? ConversationId, Guid? DocumentId, string UserIdHash);
public sealed record AiRunStepDto(string Step, DateTime StartedAt, DateTime EndedAt, string Outcome, JsonElement Metrics);
public sealed record IngestionJobInfoDto(Guid Id, Guid DocumentId, string Status, string Stage, int Attempt, string? ErrorCode, string? ErrorMessage,
    string? HangfireJobId);
public sealed record RunLinksDto(string GrafanaLogs, string GrafanaTrace, string? HangfireJob);
public sealed record AiRunDetailDto(AiRunInfoDto Run, IReadOnlyList<AiRunStepDto> Steps, IngestionJobInfoDto? IngestionJob, JsonElement? AiService,
    RunLinksDto Links);
public sealed record UsageDayDto(string Date, int ChatMessages, int WebSearches, int Uploads, long InputTokens, long OutputTokens, decimal CostUsd);
public sealed record UsageDto(IReadOnlyList<UsageDayDto> Days, int ActiveUsers);
public sealed record DebugCaptureResultDto(Guid ConversationId, bool Enabled, DateTime? ExpiresAt);

public sealed class DebugCaptureValidator : AbstractValidator<DebugCaptureEditRequest>
{
    public DebugCaptureValidator() => RuleFor(x => x.Hours).InclusiveBetween(0, 24).WithMessage("Hours must be between 0 and 24.");
}

public sealed class LogLevelValidator : AbstractValidator<LogLevelRequest>
{
    public LogLevelValidator() => RuleFor(x => x.Level).Must(l => LogLevelControl.TryParseLevel(l, out _)).WithMessage("Level must be debug, info, warning or error.");
}

public static class AdminEndpoints
{
    private static readonly EventId AdminEvent = new(3301, "admin.action");

    public static void MapAdmin(this RouteGroupBuilder api)
    {
        var g = api.MapGroup("/admin").RequireAuthorization("Admin").WithTags("Admin").WithProblems(401, 403);
        g.MapGet("/runs", ListRunsAsync).WithProblems(400).Doc("ListRuns", "AI runs, newest first (cursor paging)");
        g.MapGet("/runs/lookup/{key}", LookupAsync).WithProblems(400, 404)
            .Doc("LookupRun", "Find a run by reference ID (7F3A-91C2), trace ID or run ID, with steps, ingestion job, AI-service detail and links");
        g.MapGet("/usage", UsageAsync).Doc("GetUsage", "Daily usage totals");
        g.MapPut("/debug-capture/{conversationId:guid}", DebugCaptureAsync).Validate<DebugCaptureEditRequest>().WithProblems(400, 404, 503)
            .Doc("SetDebugCapture", "Enable prompt/response capture for one conversation (≤ 24 h)");
        g.MapPut("/log-level", (LogLevelRequest req, HttpContext ctx, LogLevelControl control, AppDbContext db, ILogger<LogLevelRequest> logger) =>
        {
            LogLevelControl.TryParseLevel(req.Level, out var level);
            var previous = control.Switch.MinimumLevel;
            control.Switch.MinimumLevel = level;
            db.Audit(ctx.User.GetUserId(), AuditActions.LogLevelChange, "service", null, new { service = "api", from = previous.ToString(), to = level.ToString() });
            db.SaveChanges();
            logger.LogWarning(AdminEvent, "Log level changed from {previous_level} to {new_level}", previous, level);
            return TypedResults.NoContent();
        }).Validate<LogLevelRequest>().WithProblems(400).Doc("SetApiLogLevel", "Change the API's minimum log level at runtime");
    }

    private static AiRunSummaryDto Summary(AiRun r) => new(
        r.Id, r.TraceId, ReferenceId.Format(r.ReferenceId), r.Type, r.Status, r.StartedAt, r.FinishedAt, r.Model, r.ErrorCode,
        r.LatencyMs, r.TtftMs, r.EstimatedCostUsd, r.UserIdHash, r.ConversationId, r.DocumentId, r.HangfireJobId);

    private static async Task<Page<AiRunSummaryDto>> ListRunsAsync(string? status, string? type, string? cursor, int? limit, AppDbContext db, CancellationToken ct)
    {
        var take = Cursor.Limit(limit);
        var before = Cursor.Decode(cursor);
        var q = db.AiRuns.AsNoTracking().AsQueryable();
        if (!string.IsNullOrWhiteSpace(status)) q = q.Where(r => r.Status == status);
        if (!string.IsNullOrWhiteSpace(type)) q = q.Where(r => r.Type == type);
        if (before is { } b) q = q.Where(r => r.StartedAt < b);
        var rows = await q.OrderByDescending(r => r.StartedAt).Take(take + 1).ToListAsync(ct);
        return new Page<AiRunSummaryDto>(rows.Take(take).Select(Summary).ToList(), rows.Count > take ? Cursor.Encode(rows[take - 1].StartedAt) : null);
    }

    /// <summary>
    /// J8 lookup: accepts "7F3A-91C2" / "7F3A91C2" (reference id), a 32-hex trace id, or a run UUID. Also searches ingestion_jobs.reference_id.
    /// </summary>
    private static async Task<AiRunDetailDto> LookupAsync(string key, AppDbContext db, AiServiceClient ai, IOptions<ObservabilityOptions> obs,
        ILogger<LogLevelRequest> logger, CancellationToken ct)
    {
        key = key.Trim();
        AiRun? run = null;
        IngestionJob? ingestion = null;

        if (key.Length == 36 && Guid.TryParse(key, out var runId))
            run = await db.AiRuns.AsNoTracking().FirstOrDefaultAsync(r => r.Id == runId, ct);
        else if (TraceIds.IsTraceId(key))
        {
            var trace = key.ToLowerInvariant();
            run = await db.AiRuns.AsNoTracking().Where(r => r.TraceId == trace).OrderByDescending(r => r.StartedAt).FirstOrDefaultAsync(ct);
            if (run is null && Guid.TryParseExact(key, "N", out var asGuid))
                run = await db.AiRuns.AsNoTracking().FirstOrDefaultAsync(r => r.Id == asGuid, ct);
            if (run is null)
                ingestion = await db.IngestionJobs.AsNoTracking().Where(j => j.TraceId == trace).OrderByDescending(j => j.UpdatedAt).FirstOrDefaultAsync(ct);
        }
        else if (ReferenceId.TryNormalize(key) is { } reference)
        {
            run = await db.AiRuns.AsNoTracking().Where(r => r.ReferenceId == reference).OrderByDescending(r => r.StartedAt).FirstOrDefaultAsync(ct);
            if (run is null)
                ingestion = await db.IngestionJobs.AsNoTracking().Where(j => j.ReferenceId == reference).OrderByDescending(j => j.UpdatedAt).FirstOrDefaultAsync(ct);
        }
        else throw AppException.Validation("key", "Enter a reference ID (7F3A-91C2), a trace ID or a run ID.");

        if (run is null && ingestion is not null)
            run = await db.AiRuns.AsNoTracking().Where(r => r.DocumentId == ingestion.DocumentId && r.Type == AiRunTypes.Ingestion)
                .OrderByDescending(r => r.TraceId == ingestion.TraceId).ThenByDescending(r => r.StartedAt).FirstOrDefaultAsync(ct);
        if (run is null) throw AppException.NotFound("No run matches that ID.");

        if (ingestion is null && run.DocumentId is { } docId && run.Type == AiRunTypes.Ingestion)
            ingestion = await db.IngestionJobs.AsNoTracking().Where(j => j.DocumentId == docId)
                .OrderByDescending(j => j.TraceId == run.TraceId).ThenByDescending(j => j.UpdatedAt).FirstOrDefaultAsync(ct);

        var steps = await db.AiRunSteps.AsNoTracking().Where(s => s.RunId == run.Id).OrderBy(s => s.StartedAt).ToListAsync(ct);

        JsonElement? aiDetail = null;
        try
        {
            aiDetail = await ai.GetRunAsync(run.Id, AiCallContext.System(ServiceScopes.Runs), ct);
        }
        catch (AiServiceException ex)
        {
            logger.LogWarning(AdminEvent, "AI service run detail unavailable ({error_code})", ex.Code);
        }

        var hangfireJobId = run.HangfireJobId ?? ingestion?.HangfireJobId;
        return new AiRunDetailDto(
            new AiRunInfoDto(run.Id, run.TraceId, ReferenceId.Format(run.ReferenceId), run.Type, run.Status, run.StartedAt, run.FinishedAt, run.Model,
                run.Provider, run.PromptHash, run.InputTokens, run.OutputTokens, run.EstimatedCostUsd, run.TtftMs, run.LatencyMs, run.ErrorCode,
                run.ErrorMessage, hangfireJobId, run.ConversationId, run.DocumentId, run.UserIdHash),
            steps.Select(s => new AiRunStepDto(s.Step, s.StartedAt, s.EndedAt, s.Outcome,
                JsonSerializer.Deserialize<JsonElement>(string.IsNullOrEmpty(s.MetricsJson) ? "{}" : s.MetricsJson))).ToList(),
            ingestion is null ? null : new IngestionJobInfoDto(ingestion.Id, ingestion.DocumentId, ingestion.Status, ingestion.Stage, ingestion.Attempt,
                ingestion.ErrorCode, ingestion.ErrorMessage, ingestion.HangfireJobId),
            aiDetail,
            Links(obs.Value, run.TraceId, hangfireJobId, run.StartedAt));
    }

    public static RunLinksDto Links(ObservabilityOptions o, string traceId, string? hangfireJobId, DateTime startedAt)
    {
        var grafana = o.GrafanaUrl.TrimEnd('/');
        var from = new DateTimeOffset(startedAt.AddHours(-1)).ToUnixTimeMilliseconds();
        var to = new DateTimeOffset(startedAt.AddHours(3)).ToUnixTimeMilliseconds();
        var range = new { from = from.ToString(), to = to.ToString() };

        var logsPane = JsonSerializer.Serialize(new
        {
            datasource = o.LokiDatasourceUid,
            queries = new[] { new { refId = "A", datasource = new { type = "loki", uid = o.LokiDatasourceUid }, expr = $"{{service_name=~\".+\"}} |= \"{traceId}\"" } },
            range,
        });
        var tracePane = JsonSerializer.Serialize(new
        {
            datasource = o.TempoDatasourceUid,
            queries = new[] { new { refId = "A", datasource = new { type = "tempo", uid = o.TempoDatasourceUid }, queryType = "traceql", query = traceId } },
            range,
        });
        return new RunLinksDto(
            $"{grafana}/explore?orgId=1&left={Uri.EscapeDataString(logsPane)}",
            $"{grafana}/explore?orgId=1&left={Uri.EscapeDataString(tracePane)}",
            hangfireJobId is null ? null : $"/hangfire/jobs/details/{hangfireJobId}");
    }

    private static async Task<UsageDto> UsageAsync(int? days, AppDbContext db, CancellationToken ct)
    {
        var n = Math.Clamp(days ?? 7, 1, 90);
        var today = UsageService.Today;
        var from = today.AddDays(-(n - 1));
        var rows = await db.UsageRecords.AsNoTracking().Where(u => u.Day >= from && u.Day <= today)
            .Select(u => new { u.Day, u.Kind, u.Count, u.InputTokens, u.OutputTokens, u.CostUsd, u.UserId }).ToListAsync(ct);
        var result = Enumerable.Range(0, n).Select(i => from.AddDays(i)).Select(d =>
        {
            var day = rows.Where(r => r.Day == d).ToList();
            return new UsageDayDto(d.ToString("yyyy-MM-dd"),
                day.Where(r => r.Kind == UsageKinds.Chat).Sum(r => r.Count),
                day.Where(r => r.Kind == UsageKinds.WebSearch).Sum(r => r.Count),
                day.Where(r => r.Kind == UsageKinds.Upload).Sum(r => r.Count),
                day.Sum(r => r.InputTokens),
                day.Sum(r => r.OutputTokens),
                day.Sum(r => r.CostUsd));
        }).ToList();
        return new UsageDto(result, rows.Select(r => r.UserId).Distinct().Count());
    }

    private static async Task<DebugCaptureResultDto> DebugCaptureAsync(Guid conversationId, DebugCaptureEditRequest req, HttpContext ctx, AppDbContext db,
        AiServiceClient ai, CancellationToken ct)
    {
        if (!await db.Conversations.AnyAsync(c => c.Id == conversationId, ct)) throw AppException.NotFound("Conversation not found.");
        var expires = DateTime.UtcNow.AddHours(req.Enabled ? Math.Max(1, req.Hours) : 0);
        try
        {
            await ai.SetDebugCaptureAsync(new DebugCaptureRequest(conversationId, req.Enabled, expires), AiCallContext.System(ServiceScopes.Admin), ct);
        }
        catch (AiServiceException)
        {
            throw new AppException(503, ErrorCodes.AiServiceUnavailable, "The AI service could not be reached. Try again shortly.") { RetryAfter = TimeSpan.FromSeconds(30) };
        }
        db.Audit(ctx.User.GetUserId(), req.Enabled ? AuditActions.DebugCaptureEnable : AuditActions.DebugCaptureDisable, "conversation", conversationId,
            new { req.Hours, expiresAt = expires });
        await db.SaveChangesAsync(ct);
        return new DebugCaptureResultDto(conversationId, req.Enabled, req.Enabled ? expires : null);
    }
}
