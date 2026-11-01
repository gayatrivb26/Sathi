using System.Collections.Concurrent;
using System.IO.Pipelines;
using System.Net;
using System.Net.Http.Headers;
using System.Text;
using System.Text.Json;

namespace Sathi.Api.Tests.Infrastructure;

public sealed record CapturedRequest(string Method, string Path, IReadOnlyDictionary<string, string> Headers, string Body);

public enum TutorScenario { Normal, Unavailable, UpstreamError, DropMidStream }

/// <summary>
/// Stands in for the FastAPI service. The tutor stream emits the contract §6.1 events (status → tokens → citation → usage → done)
/// through a pipe, so delays between events are real and the browser can disconnect mid-stream.
/// </summary>
public sealed class StubAiHandler : HttpMessageHandler
{
    public ConcurrentQueue<CapturedRequest> Requests { get; } = new();
    public TutorScenario Tutor { get; set; } = TutorScenario.Normal;
    public TimeSpan TokenDelay { get; set; } = TimeSpan.Zero;
    public string[] Tokens { get; set; } = ["Gradient ", "descent ", "steps ", "downhill ", "[1]."];
    public string? IngestParseErrorCode { get; set; }
    public bool MasteryUnavailable { get; set; }

    public bool FailDeletes { get; set; }

    private int _upstreamAborts;

    /// <summary>Tutor streams whose reader (the .NET side) went away before the stub finished writing.</summary>
    public int UpstreamAborts => Volatile.Read(ref _upstreamAborts);

    public void Reset()
    {
        Tutor = TutorScenario.Normal;
        TokenDelay = TimeSpan.Zero;
        Tokens = ["Gradient ", "descent ", "steps ", "downhill ", "[1]."];
        IngestParseErrorCode = null;
        MasteryUnavailable = false;
        FailDeletes = false;
        Requests.Clear();
    }

    public string FullAnswer => string.Concat(Tokens);

    protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
    {
        var body = request.Content is null ? "" : await request.Content.ReadAsStringAsync(cancellationToken);
        var headers = request.Headers.ToDictionary(h => h.Key, h => string.Join(",", h.Value), StringComparer.OrdinalIgnoreCase);
        var path = request.RequestUri!.AbsolutePath;
        Requests.Enqueue(new CapturedRequest(request.Method.Method, path, headers, body));

        switch (path)
        {
            case "/health/live":
                return Json(new { status = "ok" });
            case "/internal/v1/tutor/stream":
                return Tutor switch
                {
                    TutorScenario.Unavailable => throw new HttpRequestException("Connection refused (stub)"),
                    _ => StreamTutor(body),
                };
            case "/internal/v1/mastery/update":
            {
                if (MasteryUnavailable) return Problem(503, "LLM_UNAVAILABLE");
                using var doc = JsonDocument.Parse(body);
                var r = doc.RootElement;
                var m = r.GetProperty("prior").GetDouble();
                var attempts = r.GetProperty("attempts").GetInt32();
                var d = r.GetProperty("difficulty").GetDouble();
                var o = r.TryGetProperty("score", out var s) && s.ValueKind == JsonValueKind.Number ? s.GetDouble() : r.GetProperty("correct").GetBoolean() ? 1 : 0;
                var p = 1 / (1 + Math.Exp(-6 * (m - d)));
                var k = Math.Max(0.06, 0.30 / Math.Sqrt(1 + attempts));
                return Json(new { mastery = Math.Clamp(m + k * (o - p), 0.02, 0.98) });
            }
            case "/internal/v1/recommendations":
                return Json(new { items = Array.Empty<object>() });
            case "/internal/v1/ingest/parse":
                if (IngestParseErrorCode is { } code) return Problem(422, code);
                return Json(new { pageCount = 2, charCount = 1200, parsedKey = "parsed/doc/v1.json" });
            case "/internal/v1/ingest/index":
            case "/internal/v1/ingest/text":
                return Json(new { passageCount = 4, embeddingModel = "fake-embed" });
            case "/internal/v1/grade":
                return Json(new
                {
                    score = 2.0, maxScore = 3.0, confidence = 0.9, feedback = "Good, mention magnitude.",
                    criteriaScores = new[] { new { id = "c1", points = 2.0, comment = "ok" } },
                    model = "fake", promptHash = "sha256:abc", inputTokens = 10, outputTokens = 5, costUsd = 0.0001,
                });
            default:
                if (request.Method == HttpMethod.Delete
                    && (path.StartsWith("/internal/v1/documents/", StringComparison.Ordinal) || path.StartsWith("/internal/v1/users/", StringComparison.Ordinal)))
                    return FailDeletes ? Problem(503, "AI_SERVICE_UNAVAILABLE") : new HttpResponseMessage(HttpStatusCode.NoContent);
                if (path.StartsWith("/internal/v1/runs/", StringComparison.Ordinal))
                    return Json(new { modelRuns = Array.Empty<object>(), retrievalRuns = Array.Empty<object>(), searchRuns = Array.Empty<object>() });
                return new HttpResponseMessage(HttpStatusCode.NotFound);
        }
    }

    private HttpResponseMessage StreamTutor(string requestBody)
    {
        var pipe = new Pipe();
        var tokens = Tokens;
        var delay = TokenDelay;
        var scenario = Tutor;
        _ = Task.Run(async () =>
        {
            async Task Send(string evt, object data)
            {
                var frame = $"event: {evt}\ndata: {JsonSerializer.Serialize(data, JsonSerializerOptions.Web)}\n\n";
                var result = await pipe.Writer.WriteAsync(Encoding.UTF8.GetBytes(frame));
                // The reader completed early: .NET closed the upstream connection (cancel / disconnect).
                if (result.IsCompleted) throw new ReaderGoneException();
            }
            try
            {
                await pipe.Writer.WriteAsync(Encoding.UTF8.GetBytes(": ping\n\n"));
                await Send("status", new { stage = "retrieving", message = "Looking through your course…", requestId = "up" });
                await Send("status", new { stage = "generating", message = "Writing an answer…", requestId = "up" });
                for (var i = 0; i < tokens.Length; i++)
                {
                    if (delay > TimeSpan.Zero) await Task.Delay(delay);
                    await Send("token", new { text = tokens[i], requestId = "up" });
                    if (scenario == TutorScenario.DropMidStream && i == 1) { await pipe.Writer.CompleteAsync(); return; }
                    if (scenario == TutorScenario.UpstreamError && i == 1)
                    {
                        await Send("error", new { code = "LLM_TIMEOUT", message = "Provider timed out", requestId = "up" });
                        await pipe.Writer.CompleteAsync();
                        return;
                    }
                }
                await Send("citation", new
                {
                    index = 1, sourceType = "course", title = "Gradient descent", documentId = Guid.Empty, lessonId = (Guid?)null, page = (int?)null,
                    url = (string?)null, snippet = "We update w ← w − η∇L.", requestId = "up",
                });
                await Send("usage", new { inputTokens = 120, outputTokens = 40, costUsd = 0.0012, model = "fake-model", ttftMs = 15, latencyMs = 90, requestId = "up" });
                await Send("done", new
                {
                    content = string.Concat(tokens), answerBasis = new[] { "course" }, citationsValid = 1, citationsDropped = 0, warnings = Array.Empty<string>(),
                    requestId = "up",
                    steps = new[]
                    {
                        new { step = "retrieve", startedAt = DateTime.UtcNow.AddMilliseconds(-80), endedAt = DateTime.UtcNow.AddMilliseconds(-60), outcome = "ok", metrics = new { method = "hybrid", resultCount = 6 } },
                        new { step = "llm", startedAt = DateTime.UtcNow.AddMilliseconds(-60), endedAt = DateTime.UtcNow, outcome = "ok", metrics = new { method = "fake", resultCount = 0 } },
                    },
                    run = new { provider = "fake", model = "fake-model", promptHash = "sha256:tutor", inputTokens = 120, outputTokens = 40, costUsd = 0.0012, ttftMs = 15, latencyMs = 90 },
                });
                await pipe.Writer.CompleteAsync();
            }
            catch (ReaderGoneException)
            {
                Interlocked.Increment(ref _upstreamAborts);
                await pipe.Writer.CompleteAsync();
            }
            catch (Exception ex)
            {
                await pipe.Writer.CompleteAsync(ex);
            }
        });

        var content = new StreamContent(pipe.Reader.AsStream());
        content.Headers.ContentType = new MediaTypeHeaderValue("text/event-stream");
        return new HttpResponseMessage(HttpStatusCode.OK) { Content = content };
    }

    private static HttpResponseMessage Json(object body) => new(HttpStatusCode.OK)
    {
        Content = new StringContent(JsonSerializer.Serialize(body, JsonSerializerOptions.Web), Encoding.UTF8, "application/json"),
    };

    private static HttpResponseMessage Problem(int status, string code) => new((HttpStatusCode)status)
    {
        Content = new StringContent(JsonSerializer.Serialize(new { status, code, detail = code }), Encoding.UTF8, "application/problem+json"),
    };
}

internal sealed class ReaderGoneException : Exception;
