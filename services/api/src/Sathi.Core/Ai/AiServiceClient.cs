using System.Diagnostics;
using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Runtime.CompilerServices;
using System.Text.Json;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;
using Sathi.Core.Errors;
using Sathi.Core.Options;
using Sathi.Core.Security;

namespace Sathi.Core.Ai;

/// <summary>Ambient request id (set by the API middleware and the Hangfire filter) forwarded as X-Request-Id.</summary>
public static class RequestCorrelation
{
    private static readonly AsyncLocal<string?> Current = new();

    public static string? RequestId
    {
        get => Current.Value;
        set => Current.Value = value;
    }
}

/// <summary>Who/what an AI-service call is for. Drives the service token's sub/scp/rscope and X-Run-Id.</summary>
public sealed record AiCallContext(
    Guid? UserId,
    IReadOnlyCollection<string> Scopes,
    IReadOnlyCollection<Guid>? CourseIds = null,
    Guid? ScopeUserId = null,
    Guid? RunId = null)
{
    public static AiCallContext System(params string[] scopes) => new(null, scopes);
}

/// <summary>A failed AI-service call. Code is the AI service's ProblemDetails code or AI_SERVICE_UNAVAILABLE.</summary>
public sealed class AiServiceException(string code, int status, string message, bool transient, Exception? inner = null)
    : Exception(message, inner)
{
    public string Code { get; } = code;
    public int Status { get; } = status;
    public bool IsTransient { get; } = transient;
}

/// <summary>Typed client for the AI service internal API (contract §6).</summary>
public sealed class AiServiceClient(
    IHttpClientFactory factory,
    ServiceTokenIssuer tokens,
    IOptions<AiOptions> options,
    ILogger<AiServiceClient> logger)
{
    public const string ClientName = "ai";
    public const string IngestClientName = "ai-ingest";

    private readonly AiOptions _options = options.Value;

    // ---------------- Tutor stream ----------------

    /// <summary>
    /// Opens POST /internal/v1/tutor/stream and yields SSE events. Throws <see cref="AiServiceException"/> (AI_SERVICE_UNAVAILABLE)
    /// when the service cannot be reached or answers non-2xx before the stream starts.
    /// </summary>
    public async IAsyncEnumerable<SseEvent> StreamTutorAsync(TutorRequest body, AiCallContext ctx, [EnumeratorCancellation] CancellationToken ct)
    {
        var client = factory.CreateClient(ClientName);
        using var request = Build(HttpMethod.Post, "/internal/v1/tutor/stream", ctx, body);
        request.Headers.Accept.Add(new MediaTypeWithQualityHeaderValue("text/event-stream"));

        HttpResponseMessage response;
        try
        {
            response = await client.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, ct).ConfigureAwait(false);
        }
        catch (Exception ex) when (ex is HttpRequestException or TaskCanceledException && !ct.IsCancellationRequested)
        {
            throw new AiServiceException(ErrorCodes.AiServiceUnavailable, 503, "AI service unreachable", true, ex);
        }

        using (response)
        {
            if (!response.IsSuccessStatusCode)
                throw await ToExceptionAsync(response, ct).ConfigureAwait(false);

            var stream = await response.Content.ReadAsStreamAsync(ct).ConfigureAwait(false);
            await foreach (var e in SseReader.ReadAsync(stream, ct).ConfigureAwait(false))
                yield return e;
        }
    }

    // ---------------- Ingestion (Ai:IngestBaseUrl) ----------------

    public Task<ParseResponse> ParseAsync(ParseRequest body, AiCallContext ctx, CancellationToken ct) =>
        SendAsync<ParseResponse>(IngestClientName, HttpMethod.Post, "/internal/v1/ingest/parse", ctx, body, ct);

    public Task<IndexResponse> IndexAsync(IndexRequest body, AiCallContext ctx, CancellationToken ct) =>
        SendAsync<IndexResponse>(IngestClientName, HttpMethod.Post, "/internal/v1/ingest/index", ctx, body, ct);

    public Task<IndexResponse> IngestTextAsync(IngestTextRequest body, AiCallContext ctx, CancellationToken ct) =>
        SendAsync<IndexResponse>(IngestClientName, HttpMethod.Post, "/internal/v1/ingest/text", ctx, body, ct);

    public Task DeleteDocumentAsync(Guid documentId, AiCallContext ctx, CancellationToken ct) =>
        SendAsync<JsonElement?>(IngestClientName, HttpMethod.Delete, $"/internal/v1/documents/{documentId}", ctx, null, ct);

    public Task DeleteUserAsync(Guid userId, AiCallContext ctx, CancellationToken ct) =>
        SendAsync<JsonElement?>(ClientName, HttpMethod.Delete, $"/internal/v1/users/{userId}", ctx, null, ct);

    // ---------------- Assessment ----------------

    public Task<QuizGenerateResponse> GenerateQuizAsync(QuizGenerateRequest body, AiCallContext ctx, CancellationToken ct) =>
        SendAsync<QuizGenerateResponse>(ClientName, HttpMethod.Post, "/internal/v1/quiz/generate", ctx, body, ct);

    public Task<GradeResponse> GradeAsync(GradeRequest body, AiCallContext ctx, CancellationToken ct) =>
        SendAsync<GradeResponse>(ClientName, HttpMethod.Post, "/internal/v1/grade", ctx, body, ct);

    public Task<MasteryUpdateResponse> UpdateMasteryAsync(MasteryUpdateRequest body, AiCallContext ctx, CancellationToken ct) =>
        SendAsync<MasteryUpdateResponse>(ClientName, HttpMethod.Post, "/internal/v1/mastery/update", ctx, body, ct);

    public Task<RecommendationsResponse> RecommendationsAsync(RecommendationsRequest body, AiCallContext ctx, CancellationToken ct) =>
        SendAsync<RecommendationsResponse>(ClientName, HttpMethod.Post, "/internal/v1/recommendations", ctx, body, ct);

    // ---------------- Ops ----------------

    public Task<JsonElement?> GetRunAsync(Guid runId, AiCallContext ctx, CancellationToken ct) =>
        SendAsync<JsonElement?>(ClientName, HttpMethod.Get, $"/internal/v1/runs/{runId}", ctx, null, ct);

    public Task<JsonElement?> RunEvaluationAsync(EvalRunRequest body, AiCallContext ctx, CancellationToken ct) =>
        SendAsync<JsonElement?>(ClientName, HttpMethod.Post, "/internal/v1/eval/run", ctx, body, ct);

    public Task SetDebugCaptureAsync(DebugCaptureRequest body, AiCallContext ctx, CancellationToken ct) =>
        SendAsync<JsonElement?>(ClientName, HttpMethod.Put, "/internal/v1/admin/debug-capture", ctx, body, ct);

    public async Task<bool> IsHealthyAsync(CancellationToken ct)
    {
        try
        {
            var client = factory.CreateClient(ClientName);
            using var cts = CancellationTokenSource.CreateLinkedTokenSource(ct);
            cts.CancelAfter(TimeSpan.FromSeconds(3));
            using var resp = await client.GetAsync("/health/live", cts.Token).ConfigureAwait(false);
            return resp.IsSuccessStatusCode;
        }
        catch (Exception ex) when (ex is HttpRequestException or TaskCanceledException)
        {
            return false;
        }
    }

    // ---------------- plumbing ----------------

    private HttpRequestMessage Build(HttpMethod method, string path, AiCallContext ctx, object? body)
    {
        var requestId = RequestCorrelation.RequestId ?? Guid.NewGuid().ToString("N");
        var request = new HttpRequestMessage(method, path);
        var token = tokens.Issue(new ServiceTokenRequest(ctx.UserId, ctx.Scopes, ctx.CourseIds, ctx.ScopeUserId, requestId));
        request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", token);
        request.Headers.TryAddWithoutValidation("X-Request-Id", requestId);
        if (ctx.RunId is { } runId) request.Headers.TryAddWithoutValidation("X-Run-Id", runId.ToString("D"));
        // W3C traceparent/tracestate from the current Activity. HttpClient's own propagation does the same but only inside
        // SocketsHttpHandler and never overwrites an existing header, so injecting here is safe and handler-independent.
        if (Activity.Current is { } activity)
            DistributedContextPropagator.Current.Inject(activity, request, static (carrier, key, value) =>
            {
                if (carrier is HttpRequestMessage r && key is not null && !r.Headers.Contains(key))
                    r.Headers.TryAddWithoutValidation(key, value);
            });
        if (body is not null) request.Content = JsonContent.Create(body, body.GetType(), options: AiJson.Options);
        return request;
    }

    private async Task<T> SendAsync<T>(string clientName, HttpMethod method, string path, AiCallContext ctx, object? body, CancellationToken ct)
    {
        var client = factory.CreateClient(clientName);
        using var request = Build(method, path, ctx, body);
        using var cts = CancellationTokenSource.CreateLinkedTokenSource(ct);
        cts.CancelAfter(TimeSpan.FromSeconds(_options.TimeoutSeconds));

        HttpResponseMessage response;
        try
        {
            response = await client.SendAsync(request, cts.Token).ConfigureAwait(false);
        }
        catch (Exception ex) when (ex is HttpRequestException or TaskCanceledException or OperationCanceledException && !ct.IsCancellationRequested)
        {
            logger.LogDebug(ex, "AI service call {path} failed to connect", path);
            throw new AiServiceException(ErrorCodes.AiServiceUnavailable, 503, $"AI service unreachable ({path})", true, ex);
        }

        using (response)
        {
            if (!response.IsSuccessStatusCode) throw await ToExceptionAsync(response, ct).ConfigureAwait(false);
            if (response.StatusCode == HttpStatusCode.NoContent || response.Content.Headers.ContentLength == 0) return default!;
            try
            {
                return (await response.Content.ReadFromJsonAsync<T>(AiJson.Options, ct).ConfigureAwait(false))!;
            }
            catch (JsonException ex)
            {
                throw new AiServiceException(ErrorCodes.AiServiceUnavailable, 502, $"AI service returned an invalid body ({path})", true, ex);
            }
        }
    }

    private static async Task<AiServiceException> ToExceptionAsync(HttpResponseMessage response, CancellationToken ct)
    {
        var status = (int)response.StatusCode;
        string code = ErrorCodes.AiServiceUnavailable;
        string message = $"AI service returned {status}";
        try
        {
            var text = await response.Content.ReadAsStringAsync(ct).ConfigureAwait(false);
            if (!string.IsNullOrWhiteSpace(text))
            {
                using var doc = JsonDocument.Parse(text);
                if (doc.RootElement.ValueKind == JsonValueKind.Object)
                {
                    if (doc.RootElement.TryGetProperty("code", out var c) && c.ValueKind == JsonValueKind.String) code = c.GetString()!;
                    if (doc.RootElement.TryGetProperty("detail", out var d) && d.ValueKind == JsonValueKind.String) message = d.GetString()!;
                    else if (doc.RootElement.TryGetProperty("message", out var m) && m.ValueKind == JsonValueKind.String) message = m.GetString()!;
                }
            }
        }
        catch (JsonException) { }

        // 4xx (other than 408/429) are deterministic: retrying will not help.
        var transient = status >= 500 || status is 408 or 429;
        return new AiServiceException(code, status, message, transient);
    }
}
