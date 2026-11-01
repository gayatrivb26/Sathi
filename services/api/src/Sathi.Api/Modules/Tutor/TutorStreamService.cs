using System.Diagnostics;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using Microsoft.AspNetCore.Http.Features;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Options;
using Sathi.Api.Infrastructure;
using Sathi.Core.Access;
using Sathi.Core.Ai;
using Sathi.Core.Data;
using Sathi.Core.Domain;
using Sathi.Core.Errors;
using Sathi.Core.Observability;
using Sathi.Core.Options;
using Sathi.Core.Security;
using Sathi.Core.Usage;
using Serilog.Context;

namespace Sathi.Api.Modules.Tutor;

public sealed record StreamMessageRequest(string? Content, string Level, string Mode, string? Adjust, bool WebSearch, Guid? ReplyToMessageId);

/// <summary>
/// Live tutor relay (contract §5.3.1 / §6.1). Browser ← SSE ← .NET ← SSE ← AI service.
/// The upstream stream is read with its own cancellation token (Ai:StreamTimeoutSeconds, 180 s) — never HttpContext.RequestAborted —
/// so a browser disconnect does not stop the run: the assistant message, run ledger and usage are always finalised.
/// </summary>
public sealed class TutorStreamService(
    AppDbContext db,
    AiServiceClient ai,
    UsageService usage,
    UserIdHasher hasher,
    SathiMetrics metrics,
    ActiveTutorRuns activeRuns,
    IOptions<AiOptions> aiOptions,
    IOptions<TutorOptions> tutorOptions,
    ILogger<TutorStreamService> logger)
{
    private static readonly EventId StreamEvent = new(3101, "tutor.stream");

    public async Task StreamAsync(HttpContext http, Guid conversationId, StreamMessageRequest body)
    {
        var userId = http.User.GetUserId();
        var requestId = CorrelationMiddleware.Get(http);
        var options = tutorOptions.Value;

        // ---------- checks (ProblemDetails until the stream starts) ----------
        var convo = await db.Conversations.FirstOrDefaultAsync(c => c.Id == conversationId && c.UserId == userId && c.DeletedAt == null)
                    ?? throw AppException.NotFound("Conversation not found.");
        var viewer = http.User.Viewer();
        if (!await CourseAccess.CanSeeAsync(db, viewer, convo.CourseId, http.RequestAborted))
            throw AppException.NotFound("Conversation not found.");

        string? idempotencyKey = http.Request.Headers["Idempotency-Key"].ToString().Trim();
        if (idempotencyKey.Length > 200) throw AppException.Validation("idempotencyKey", "Idempotency-Key is too long.");
        if (idempotencyKey.Length == 0) idempotencyKey = null;
        if (idempotencyKey is not null && await db.Messages.AnyAsync(m => m.ConversationId == convo.Id && m.IdempotencyKey == idempotencyKey))
            throw AppException.Conflict("This message was already sent.");

        await usage.EnsureChatQuotaAsync(userId, body.WebSearch, http.RequestAborted);

        string? previousAnswer = null;
        if (body.Adjust is not null)
        {
            var prev = await db.Messages.AsNoTracking().FirstOrDefaultAsync(m =>
                           m.Id == body.ReplyToMessageId && m.ConversationId == convo.Id && m.Role == MessageRoles.Assistant)
                       ?? throw AppException.Validation("replyToMessageId", "Choose the answer to re-explain.");
            previousAnswer = prev.Content;
        }
        var question = string.IsNullOrWhiteSpace(body.Content)
            ? body.Adjust == Adjustments.Harder ? "Go deeper" : "Explain that more simply"
            : body.Content.Trim();

        var historyRows = await db.Messages.AsNoTracking()
            .Where(m => m.ConversationId == convo.Id && (m.Status == MessageStatuses.Complete || m.Status == MessageStatuses.Partial) && m.Content != "")
            .OrderByDescending(m => m.CreatedAt).Take(options.HistoryMessages)
            .Select(m => new { m.Role, m.Content }).ToListAsync();
        var history = historyRows.AsEnumerable().Reverse().Select(m => new HistoryTurn(m.Role, m.Content)).ToList();

        var course = await db.Courses.AsNoTracking().FirstAsync(c => c.Id == convo.CourseId);
        var lesson = convo.LessonId is { } lid
            ? await db.Lessons.AsNoTracking().Where(l => l.Id == lid).Select(l => new LessonRef(l.Id, l.Title)).FirstOrDefaultAsync()
            : null;
        // Retrieval scope: only courses the student can still open (a left/removed private course is not searchable).
        var enrolled = await db.Enrollments.AsNoTracking().Where(e => e.UserId == userId).Select(e => e.CourseId).ToListAsync();
        var enrolledCourses = await CourseAccess.FilterVisibleAsync(db, viewer, enrolled, http.RequestAborted);
        var weak = await db.ConceptMastery.AsNoTracking()
            .Where(m => m.UserId == userId && m.Attempts > 0 && m.Mastery < MasteryModelThreshold)
            .Join(db.Concepts.Where(c => c.CourseId == convo.CourseId), m => m.ConceptId, c => c.Id, (m, c) => new { c.Name, m.Mastery })
            .OrderBy(x => x.Mastery).Take(3).ToListAsync();

        // ---------- create messages + run ----------
        var now = DateTime.UtcNow;
        var runId = Guid.CreateVersion7();
        var traceId = TraceIds.Current();
        var reference = ReferenceId.ToStored(traceId);
        var userMessage = new Message
        {
            ConversationId = convo.Id, Role = MessageRoles.User, Content = question, Level = body.Level, Mode = body.Mode,
            Adjust = body.Adjust, WebSearch = body.WebSearch, Status = MessageStatuses.Complete, IdempotencyKey = idempotencyKey,
            CreatedAt = now, CompletedAt = now,
        };
        var assistant = new Message
        {
            ConversationId = convo.Id, Role = MessageRoles.Assistant, Content = "", Level = body.Level, Mode = body.Mode, Adjust = body.Adjust,
            WebSearch = body.WebSearch, Status = MessageStatuses.Streaming, RunId = runId, CreatedAt = now.AddTicks(10),
        };
        var run = new AiRun
        {
            Id = runId, TraceId = traceId, ReferenceId = reference, UserId = userId, UserIdHash = hasher.Hash(userId),
            Type = AiRunTypes.Chat, Status = AiRunStatuses.Running, StartedAt = now, ConversationId = convo.Id,
        };
        convo.UpdatedAt = now;
        if (convo.Title == "New conversation") convo.Title = Title(question);
        db.Messages.AddRange(userMessage, assistant);
        db.AiRuns.Add(run);
        try
        {
            await db.SaveChangesAsync();
        }
        catch (DbUpdateException) when (idempotencyKey is not null)
        {
            throw AppException.Conflict("This message was already sent.");
        }
        await usage.IncrementAsync(userId, UsageKinds.Chat);
        if (body.WebSearch) await usage.IncrementAsync(userId, UsageKinds.WebSearch);

        using var logScope = LogContext.PushProperty("conversation_id", convo.Id);
        using var runScope = LogContext.PushProperty("run_id", runId);

        // Live-run registry (contract §11.5): POST …/cancel aborts the upstream request through this token.
        var live = activeRuns.Register(assistant.Id, userId, convo.Id);
        try
        {
            await RelayAsync(http, body, options, requestId, convo, course, lesson, question, previousAnswer, history, weak.Select(w => new WeakConcept(w.Name, Math.Round(w.Mastery, 3))).ToList(),
                enrolledCourses, userMessage, assistant, run, reference, now, live);
        }
        finally
        {
            activeRuns.Unregister(assistant.Id);
        }
    }

    private async Task RelayAsync(HttpContext http, StreamMessageRequest body, TutorOptions options, string requestId, Conversation convo, Course course,
        LessonRef? lesson, string question, string? previousAnswer, List<HistoryTurn> history, List<WeakConcept> weak, List<Guid> enrolledCourses,
        Message userMessage, Message assistant, AiRun run, string reference, DateTime now, ActiveTutorRuns.Run live)
    {
        var userId = convo.UserId;
        var runId = run.Id;

        // ---------- start SSE ----------
        var response = http.Response;
        response.StatusCode = StatusCodes.Status200OK;
        response.ContentType = "text/event-stream; charset=utf-8";
        response.Headers.CacheControl = "no-cache, no-transform";
        response.Headers["X-Accel-Buffering"] = "no";
        http.Features.Get<IHttpResponseBodyFeature>()?.DisableBuffering();

        var writer = new SseWriter(response, http.RequestAborted, TimeSpan.FromSeconds(options.BrowserWriteTimeoutSeconds), logger);
        await writer.EventAsync("start", new
        {
            conversationId = convo.Id, userMessageId = userMessage.Id, assistantMessageId = assistant.Id, runId,
            referenceId = ReferenceId.Format(reference), requestId,
        });

        using var pingCts = new CancellationTokenSource();
        var pingTask = PingLoopAsync(writer, TimeSpan.FromSeconds(options.PingSeconds), pingCts.Token);

        // ---------- upstream ----------
        var request = new TutorRequest(runId, convo.Id, new CourseRef(course.Id, course.Title), lesson, question, body.Level, body.Mode,
            body.Adjust, previousAnswer, body.WebSearch, history, weak);
        var callContext = new AiCallContext(userId, [ServiceScopes.Tutor], enrolledCourses.Contains(course.Id) ? enrolledCourses : [.. enrolledCourses, course.Id],
            userId, runId);

        var sw = Stopwatch.StartNew();
        var content = new StringBuilder();
        var citations = new List<Citation>();
        int? ttftMs = null;
        JsonObject? done = null;
        string? errorCode = null;
        string? errorMessage = null;
        Exception? failure = null;
        JsonObject? lastUsage = null;
        var cancelled = false;

        // Own token (180 s), never the browser's — plus the live-run token so POST …/cancel aborts the upstream request.
        using var upstreamCts = CancellationTokenSource.CreateLinkedTokenSource(live.Token);
        upstreamCts.CancelAfter(TimeSpan.FromSeconds(aiOptions.Value.StreamTimeoutSeconds));
        try
        {
            await foreach (var ev in ai.StreamTutorAsync(request, callContext, upstreamCts.Token))
            {
                var data = ParseObject(ev.Data);
                switch (ev.Event)
                {
                    case "status":
                    case "usage":
                        if (data is null) break;
                        if (ev.Event == "usage") lastUsage = (JsonObject)data.DeepClone();
                        data["requestId"] = requestId;
                        await writer.EventRawAsync(ev.Event, data.ToJsonString(SseWriter.Json));
                        break;
                    case "token":
                        if (data is null) break;
                        var text = data["text"]?.GetValue<string>() ?? "";
                        ttftMs ??= (int)sw.ElapsedMilliseconds;
                        content.Append(text);
                        await writer.EventAsync("token", new { text, requestId });
                        break;
                    case "citation":
                        if (data is null) break;
                        var citation = data.Deserialize<Citation>(AiJson.Options);
                        if (citation is not null)
                        {
                            citations.Add(citation);
                            data["requestId"] = requestId;
                            await writer.EventRawAsync("citation", data.ToJsonString(SseWriter.Json));
                        }
                        break;
                    case "error":
                        errorCode = data?["code"]?.GetValue<string>() ?? ErrorCodes.LlmUnavailable;
                        errorMessage = data?["message"]?.GetValue<string>();
                        break;
                    case "done":
                        done = data ?? new JsonObject();
                        break;
                    default:
                        logger.LogDebug(StreamEvent, "Ignoring upstream event {event_name}", ev.Event);
                        break;
                }
                if (done is not null || errorCode is not null) break;
            }
            if (done is null && errorCode is null)
            {
                errorCode = ErrorCodes.AiServiceUnavailable;
                errorMessage = "The AI service closed the stream before finishing.";
            }
        }
        catch (Exception ex) when (live.CancelRequested && ex is OperationCanceledException or AiServiceException or IOException or HttpRequestException)
        {
            cancelled = true;
        }
        catch (AiServiceException ex)
        {
            errorCode = ex.Code;
            errorMessage = ex.Message;
            failure = ex;
        }
        catch (OperationCanceledException ex) when (upstreamCts.IsCancellationRequested)
        {
            errorCode = ErrorCodes.LlmTimeout;
            errorMessage = "The tutor stream timed out.";
            failure = ex;
        }
        catch (Exception ex)
        {
            // Connection reset, malformed upstream data, … — the run still completes (as partial/failed).
            errorCode = ErrorCodes.AiServiceUnavailable;
            errorMessage = "The connection to the AI service was lost.";
            failure = ex;
        }

        // ---------- persist (never tied to the browser) ----------
        var finished = DateTime.UtcNow;
        var latencyMs = (int)sw.ElapsedMilliseconds;
        run.FinishedAt = finished;
        run.TtftMs = ttftMs;
        run.LatencyMs = latencyMs;
        assistant.CitationsJson = JsonSerializer.Serialize(citations, AiJson.Options);
        assistant.CompletedAt = finished;

        string[] answerBasis = [];
        string[] warnings = [];
        if (cancelled)
        {
            // Contract §11.5: keep the text produced so far, run cancelled, usage for the tokens already generated.
            assistant.Content = content.ToString();
            assistant.Status = MessageStatuses.Cancelled;
            run.Status = AiRunStatuses.Cancelled;
            run.ErrorMessage = "Cancelled by the user.";
            if (lastUsage is not null)
            {
                run.InputTokens = ReadInt(lastUsage["inputTokens"]);
                run.OutputTokens = ReadInt(lastUsage["outputTokens"]);
                run.EstimatedCostUsd = ReadDecimal(lastUsage["costUsd"]);
                run.Model = lastUsage["model"]?.GetValue<string>();
            }
            else
            {
                // No usage event yet: estimate the generated tokens (~4 characters per token); input tokens are unknown.
                run.InputTokens = 0;
                run.OutputTokens = (int)Math.Ceiling(content.Length / 4.0);
            }
            db.Audit(userId, AuditActions.MessageCancelled, "message", assistant.Id, new { live = true });
        }
        else if (done is not null)
        {
            assistant.Content = done["content"]?.GetValue<string>() ?? content.ToString();
            answerBasis = ReadStrings(done["answerBasis"]);
            warnings = ReadStrings(done["warnings"]);
            assistant.AnswerBasis = [.. answerBasis];
            assistant.Status = MessageStatuses.Complete;
            run.Status = AiRunStatuses.Succeeded;

            if (done["run"] is JsonObject r)
            {
                run.Provider = r["provider"]?.GetValue<string>();
                run.Model = r["model"]?.GetValue<string>();
                run.PromptHash = r["promptHash"]?.GetValue<string>();
                run.InputTokens = ReadInt(r["inputTokens"]);
                run.OutputTokens = ReadInt(r["outputTokens"]);
                run.EstimatedCostUsd = ReadDecimal(r["costUsd"]);
                if (ReadInt(r["ttftMs"]) is { } upTtft && upTtft > 0 && ttftMs is null) run.TtftMs = upTtft;
            }
            if (done["steps"] is JsonArray steps)
            {
                foreach (var s in steps.OfType<JsonObject>())
                {
                    db.AiRunSteps.Add(new AiRunStep
                    {
                        RunId = runId,
                        Step = s["step"]?.GetValue<string>() ?? "llm",
                        StartedAt = ReadDate(s["startedAt"]) ?? now,
                        EndedAt = ReadDate(s["endedAt"]) ?? finished,
                        Outcome = s["outcome"]?.GetValue<string>() ?? StepOutcomes.Ok,
                        MetricsJson = s["metrics"] is JsonObject m ? m.ToJsonString() : "{}",
                    });
                }
            }
        }
        else
        {
            assistant.Content = content.ToString();
            assistant.Status = content.Length > 0 ? MessageStatuses.Partial : MessageStatuses.Failed;
            assistant.ErrorCode = errorCode;
            run.Status = AiRunStatuses.Failed;
            run.ErrorCode = errorCode;
            run.ErrorMessage = errorMessage is { Length: > 500 } ? errorMessage[..500] : errorMessage;
        }

        await db.SaveChangesAsync(CancellationToken.None);
        if (run.InputTokens is not null || run.OutputTokens is not null || run.EstimatedCostUsd is not null)
            await usage.IncrementAsync(userId, UsageKinds.Chat, 0, run.InputTokens ?? 0, run.OutputTokens ?? 0, run.EstimatedCostUsd ?? 0m, CancellationToken.None);
        if (run.TtftMs is { } t) metrics.TutorTtftMs.Record(t, new KeyValuePair<string, object?>("web_search", body.WebSearch));
        if (run.EstimatedCostUsd is { } cost && cost > 0) metrics.AiCostUsd.Add((double)cost, new KeyValuePair<string, object?>("type", AiRunTypes.Chat));

        // ---------- terminal event ----------
        if (cancelled)
        {
            // Terminal "done" carrying the partial text; status "cancelled" and warning CANCELLED tell the UI it was stopped.
            await writer.EventAsync("done", new
            {
                messageId = assistant.Id,
                content = assistant.Content,
                answerBasis = Array.Empty<string>(),
                citationsValid = 0,
                citationsDropped = 0,
                warnings = new[] { "CANCELLED" },
                status = MessageStatuses.Cancelled,
                requestId,
            });
        }
        else if (done is not null)
        {
            await writer.EventAsync("done", new
            {
                messageId = assistant.Id,
                content = assistant.Content,
                answerBasis,
                citationsValid = ReadInt(done["citationsValid"]) ?? citations.Count,
                citationsDropped = ReadInt(done["citationsDropped"]) ?? 0,
                warnings,
                requestId,
            });
        }
        else
        {
            await writer.EventAsync("error", new
            {
                code = errorCode,
                message = FriendlyError(errorCode!, errorMessage),
                referenceId = ReferenceId.Format(reference),
                requestId,
            });
        }

        await pingCts.CancelAsync();
        await pingTask;

        using (LogContext.PushProperty("error_code", errorCode))
        {
            if (cancelled)
                logger.LogInformation(StreamEvent, "Tutor stream cancelled by the user after {duration_ms} ms ({char_count} characters kept)",
                    latencyMs, assistant.Content.Length);
            else if (done is not null)
                logger.LogInformation(StreamEvent, "Tutor answer complete in {duration_ms} ms (ttft {ttft_ms} ms, {citation_count} citations, browser_connected {browser_connected})",
                    latencyMs, run.TtftMs, citations.Count, !writer.IsGone);
            else if (errorCode == ErrorCodes.AiServiceUnavailable || failure is not null)
                logger.LogError(StreamEvent, failure, "Tutor stream failed with {error_code} after {duration_ms} ms ({status})", errorCode, latencyMs, assistant.Status);
            else
                logger.LogWarning(StreamEvent, "Tutor stream ended with upstream error {error_code} after {duration_ms} ms ({status})", errorCode, latencyMs, assistant.Status);
        }
    }

    private const double MasteryModelThreshold = 0.6;

    private static async Task PingLoopAsync(SseWriter writer, TimeSpan interval, CancellationToken ct)
    {
        try
        {
            while (!ct.IsCancellationRequested)
            {
                await Task.Delay(interval, ct);
                await writer.PingAsync();
            }
        }
        catch (OperationCanceledException) { }
    }

    public static string FriendlyError(string code, string? upstreamMessage) => code switch
    {
        ErrorCodes.AiServiceUnavailable => "The tutor is temporarily unavailable. Please try again in a moment.",
        ErrorCodes.LlmTimeout => "The tutor took too long to answer. Please try again.",
        ErrorCodes.LlmRateLimited or ErrorCodes.LlmUnavailable => "The AI provider is busy right now. Please try again in a minute.",
        ErrorCodes.LlmDisabled => "The tutor is paused right now. Please try again later.",
        ErrorCodes.SpendCapReached => "Today's AI budget has been used up. The tutor will be back tomorrow.",
        ErrorCodes.LlmRefused => "The tutor couldn't answer that. Try rephrasing your question.",
        _ => string.IsNullOrWhiteSpace(upstreamMessage) ? "Something went wrong while answering. Please try again." : upstreamMessage,
    };

    private static string Title(string question)
    {
        var t = question.ReplaceLineEndings(" ").Trim();
        return t.Length <= 60 ? t : t[..57].TrimEnd() + "…";
    }

    private static JsonObject? ParseObject(string data)
    {
        if (string.IsNullOrWhiteSpace(data)) return null;
        try { return JsonNode.Parse(data) as JsonObject; }
        catch (JsonException) { return null; }
    }

    private static string[] ReadStrings(JsonNode? node) =>
        node is JsonArray a ? a.Select(x => x?.GetValueKind() == JsonValueKind.String ? x.GetValue<string>() : null).OfType<string>().ToArray() : [];

    private static int? ReadInt(JsonNode? node)
    {
        if (node is not JsonValue v) return null;
        if (v.TryGetValue<int>(out var i)) return i;
        if (v.TryGetValue<long>(out var l)) return (int)l;
        if (v.TryGetValue<double>(out var d)) return (int)Math.Round(d);
        return null;
    }

    private static decimal? ReadDecimal(JsonNode? node)
    {
        if (node is not JsonValue v) return null;
        if (v.TryGetValue<decimal>(out var m)) return Math.Round(m, 6);
        if (v.TryGetValue<double>(out var d)) return Math.Round((decimal)d, 6);
        return null;
    }

    private static DateTime? ReadDate(JsonNode? node)
    {
        if (node is JsonValue v && v.TryGetValue<string>(out var s) && DateTimeOffset.TryParse(s, System.Globalization.CultureInfo.InvariantCulture,
                System.Globalization.DateTimeStyles.AssumeUniversal, out var dto))
            return dto.UtcDateTime;
        return null;
    }
}
