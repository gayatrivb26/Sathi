using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Microsoft.EntityFrameworkCore;
using Microsoft.IdentityModel.JsonWebTokens;
using Sathi.Api.Tests.Infrastructure;
using Sathi.Core.Domain;

namespace Sathi.Api.Tests.Integration;

[Collection(IntegrationCollection.Name)]
public class TutorStreamTests(IntegrationFixture fx) : IDisposable
{
    private SathiApiFactory F => fx.Factory;

    public void Dispose() => F.Ai.Reset();

    private async Task<(TestClient Client, Guid UserId, Guid ConversationId)> StartAsync()
    {
        F.Ai.Reset();
        var (userId, email, password) = await F.CreateUserAsync();
        var client = await TestClient.SignedInAsync(F, email, password);
        var created = await client.PostAsync("/api/v1/conversations", new { courseId = fx.CourseId });
        Assert.Equal(HttpStatusCode.Created, created.StatusCode);
        var id = (await TestClient.ReadJsonAsync(created)).GetProperty("id").GetGuid();
        return (client, userId, id);
    }

    private static HttpRequestMessage StreamRequest(Guid conversationId, string content = "What is gradient descent?", string? key = null, bool webSearch = false)
    {
        var req = new HttpRequestMessage(HttpMethod.Post, $"/api/v1/conversations/{conversationId}/messages/stream")
        {
            Content = JsonContent.Create(new { content, level = "beginner", mode = "explain", adjust = (string?)null, webSearch }),
        };
        if (key is not null) req.Headers.Add("Idempotency-Key", key);
        return req;
    }

    private async Task<Message> WaitForAssistantAsync(Guid conversationId, Func<Message, bool> done, TimeSpan timeout)
    {
        var until = DateTime.UtcNow + timeout;
        while (true)
        {
            var msg = await F.WithDbAsync(db => db.Messages.AsNoTracking()
                .Where(m => m.ConversationId == conversationId && m.Role == MessageRoles.Assistant).OrderByDescending(m => m.CreatedAt).FirstAsync());
            if (done(msg) || DateTime.UtcNow > until) return msg;
            await Task.Delay(100);
        }
    }

    [Fact]
    public async Task Relays_events_and_persists_the_complete_answer()
    {
        var (client, userId, convoId) = await StartAsync();
        using var resp = await client.SendAsync(StreamRequest(convoId, webSearch: true), HttpCompletionOption.ResponseHeadersRead);
        Assert.Equal(HttpStatusCode.OK, resp.StatusCode);
        Assert.Equal("text/event-stream", resp.Content.Headers.ContentType?.MediaType);
        var frames = await SseParsing.ReadAsync(await resp.Content.ReadAsStreamAsync());

        var names = frames.Select(f => f.Event).ToList();
        Assert.Equal("start", names[0]);
        Assert.Equal("done", names[^1]);
        Assert.Contains("status", names);
        Assert.Contains("citation", names);
        Assert.Contains("usage", names);
        Assert.Equal(F.Ai.Tokens.Length, names.Count(n => n == "token"));
        Assert.All(frames, f => Assert.False(string.IsNullOrEmpty(f.Data.GetProperty("requestId").GetString())));
        Assert.All(frames, f => Assert.NotEqual("up", f.Data.GetProperty("requestId").GetString()));

        var start = frames[0].Data;
        var runId = start.GetProperty("runId").GetGuid();
        var assistantId = start.GetProperty("assistantMessageId").GetGuid();
        Assert.Matches("^[0-9A-F]{4}-[0-9A-F]{4}$", start.GetProperty("referenceId").GetString()!);
        var done = frames[^1].Data;
        Assert.Equal(assistantId, done.GetProperty("messageId").GetGuid());
        Assert.Equal(F.Ai.FullAnswer, done.GetProperty("content").GetString());
        Assert.False(done.TryGetProperty("steps", out _));

        // Persisted state.
        var msg = await F.WithDbAsync(db => db.Messages.AsNoTracking().FirstAsync(m => m.Id == assistantId));
        Assert.Equal(MessageStatuses.Complete, msg.Status);
        Assert.Equal(F.Ai.FullAnswer, msg.Content);
        Assert.Equal(["course"], msg.AnswerBasis);
        Assert.Contains("\"sourceType\": \"course\"", msg.CitationsJson.Replace("\":\"", "\": \""));
        var run = await F.WithDbAsync(db => db.AiRuns.AsNoTracking().FirstAsync(r => r.Id == runId));
        Assert.Equal(AiRunStatuses.Succeeded, run.Status);
        Assert.Equal("fake-model", run.Model);
        Assert.Equal("sha256:tutor", run.PromptHash);
        Assert.Equal(120, run.InputTokens);
        Assert.Equal(0.0012m, run.EstimatedCostUsd);
        Assert.NotNull(run.TtftMs);
        Assert.Equal(convoId, run.ConversationId);
        var steps = await F.WithDbAsync(db => db.AiRunSteps.AsNoTracking().Where(s => s.RunId == runId).ToListAsync());
        Assert.Equal(["llm", "retrieve"], steps.Select(s => s.Step).Order().ToArray());
        var usage = await F.WithDbAsync(db => db.UsageRecords.AsNoTracking().Where(u => u.UserId == userId).ToListAsync());
        Assert.Equal(1, usage.Single(u => u.Kind == UsageKinds.Chat).Count);
        Assert.Equal(120, usage.Single(u => u.Kind == UsageKinds.Chat).InputTokens);
        Assert.Equal(1, usage.Single(u => u.Kind == UsageKinds.WebSearch).Count);

        // Upstream call carried the service token, run id and trace context.
        var upstream = F.Ai.Requests.Last(r => r.Path == "/internal/v1/tutor/stream");
        Assert.Equal(runId.ToString(), upstream.Headers["X-Run-Id"]);
        Assert.True(upstream.Headers.ContainsKey("traceparent"));
        Assert.Contains(run.TraceId, upstream.Headers["traceparent"]);
        Assert.False(string.IsNullOrEmpty(upstream.Headers["X-Request-Id"]));
        var jwt = new JsonWebToken(upstream.Headers["Authorization"]["Bearer ".Length..]);
        Assert.Equal("tutor", jwt.GetClaim("scp").Value);
        Assert.Equal("sathi-api", jwt.Issuer);
        Assert.Equal(userId.ToString(), jwt.Subject);
        var payload = JsonDocument.Parse(Microsoft.IdentityModel.Tokens.Base64UrlEncoder.Decode(jwt.EncodedPayload)).RootElement;
        Assert.Contains(fx.CourseId.ToString(), payload.GetProperty("rscope").GetProperty("course_ids").EnumerateArray().Select(e => e.GetString()));
        Assert.Equal(userId.ToString(), payload.GetProperty("rscope").GetProperty("user_id").GetString());
        var body = JsonDocument.Parse(upstream.Body).RootElement;
        Assert.Equal("What is gradient descent?", body.GetProperty("question").GetString());
        Assert.Equal(runId, body.GetProperty("runId").GetGuid());
        Assert.Equal("Test Course", body.GetProperty("course").GetProperty("title").GetString());

        // Conversation read model shows both messages and the reference id.
        var convo = await TestClient.ReadJsonAsync(await client.GetAsync($"/api/v1/conversations/{convoId}"));
        var messages = convo.GetProperty("messages");
        Assert.Equal(2, messages.GetArrayLength());
        Assert.Equal("assistant", messages[1].GetProperty("role").GetString());
        Assert.Equal(1, messages[1].GetProperty("citations").GetArrayLength());
        Assert.Equal("What is gradient descent?", convo.GetProperty("title").GetString());
        client.Dispose();
    }

    [Fact]
    public async Task Browser_disconnect_mid_stream_still_saves_the_complete_message()
    {
        var (client, _, convoId) = await StartAsync();
        F.Ai.TokenDelay = TimeSpan.FromMilliseconds(250);
        F.Ai.Tokens = ["One ", "two ", "three ", "four ", "five ", "six."];

        using (var cts = new CancellationTokenSource(TimeSpan.FromSeconds(20)))
        {
            var resp = await client.SendAsync(StreamRequest(convoId), HttpCompletionOption.ResponseHeadersRead, cts.Token);
            var stream = await resp.Content.ReadAsStreamAsync(cts.Token);
            var frames = await SseParsing.ReadAsync(stream, f => f.Event == "token", cts.Token);
            Assert.Equal("token", frames[^1].Event);
            // The browser goes away after the first token.
            stream.Dispose();
            resp.Dispose();
        }

        var msg = await WaitForAssistantAsync(convoId, m => m.Status != MessageStatuses.Streaming, TimeSpan.FromSeconds(15));
        Assert.Equal(MessageStatuses.Complete, msg.Status);
        Assert.Equal("One two three four five six.", msg.Content);
        var run = await F.WithDbAsync(db => db.AiRuns.AsNoTracking().FirstAsync(r => r.Id == msg.RunId));
        Assert.Equal(AiRunStatuses.Succeeded, run.Status);
        client.Dispose();
    }

    [Fact]
    public async Task Unreachable_ai_service_yields_error_event_and_failed_message()
    {
        var (client, _, convoId) = await StartAsync();
        F.Ai.Tutor = TutorScenario.Unavailable;
        using var resp = await client.SendAsync(StreamRequest(convoId), HttpCompletionOption.ResponseHeadersRead);
        var frames = await SseParsing.ReadAsync(await resp.Content.ReadAsStreamAsync());
        Assert.Equal(["start", "error"], frames.Select(f => f.Event).ToArray());
        var error = frames[1].Data;
        Assert.Equal("AI_SERVICE_UNAVAILABLE", error.GetProperty("code").GetString());
        Assert.Equal(frames[0].Data.GetProperty("referenceId").GetString(), error.GetProperty("referenceId").GetString());
        Assert.False(string.IsNullOrWhiteSpace(error.GetProperty("message").GetString()));

        var msg = await WaitForAssistantAsync(convoId, m => m.Status != MessageStatuses.Streaming, TimeSpan.FromSeconds(5));
        Assert.Equal(MessageStatuses.Failed, msg.Status);
        Assert.Equal("AI_SERVICE_UNAVAILABLE", msg.ErrorCode);
        var run = await F.WithDbAsync(db => db.AiRuns.AsNoTracking().FirstAsync(r => r.Id == msg.RunId));
        Assert.Equal((AiRunStatuses.Failed, "AI_SERVICE_UNAVAILABLE"), (run.Status, run.ErrorCode));
        client.Dispose();
    }

    [Fact]
    public async Task Upstream_error_after_tokens_saves_partial_answer()
    {
        var (client, _, convoId) = await StartAsync();
        F.Ai.Tutor = TutorScenario.UpstreamError;
        using var resp = await client.SendAsync(StreamRequest(convoId), HttpCompletionOption.ResponseHeadersRead);
        var frames = await SseParsing.ReadAsync(await resp.Content.ReadAsStreamAsync());
        Assert.Equal("error", frames[^1].Event);
        Assert.Equal("LLM_TIMEOUT", frames[^1].Data.GetProperty("code").GetString());
        var msg = await WaitForAssistantAsync(convoId, m => m.Status != MessageStatuses.Streaming, TimeSpan.FromSeconds(5));
        Assert.Equal(MessageStatuses.Partial, msg.Status);
        Assert.Equal("Gradient descent ", msg.Content);
        client.Dispose();
    }

    [Fact]
    public async Task Stream_dropped_without_done_is_partial_with_ai_service_unavailable()
    {
        var (client, _, convoId) = await StartAsync();
        F.Ai.Tutor = TutorScenario.DropMidStream;
        using var resp = await client.SendAsync(StreamRequest(convoId), HttpCompletionOption.ResponseHeadersRead);
        var frames = await SseParsing.ReadAsync(await resp.Content.ReadAsStreamAsync());
        Assert.Equal("AI_SERVICE_UNAVAILABLE", frames[^1].Data.GetProperty("code").GetString());
        var msg = await WaitForAssistantAsync(convoId, m => m.Status != MessageStatuses.Streaming, TimeSpan.FromSeconds(5));
        Assert.Equal(MessageStatuses.Partial, msg.Status);
        client.Dispose();
    }

    [Fact]
    public async Task Repeated_idempotency_key_returns_409_conflict()
    {
        var (client, _, convoId) = await StartAsync();
        var key = Guid.NewGuid().ToString();
        using (var first = await client.SendAsync(StreamRequest(convoId, key: key), HttpCompletionOption.ResponseHeadersRead))
            await SseParsing.ReadAsync(await first.Content.ReadAsStreamAsync());

        var second = await client.SendAsync(StreamRequest(convoId, key: key));
        Assert.Equal(HttpStatusCode.Conflict, second.StatusCode);
        Assert.Equal("CONFLICT", (await TestClient.ReadJsonAsync(second)).GetProperty("code").GetString());
        Assert.Equal(2, await F.WithDbAsync(db => db.Messages.CountAsync(m => m.ConversationId == convoId)));
        client.Dispose();
    }

    [Fact]
    public async Task Adjust_simpler_sends_previous_answer_and_history()
    {
        var (client, _, convoId) = await StartAsync();
        Guid assistantId;
        using (var first = await client.SendAsync(StreamRequest(convoId), HttpCompletionOption.ResponseHeadersRead))
            assistantId = (await SseParsing.ReadAsync(await first.Content.ReadAsStreamAsync()))[0].Data.GetProperty("assistantMessageId").GetGuid();

        var req = new HttpRequestMessage(HttpMethod.Post, $"/api/v1/conversations/{convoId}/messages/stream")
        {
            Content = JsonContent.Create(new { content = "", level = "beginner", mode = "explain", adjust = "simpler", webSearch = false, replyToMessageId = assistantId }),
        };
        using (var second = await client.SendAsync(req, HttpCompletionOption.ResponseHeadersRead))
            Assert.Equal("done", (await SseParsing.ReadAsync(await second.Content.ReadAsStreamAsync()))[^1].Event);

        var body = JsonDocument.Parse(F.Ai.Requests.Last(r => r.Path == "/internal/v1/tutor/stream").Body).RootElement;
        Assert.Equal("simpler", body.GetProperty("adjust").GetString());
        Assert.Equal(F.Ai.FullAnswer, body.GetProperty("previousAnswer").GetString());
        Assert.Equal("Explain that more simply", body.GetProperty("question").GetString());
        Assert.Equal(2, body.GetProperty("history").GetArrayLength());

        var fb = await client.PostAsync($"/api/v1/messages/{assistantId}/feedback", new { rating = 1 });
        Assert.Equal(HttpStatusCode.NoContent, fb.StatusCode);
        client.Dispose();
    }

    [Fact]
    public async Task Admin_can_look_up_a_run_by_reference_id()
    {
        var (client, _, convoId) = await StartAsync();
        string reference;
        Guid runId;
        using (var resp = await client.SendAsync(StreamRequest(convoId), HttpCompletionOption.ResponseHeadersRead))
        {
            var start = (await SseParsing.ReadAsync(await resp.Content.ReadAsStreamAsync()))[0].Data;
            reference = start.GetProperty("referenceId").GetString()!;
            runId = start.GetProperty("runId").GetGuid();
        }

        // Students are forbidden.
        Assert.Equal(HttpStatusCode.Forbidden, (await client.GetAsync($"/api/v1/admin/runs/lookup/{reference}")).StatusCode);

        var (_, adminEmail, adminPassword) = await F.CreateUserAsync(Roles.Admin);
        using var admin = await TestClient.SignedInAsync(F, adminEmail, adminPassword);
        foreach (var key in new[] { reference, reference.Replace("-", "").ToLowerInvariant(), runId.ToString() })
        {
            var r = await admin.GetAsync($"/api/v1/admin/runs/lookup/{key}");
            Assert.Equal(HttpStatusCode.OK, r.StatusCode);
            var detail = await TestClient.ReadJsonAsync(r);
            Assert.Equal(reference, detail.GetProperty("run").GetProperty("referenceId").GetString());
            Assert.Equal(2, detail.GetProperty("steps").GetArrayLength());
            var traceId = detail.GetProperty("run").GetProperty("traceId").GetString()!;
            Assert.Contains(traceId, Uri.UnescapeDataString(detail.GetProperty("links").GetProperty("grafanaLogs").GetString()!));
            Assert.Contains(traceId, Uri.UnescapeDataString(detail.GetProperty("links").GetProperty("grafanaTrace").GetString()!));
            Assert.Equal(JsonValueKind.Object, detail.GetProperty("aiService").ValueKind);
        }
        var traceLookup = await TestClient.ReadJsonAsync(await admin.GetAsync($"/api/v1/admin/runs/lookup/{runId}"));
        var byTrace = await admin.GetAsync($"/api/v1/admin/runs/lookup/{traceLookup.GetProperty("run").GetProperty("traceId").GetString()}");
        Assert.Equal(HttpStatusCode.OK, byTrace.StatusCode);
        Assert.Equal(HttpStatusCode.NotFound, (await admin.GetAsync("/api/v1/admin/runs/lookup/0000-0000")).StatusCode);

        var runs = await TestClient.ReadJsonAsync(await admin.GetAsync("/api/v1/admin/runs?type=chat&limit=5"));
        Assert.True(runs.GetProperty("items").GetArrayLength() > 0);
        var usage = await TestClient.ReadJsonAsync(await admin.GetAsync("/api/v1/admin/usage?days=7"));
        Assert.Equal(7, usage.GetProperty("days").GetArrayLength());
        Assert.Equal(HttpStatusCode.NoContent, (await admin.PutAsync("/api/v1/admin/log-level", new { level = "info" })).StatusCode);
        client.Dispose();
    }
}
