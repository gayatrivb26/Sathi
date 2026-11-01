using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Extensions.Options;
using Microsoft.IdentityModel.JsonWebTokens;
using Microsoft.IdentityModel.Tokens;
using Sathi.Api.Modules.Tutor;
using Sathi.Api.Tests.Infrastructure;
using Sathi.Core.Domain;
using Sathi.Core.Errors;
using Sathi.Core.Jobs;
using Sathi.Core.Options;

namespace Sathi.Api.Tests.Integration;

/// <summary>Contract §11.5 (cancel, stale streams, history paging), §11.6 (upload idempotency) and §11.7 (RS256 on the wire).</summary>
[Collection(IntegrationCollection.Name)]
public class TutorRelease2Tests(IntegrationFixture fx) : IDisposable
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
        return (client, userId, (await TestClient.ReadJsonAsync(created)).GetProperty("id").GetGuid());
    }

    private static HttpRequestMessage StreamRequest(Guid conversationId) => new(HttpMethod.Post, $"/api/v1/conversations/{conversationId}/messages/stream")
    {
        Content = JsonContent.Create(new { content = "Explain backpropagation slowly", level = "beginner", mode = "explain", webSearch = false }),
    };

    private async Task<T> WaitForAsync<T>(Func<Task<T>> read, Func<T, bool> done, TimeSpan timeout)
    {
        var until = DateTime.UtcNow + timeout;
        while (true)
        {
            var value = await read();
            if (done(value) || DateTime.UtcNow > until) return value;
            await Task.Delay(100);
        }
    }

    [Fact]
    public async Task Cancel_aborts_the_upstream_stream_and_keeps_the_partial_answer()
    {
        var (client, userId, convoId) = await StartAsync();
        F.Ai.TokenDelay = TimeSpan.FromMilliseconds(300);
        F.Ai.Tokens = Enumerable.Range(1, 30).Select(i => $"word{i} ").ToArray();

        using var cts = new CancellationTokenSource(TimeSpan.FromSeconds(30));
        using var resp = await client.SendAsync(StreamRequest(convoId), HttpCompletionOption.ResponseHeadersRead, cts.Token);
        await using var stream = await resp.Content.ReadAsStreamAsync(cts.Token);
        var runs = F.Services.GetRequiredService<ActiveTutorRuns>();
        var tokens = 0;
        var messageId = Guid.Empty;
        var wasActive = false;
        Task<HttpResponseMessage>? cancel = null;
        // One reader for the whole stream; the cancel request is sent (concurrently) after the second token.
        var frames = await SseParsing.ReadAsync(stream, f =>
        {
            if (f.Event == "start") messageId = f.Data.GetProperty("assistantMessageId").GetGuid();
            if (f.Event == "token" && ++tokens == 2)
            {
                wasActive = runs.IsActive(messageId);
                cancel = client.PostAsync($"/api/v1/conversations/{convoId}/messages/{messageId}/cancel");
            }
            return f.Event is "done" or "error";
        }, cts.Token);
        Assert.True(wasActive);
        Assert.NotNull(cancel);
        Assert.Equal(HttpStatusCode.Accepted, (await cancel).StatusCode);
        var runId = frames[0].Data.GetProperty("runId").GetGuid();

        // The browser still gets a terminal event carrying the partial text.
        var terminal = frames[^1];
        Assert.Equal("done", terminal.Event);
        Assert.Equal("cancelled", terminal.Data.GetProperty("status").GetString());
        Assert.Contains("CANCELLED", terminal.Data.GetProperty("warnings").EnumerateArray().Select(w => w.GetString()));
        Assert.True(frames.Count(f => f.Event == "token") < F.Ai.Tokens.Length);

        // Someone else cannot cancel it.
        var other = await F.CreateUserAsync();
        using (var intruder = await TestClient.SignedInAsync(F, other.Email, other.Password))
            Assert.Equal(HttpStatusCode.NotFound, (await intruder.PostAsync($"/api/v1/conversations/{convoId}/messages/{messageId}/cancel")).StatusCode);

        var msg = await WaitForAsync(() => F.WithDbAsync(db => db.Messages.AsNoTracking().SingleAsync(m => m.Id == messageId)),
            m => m.Status != MessageStatuses.Streaming, TimeSpan.FromSeconds(10));
        Assert.Equal(MessageStatuses.Cancelled, msg.Status);
        Assert.StartsWith("word1 word2 ", msg.Content);
        Assert.True(msg.Content.Length < string.Concat(F.Ai.Tokens).Length);
        Assert.Null(msg.ErrorCode);
        var run = await F.WithDbAsync(db => db.AiRuns.AsNoTracking().SingleAsync(r => r.Id == runId));
        Assert.Equal(AiRunStatuses.Cancelled, run.Status);
        Assert.True(run.OutputTokens > 0);
        var usage = await F.WithDbAsync(db => db.UsageRecords.AsNoTracking().SingleAsync(u => u.UserId == userId && u.Kind == UsageKinds.Chat));
        Assert.Equal(run.OutputTokens, (int)usage.OutputTokens);

        // The upstream request was aborted: the stub saw its reader go away long before the 30 tokens were written.
        await WaitForAsync(() => Task.FromResult(F.Ai.UpstreamAborts), n => n > 0, TimeSpan.FromSeconds(5));
        Assert.True(F.Ai.UpstreamAborts > 0);
        Assert.False(F.Services.GetRequiredService<ActiveTutorRuns>().IsActive(messageId));

        // Idempotent; the conversation shows the cancelled message.
        Assert.Equal(HttpStatusCode.Accepted, (await client.PostAsync($"/api/v1/conversations/{convoId}/messages/{messageId}/cancel")).StatusCode);
        var convo = await TestClient.ReadJsonAsync(await client.GetAsync($"/api/v1/conversations/{convoId}"));
        Assert.Equal("cancelled", convo.GetProperty("messages")[1].GetProperty("status").GetString());
        client.Dispose();
    }

    [Fact]
    public async Task Cancel_of_a_stream_not_live_on_this_instance_marks_it_cancelled()
    {
        var (client, userId, convoId) = await StartAsync();
        var (messageId, runId) = await InsertStreamingAsync(convoId, userId, DateTime.UtcNow.AddSeconds(-5));
        Assert.Equal(HttpStatusCode.Accepted, (await client.PostAsync($"/api/v1/conversations/{convoId}/messages/{messageId}/cancel")).StatusCode);
        var msg = await F.WithDbAsync(db => db.Messages.AsNoTracking().SingleAsync(m => m.Id == messageId));
        Assert.Equal(MessageStatuses.Cancelled, msg.Status);
        Assert.Equal(AiRunStatuses.Cancelled, (await F.WithDbAsync(db => db.AiRuns.AsNoTracking().SingleAsync(r => r.Id == runId))).Status);
        Assert.Equal(HttpStatusCode.NotFound, (await client.PostAsync($"/api/v1/conversations/{convoId}/messages/{Guid.NewGuid()}/cancel")).StatusCode);
        client.Dispose();
    }

    private async Task<(Guid MessageId, Guid RunId)> InsertStreamingAsync(Guid convoId, Guid userId, DateTime createdAt)
    {
        var runId = Guid.CreateVersion7();
        var messageId = Guid.CreateVersion7();
        await F.WithDbAsync(async db =>
        {
            db.AiRuns.Add(new AiRun { Id = runId, TraceId = new string('a', 32), ReferenceId = "AAAAAAAA", UserId = userId, UserIdHash = "x", StartedAt = createdAt });
            db.Messages.Add(new Message
            {
                Id = messageId, ConversationId = convoId, Role = MessageRoles.Assistant, Content = "half an ans", Status = MessageStatuses.Streaming,
                RunId = runId, CreatedAt = createdAt,
            });
            return await db.SaveChangesAsync();
        });
        return (messageId, runId);
    }

    [Fact]
    public async Task Stale_streams_are_interrupted_on_read_and_by_the_recurring_job()
    {
        var (client, userId, convoId) = await StartAsync();
        var (staleId, staleRun) = await InsertStreamingAsync(convoId, userId, DateTime.UtcNow.AddMinutes(-10));
        var (freshId, _) = await InsertStreamingAsync(convoId, userId, DateTime.UtcNow.AddSeconds(-10));

        var convo = await TestClient.ReadJsonAsync(await client.GetAsync($"/api/v1/conversations/{convoId}"));
        var messages = convo.GetProperty("messages").EnumerateArray().ToDictionary(m => m.GetProperty("id").GetGuid());
        Assert.Equal("failed", messages[staleId].GetProperty("status").GetString());
        Assert.Equal("STREAM_INTERRUPTED", messages[staleId].GetProperty("errorCode").GetString());
        Assert.Equal("streaming", messages[freshId].GetProperty("status").GetString());
        var persisted = await F.WithDbAsync(db => db.Messages.AsNoTracking().SingleAsync(m => m.Id == staleId));
        Assert.Equal((MessageStatuses.Failed, ErrorCodes.StreamInterrupted), (persisted.Status, persisted.ErrorCode));
        var run = await F.WithDbAsync(db => db.AiRuns.AsNoTracking().SingleAsync(r => r.Id == staleRun));
        Assert.Equal((AiRunStatuses.Failed, ErrorCodes.StreamInterrupted), (run.Status, run.ErrorCode));

        // The recurring job does the same for every user without anyone opening the conversation.
        var (other, otherRun) = await InsertStreamingAsync(convoId, userId, DateTime.UtcNow.AddMinutes(-4));
        await using (var scope = F.Services.CreateAsyncScope())
        {
            var job = ActivatorUtilities.CreateInstance<RecoverStaleStreamsJob>(scope.ServiceProvider,
                Options.Create(new TutorOptions { StaleStreamMinutes = 3 }), NullLogger<RecoverStaleStreamsJob>.Instance);
            await job.ExecuteAsync(CancellationToken.None);
        }
        Assert.Equal(MessageStatuses.Failed, (await F.WithDbAsync(db => db.Messages.AsNoTracking().SingleAsync(m => m.Id == other))).Status);
        Assert.Equal(AiRunStatuses.Failed, (await F.WithDbAsync(db => db.AiRuns.AsNoTracking().SingleAsync(r => r.Id == otherRun))).Status);
        Assert.Equal(MessageStatuses.Streaming, (await F.WithDbAsync(db => db.Messages.AsNoTracking().SingleAsync(m => m.Id == freshId))).Status);
        client.Dispose();
    }

    [Fact]
    public async Task Conversation_history_pages_with_a_cursor_without_gaps_or_repeats()
    {
        var (client, userId, firstId) = await StartAsync();
        var ids = new List<Guid> { firstId };
        for (var i = 0; i < 4; i++)
            ids.Add((await TestClient.ReadJsonAsync(await client.PostAsync("/api/v1/conversations", new { courseId = fx.CourseId }))).GetProperty("id").GetGuid());
        // Two conversations share an updated_at (tie broken by id).
        var same = DateTime.UtcNow.AddMinutes(-1);
        await F.WithDbAsync(db => db.Conversations.Where(c => c.Id == ids[1] || c.Id == ids[2]).ExecuteUpdateAsync(s => s.SetProperty(c => c.UpdatedAt, same)));

        var seen = new List<Guid>();
        string? cursor = null;
        var pages = 0;
        do
        {
            var page = await TestClient.ReadJsonAsync(await client.GetAsync($"/api/v1/conversations?limit=2&courseId={fx.CourseId}"
                                                                             + (cursor is null ? "" : "&cursor=" + cursor)));
            seen.AddRange(page.GetProperty("items").EnumerateArray().Select(c => c.GetProperty("id").GetGuid()));
            cursor = page.GetProperty("nextCursor").ValueKind == JsonValueKind.Null ? null : page.GetProperty("nextCursor").GetString();
            pages++;
        } while (cursor is not null && pages < 10);
        Assert.Equal(3, pages);
        Assert.Equal(5, seen.Count);
        Assert.Equal(ids.OrderBy(x => x), seen.OrderBy(x => x));
        Assert.Equal(HttpStatusCode.BadRequest, (await client.GetAsync("/api/v1/conversations?cursor=bm9wZQ")).StatusCode);
        client.Dispose();
    }

    [Fact]
    public async Task Upstream_service_token_is_rs256_with_kid_and_verifies_with_the_public_key()
    {
        var (client, userId, convoId) = await StartAsync();
        using (var resp = await client.SendAsync(StreamRequest(convoId), HttpCompletionOption.ResponseHeadersRead))
            await SseParsing.ReadAsync(await resp.Content.ReadAsStreamAsync());
        var token = F.Ai.Requests.Last(r => r.Path == "/internal/v1/tutor/stream").Headers["Authorization"]["Bearer ".Length..];
        var jwt = new JsonWebToken(token);
        Assert.Equal(("RS256", TestKeys.KeyId), (jwt.Alg, jwt.Kid));
        using var rsa = RSA.Create();
        rsa.ImportFromPem(TestKeys.PublicKeyPem);
        var result = await new JsonWebTokenHandler().ValidateTokenAsync(token, new TokenValidationParameters
        {
            ValidIssuer = "sathi-api", ValidAudience = "ai-service", ValidAlgorithms = [SecurityAlgorithms.RsaSha256],
            IssuerSigningKey = new RsaSecurityKey(rsa) { KeyId = TestKeys.KeyId },
        });
        Assert.True(result.IsValid, result.Exception?.Message);
        Assert.Equal(userId.ToString(), jwt.Subject);
        client.Dispose();
    }

    [Fact]
    public async Task Upload_idempotency_key_is_persisted_and_returns_the_original_document()
    {
        var u = await F.CreateUserAsync();
        using var c = await TestClient.SignedInAsync(F, u.Email, u.Password);
        var key = "upload-" + Guid.NewGuid();

        async Task<HttpResponseMessage> Upload(string name, string text, string? k)
        {
            var form = new MultipartFormDataContent();
            var file = new ByteArrayContent(Encoding.UTF8.GetBytes(text));
            file.Headers.ContentType = new MediaTypeHeaderValue("text/plain");
            form.Add(file, "file", name);
            var req = new HttpRequestMessage(HttpMethod.Post, "/api/v1/documents") { Content = form };
            if (k is not null) req.Headers.Add("Idempotency-Key", k);
            return await c.SendAsync(req);
        }

        var first = await TestClient.ReadJsonAsync(await Upload("a.txt", "first", key));
        var docId = first.GetProperty("id").GetGuid();
        var stored = await F.WithDbAsync(db => db.Documents.AsNoTracking().SingleAsync(d => d.Id == docId));
        Assert.Equal(key, stored.IdempotencyKey);
        var jobsBefore = F.Jobs.Jobs.Count;

        // Same key (even with another file) → the original document, nothing new stored or queued.
        var again = await Upload("b.txt", "second", key);
        Assert.Equal(HttpStatusCode.Accepted, again.StatusCode);
        Assert.Equal(docId, (await TestClient.ReadJsonAsync(again)).GetProperty("id").GetGuid());
        Assert.Equal(jobsBefore, F.Jobs.Jobs.Count);
        Assert.Equal(1, await F.WithDbAsync(db => db.Documents.CountAsync(d => d.OwnerUserId == u.Id)));

        // The key is per user: another user with the same key gets their own document.
        var v = await F.CreateUserAsync();
        using var c2 = await TestClient.SignedInAsync(F, v.Email, v.Password);
        var form = new MultipartFormDataContent { { new ByteArrayContent("x"u8.ToArray()), "file", "c.txt" } };
        var req2 = new HttpRequestMessage(HttpMethod.Post, "/api/v1/documents") { Content = form };
        req2.Headers.Add("Idempotency-Key", key);
        var theirs = await TestClient.ReadJsonAsync(await c2.SendAsync(req2));
        Assert.NotEqual(docId, theirs.GetProperty("id").GetGuid());

        // A different key creates a new document.
        Assert.NotEqual(docId, (await TestClient.ReadJsonAsync(await Upload("d.txt", "third", key + "-2"))).GetProperty("id").GetGuid());
    }
}
