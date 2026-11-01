using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Text;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Sathi.Api.Tests.Infrastructure;
using Sathi.Core.Domain;
using Sathi.Core.Jobs;

namespace Sathi.Api.Tests.Integration;

[Collection(IntegrationCollection.Name)]
public class IsolationAndDocumentTests(IntegrationFixture fx) : IDisposable
{
    private SathiApiFactory F => fx.Factory;

    public void Dispose() => F.Ai.Reset();

    private static MultipartFormDataContent File(string name, byte[] bytes, string contentType = "application/octet-stream")
    {
        var form = new MultipartFormDataContent();
        var file = new ByteArrayContent(bytes);
        file.Headers.ContentType = new MediaTypeHeaderValue(contentType);
        form.Add(file, "file", name);
        return form;
    }

    private static Task<HttpResponseMessage> UploadAsync(TestClient c, string name, byte[] bytes, string? key = null)
    {
        var req = new HttpRequestMessage(HttpMethod.Post, "/api/v1/documents") { Content = File(name, bytes) };
        if (key is not null) req.Headers.Add("Idempotency-Key", key);
        return c.SendAsync(req);
    }

    [Fact]
    public async Task User_B_cannot_read_stream_or_delete_user_A_resources()
    {
        var a = await F.CreateUserAsync();
        var b = await F.CreateUserAsync();
        using var alice = await TestClient.SignedInAsync(F, a.Email, a.Password);
        using var bob = await TestClient.SignedInAsync(F, b.Email, b.Password);

        var convoId = (await TestClient.ReadJsonAsync(await alice.PostAsync("/api/v1/conversations", new { courseId = fx.CourseId }))).GetProperty("id").GetGuid();
        var doc = await UploadAsync(alice, "notes.md", Encoding.UTF8.GetBytes("# My notes\nSecret study plan."));
        Assert.Equal(HttpStatusCode.Accepted, doc.StatusCode);
        var docId = (await TestClient.ReadJsonAsync(doc)).GetProperty("id").GetGuid();
        var attempt = await TestClient.ReadJsonAsync(await alice.PostAsync("/api/v1/practice/sessions", new { courseId = fx.CourseId, count = 3 }));
        var attemptId = attempt.GetProperty("attemptId").GetGuid();
        var questionId = attempt.GetProperty("questions")[0].GetProperty("id").GetGuid();
        var optionId = attempt.GetProperty("questions")[0].GetProperty("options")[0].GetProperty("id").GetGuid();

        async Task Expect404(Task<HttpResponseMessage> call)
        {
            var r = await call;
            Assert.Equal(HttpStatusCode.NotFound, r.StatusCode);
            Assert.Equal("NOT_FOUND", (await TestClient.ReadJsonAsync(r)).GetProperty("code").GetString());
        }

        await Expect404(bob.GetAsync($"/api/v1/conversations/{convoId}"));
        await Expect404(bob.SendAsync(new HttpRequestMessage(HttpMethod.Post, $"/api/v1/conversations/{convoId}/messages/stream")
        {
            Content = JsonContent.Create(new { content = "hi", level = "beginner", mode = "explain", webSearch = false }),
        }));
        await Expect404(bob.DeleteAsync($"/api/v1/conversations/{convoId}"));
        await Expect404(bob.GetAsync($"/api/v1/documents/{docId}"));
        await Expect404(bob.PostAsync($"/api/v1/documents/{docId}/retry"));
        await Expect404(bob.DeleteAsync($"/api/v1/documents/{docId}"));
        await Expect404(bob.GetAsync($"/api/v1/attempts/{attemptId}"));
        await Expect404(bob.PostAsync($"/api/v1/attempts/{attemptId}/answers", new { questionId, selectedOptionId = optionId }));
        await Expect404(bob.PostAsync($"/api/v1/attempts/{attemptId}/complete"));

        // Lists are scoped too.
        Assert.Equal(0, (await TestClient.ReadJsonAsync(await bob.GetAsync("/api/v1/documents"))).GetArrayLength());
        Assert.Equal(0, (await TestClient.ReadJsonAsync(await bob.GetAsync("/api/v1/conversations"))).GetProperty("items").GetArrayLength());

        // Alice still has everything; Bob's attempts never touched it.
        Assert.Equal(HttpStatusCode.OK, (await alice.GetAsync($"/api/v1/conversations/{convoId}")).StatusCode);
        Assert.Equal(HttpStatusCode.OK, (await alice.GetAsync($"/api/v1/documents/{docId}")).StatusCode);
        Assert.Equal(HttpStatusCode.OK, (await alice.GetAsync($"/api/v1/attempts/{attemptId}")).StatusCode);
        Assert.Equal(0, (await TestClient.ReadJsonAsync(await alice.GetAsync($"/api/v1/attempts/{attemptId}"))).GetProperty("answers").GetArrayLength());
    }

    [Fact]
    public async Task Upload_validation_and_ingestion_queueing()
    {
        var u = await F.CreateUserAsync();
        using var c = await TestClient.SignedInAsync(F, u.Email, u.Password);

        var fakePdf = await UploadAsync(c, "trojan.pdf", Encoding.ASCII.GetBytes("MZ this is not a pdf"));
        Assert.Equal(HttpStatusCode.UnsupportedMediaType, fakePdf.StatusCode);
        Assert.Equal("UPLOAD_INVALID_TYPE", (await TestClient.ReadJsonAsync(fakePdf)).GetProperty("code").GetString());

        var exe = await UploadAsync(c, "setup.exe", [0x4D, 0x5A]);
        Assert.Equal(HttpStatusCode.UnsupportedMediaType, exe.StatusCode);

        var big = await UploadAsync(c, "big.txt", Enumerable.Repeat((byte)'a', 1_100_000).ToArray());
        Assert.Equal(HttpStatusCode.RequestEntityTooLarge, big.StatusCode);
        Assert.Equal("UPLOAD_TOO_LARGE", (await TestClient.ReadJsonAsync(big)).GetProperty("code").GetString());

        var key = Guid.NewGuid().ToString();
        var ok = await UploadAsync(c, "week 1 notes.pdf", Encoding.ASCII.GetBytes("%PDF-1.4\n1 0 obj\n"), key);
        Assert.Equal(HttpStatusCode.Accepted, ok.StatusCode);
        var item = await TestClient.ReadJsonAsync(ok);
        Assert.Equal("queued", item.GetProperty("status").GetString());
        Assert.Equal("queued", item.GetProperty("stage").GetString());
        Assert.Equal(5, item.GetProperty("progressPercent").GetInt32());
        Assert.Equal("week 1 notes.pdf", item.GetProperty("fileName").GetString());
        var docId = item.GetProperty("id").GetGuid();

        // Same Idempotency-Key → same document.
        var again = await UploadAsync(c, "week 1 notes.pdf", Encoding.ASCII.GetBytes("%PDF-1.4\n1 0 obj\n"), key);
        Assert.Equal(docId, (await TestClient.ReadJsonAsync(again)).GetProperty("id").GetGuid());

        var job = F.Jobs.Jobs.Last(j => j.Job.Type == typeof(IngestDocumentJob));
        Assert.Equal(JobQueues.AiHeavy, job.Queue);
        Assert.Equal(docId, (Guid)job.Job.Args[0]!);
        Assert.Equal(1, (int)job.Job.Args[1]!);
        Assert.NotNull(job.Job.Args[2]); // traceParent
        Assert.Contains(F.Storage.Objects.Keys, k => k == $"uploads/{u.Id}/{docId}/v1/week_1_notes.pdf");
        var stored = await F.WithDbAsync(db => db.IngestionJobs.AsNoTracking().SingleAsync(j => j.DocumentId == docId));
        Assert.Equal(job.Id, stored.HangfireJobId);
        Assert.Equal(8, stored.ReferenceId!.Length);

        // Retry only for failed documents.
        Assert.Equal(HttpStatusCode.Conflict, (await c.PostAsync($"/api/v1/documents/{docId}/retry")).StatusCode);

        // Delete: soft delete + outbox event.
        Assert.Equal(HttpStatusCode.NoContent, (await c.DeleteAsync($"/api/v1/documents/{docId}")).StatusCode);
        Assert.Equal(HttpStatusCode.NotFound, (await c.GetAsync($"/api/v1/documents/{docId}")).StatusCode);
        var outbox = await F.WithDbAsync(db => db.OutboxMessages.AsNoTracking().Where(m => m.Type == OutboxTypes.DocumentDeleted).ToListAsync());
        Assert.Contains(outbox, m => m.PayloadJson.Contains(docId.ToString()));
    }

    [Fact]
    public async Task Ingest_job_runs_parse_then_index_and_is_idempotent()
    {
        var u = await F.CreateUserAsync();
        using var c = await TestClient.SignedInAsync(F, u.Email, u.Password);
        var item = await TestClient.ReadJsonAsync(await UploadAsync(c, "notes.txt", Encoding.UTF8.GetBytes("Plain notes about embeddings.")));
        var docId = item.GetProperty("id").GetGuid();
        var job = F.Jobs.Jobs.Last(j => j.Job.Type == typeof(IngestDocumentJob));
        var runId = (Guid)job.Job.Args[3]!;

        await RunIngestAsync(docId, runId);
        var done = await TestClient.ReadJsonAsync(await c.GetAsync($"/api/v1/documents/{docId}"));
        Assert.Equal("ready", done.GetProperty("status").GetString());
        Assert.Equal(100, done.GetProperty("progressPercent").GetInt32());
        Assert.Equal(4, done.GetProperty("passageCount").GetInt32());
        var run = await F.WithDbAsync(db => db.AiRuns.AsNoTracking().SingleAsync(r => r.Id == runId));
        Assert.Equal((AiRunTypes.Ingestion, AiRunStatuses.Succeeded), (run.Type, run.Status));
        var steps = await F.WithDbAsync(db => db.AiRunSteps.AsNoTracking().Where(s => s.RunId == runId).Select(s => s.Step).ToListAsync());
        Assert.Equal(["index", "parse"], steps.Order().ToArray());

        // Running it again does nothing (no second parse call).
        var before = F.Ai.Requests.Count(r => r.Path == "/internal/v1/ingest/parse");
        await RunIngestAsync(docId, runId);
        Assert.Equal(before, F.Ai.Requests.Count(r => r.Path == "/internal/v1/ingest/parse"));

        // Ingestion used the ingest scope and the owner's retrieval scope.
        var parse = F.Ai.Requests.Last(r => r.Path == "/internal/v1/ingest/parse");
        var jwt = new Microsoft.IdentityModel.JsonWebTokens.JsonWebToken(parse.Headers["Authorization"]["Bearer ".Length..]);
        Assert.Equal("ingest", jwt.GetClaim("scp").Value);
    }

    [Fact]
    public async Task Ingest_no_text_fails_immediately_with_friendly_message()
    {
        var u = await F.CreateUserAsync();
        using var c = await TestClient.SignedInAsync(F, u.Email, u.Password);
        var item = await TestClient.ReadJsonAsync(await UploadAsync(c, "scan.pdf", Encoding.ASCII.GetBytes("%PDF-1.4 scanned")));
        var docId = item.GetProperty("id").GetGuid();
        var runId = (Guid)F.Jobs.Jobs.Last(j => j.Job.Type == typeof(IngestDocumentJob)).Job.Args[3]!;
        F.Ai.IngestParseErrorCode = "INGEST_NO_TEXT";

        var ex = await Assert.ThrowsAsync<NonRetryableJobException>(() => RunIngestAsync(docId, runId));
        Assert.Equal("INGEST_NO_TEXT", ex.Code);

        var failed = await TestClient.ReadJsonAsync(await c.GetAsync($"/api/v1/documents/{docId}"));
        Assert.Equal("failed", failed.GetProperty("status").GetString());
        Assert.Equal("INGEST_NO_TEXT", failed.GetProperty("errorCode").GetString());
        Assert.StartsWith("No selectable text found.", failed.GetProperty("errorMessage").GetString());
        Assert.Matches("^[0-9A-F]{4}-[0-9A-F]{4}$", failed.GetProperty("referenceId").GetString()!);

        // Retry creates a new attempt for the same version.
        F.Ai.IngestParseErrorCode = null;
        var retry = await c.PostAsync($"/api/v1/documents/{docId}/retry");
        Assert.Equal(HttpStatusCode.Accepted, retry.StatusCode);
        var stored = await F.WithDbAsync(db => db.IngestionJobs.AsNoTracking().SingleAsync(j => j.DocumentId == docId));
        Assert.Equal((2, "queued", 1), (stored.Attempt, stored.Status, stored.DocumentVersion));
    }

    private async Task RunIngestAsync(Guid docId, Guid runId)
    {
        await using var scope = F.Services.CreateAsyncScope();
        var job = ActivatorUtilities.CreateInstance<IngestDocumentJob>(scope.ServiceProvider);
        await job.ExecuteAsync(docId, 1, null, runId, CancellationToken.None);
    }
}
