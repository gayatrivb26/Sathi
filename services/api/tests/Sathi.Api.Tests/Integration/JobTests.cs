using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.IdentityModel.JsonWebTokens;
using Sathi.Api.Tests.Infrastructure;
using Sathi.Core.Data;
using Sathi.Core.Domain;
using Sathi.Core.Jobs;
using Sathi.Core.Usage;

namespace Sathi.Api.Tests.Integration;

/// <summary>Hangfire job classes (Sathi.Core/Jobs) run directly against the test database with the stub AI service and fake storage/email.</summary>
[Collection(IntegrationCollection.Name)]
public class JobTests(IntegrationFixture fx) : IDisposable
{
    private SathiApiFactory F => fx.Factory;

    public void Dispose() => F.Ai.Reset();

    private async Task RunAsync<TJob>(Func<TJob, Task> run) where TJob : class
    {
        await using var scope = F.Services.CreateAsyncScope();
        await run(ActivatorUtilities.CreateInstance<TJob>(scope.ServiceProvider));
    }

    private async Task SetPreferencesAsync(Guid userId, string timezone, int hour, bool enabled = true) =>
        await F.WithDbAsync(async db =>
        {
            var p = await db.UserPreferences.SingleAsync(x => x.UserId == userId);
            p.Timezone = timezone;
            p.ReminderHour = hour;
            p.RemindersEnabled = enabled;
            return await db.SaveChangesAsync();
        });

    private async Task AddCardsAsync(Guid userId, int count, DateTime dueAt) =>
        await F.WithDbAsync(async db =>
        {
            var questions = await db.Questions.Where(q => q.CourseId == fx.CourseId).OrderBy(q => q.Id).Take(count).ToListAsync();
            foreach (var q in questions)
                db.RevisionCards.Add(new RevisionCard { UserId = userId, CourseId = fx.CourseId, QuestionId = q.Id, ConceptId = q.ConceptId, DueAt = dueAt });
            return await db.SaveChangesAsync();
        });

    [Fact]
    public async Task SendRevisionRemindersJob_emails_users_with_due_cards_at_their_local_reminder_hour_once_a_day()
    {
        var now = DateTime.UtcNow;
        if (now.Minute == 59 && now.Second >= 45) await Task.Delay(TimeSpan.FromSeconds(20)); // don't straddle an hour
        now = DateTime.UtcNow;
        var kolkata = TimeZoneInfo.FindSystemTimeZoneById("Asia/Kolkata");
        var kolkataHour = TimeZoneInfo.ConvertTimeFromUtc(now, kolkata).Hour;

        var utcUser = await F.CreateUserAsync();       // local hour matches (UTC) and 2 cards due → email
        var indiaUser = await F.CreateUserAsync();     // local hour matches in Asia/Kolkata → email
        var wrongHour = await F.CreateUserAsync();     // due cards but another hour → none
        var nothingDue = await F.CreateUserAsync();    // right hour, cards due tomorrow → none
        var optedOut = await F.CreateUserAsync();      // right hour, due cards, reminders off → none

        await SetPreferencesAsync(utcUser.Id, "UTC", now.Hour);
        await SetPreferencesAsync(indiaUser.Id, "Asia/Kolkata", kolkataHour);
        await SetPreferencesAsync(wrongHour.Id, "UTC", (now.Hour + 5) % 24);
        await SetPreferencesAsync(nothingDue.Id, "UTC", now.Hour);
        await SetPreferencesAsync(optedOut.Id, "UTC", now.Hour, enabled: false);
        await AddCardsAsync(utcUser.Id, 2, now.AddHours(-2));
        await AddCardsAsync(indiaUser.Id, 1, now.AddMinutes(-5));
        await AddCardsAsync(wrongHour.Id, 1, now.AddHours(-1));
        await AddCardsAsync(nothingDue.Id, 1, now.AddDays(1));
        await AddCardsAsync(optedOut.Id, 1, now.AddHours(-1));

        await RunAsync<SendRevisionRemindersJob>(j => j.ExecuteAsync(CancellationToken.None));
        await RunAsync<SendRevisionRemindersJob>(j => j.ExecuteAsync(CancellationToken.None)); // same hour again: no duplicates

        int Sent(string email) => F.Email.Sent.Count(m => string.Equals(m.To, email, StringComparison.OrdinalIgnoreCase));
        Assert.Equal(1, Sent(utcUser.Email));
        Assert.Contains("2 revision cards", F.Email.LastTo(utcUser.Email).Subject);
        Assert.Contains("http://app.test/revision", F.Email.LastTo(utcUser.Email).TextBody);
        Assert.Equal(1, Sent(indiaUser.Email));
        Assert.Equal(0, Sent(wrongHour.Email));
        Assert.Equal(0, Sent(nothingDue.Email));
        Assert.Equal(0, Sent(optedOut.Email));
        Assert.True(await F.WithDbAsync(db => db.AuditEvents.AnyAsync(e => e.Action == AuditActions.ReminderSent && e.ActorUserId == utcUser.Id)));
    }

    [Fact]
    public async Task ProcessOutboxJob_delivers_deletions_to_the_ai_service_and_storage_and_marks_them_processed()
    {
        var owner = await F.CreateUserAsync();
        var docId = Guid.CreateVersion7();
        var prefix = $"uploads/{owner.Id}/{docId}/";
        F.Storage.Objects[prefix + "v1/notes.txt"] = [1];
        F.Storage.Objects[$"parsed/{docId}/v1.json"] = [2];
        F.Storage.Objects[$"uploads/{owner.Id}/other/v1/a.txt"] = [3];
        F.Storage.Objects["uploads/someone-else/keep.txt"] = [4];

        var ownedDoc = new Document { OwnerUserId = owner.Id, Scope = DocumentScopes.User, FileName = "a.txt", ContentType = "text/plain", Sha256 = "x" };
        Guid docEvent = Guid.Empty, userEvent = Guid.Empty, unknownEvent = Guid.Empty;
        await F.WithDbAsync(async db =>
        {
            db.Documents.Add(ownedDoc);
            db.Outbox(OutboxTypes.DocumentDeleted, new { documentId = docId, storagePrefix = prefix });
            db.Outbox(OutboxTypes.UserDeleted, new { userId = owner.Id });
            db.Outbox("something.else", new { });
            await db.SaveChangesAsync();
            var rows = await db.OutboxMessages.AsNoTracking().Where(m => m.ProcessedAt == null).OrderByDescending(m => m.CreatedAt).Take(3).ToListAsync();
            docEvent = rows.Single(r => r.Type == OutboxTypes.DocumentDeleted && r.PayloadJson.Contains(docId.ToString())).Id;
            userEvent = rows.Single(r => r.Type == OutboxTypes.UserDeleted).Id;
            unknownEvent = rows.Single(r => r.Type == "something.else").Id;
            return 0;
        });

        // Other tests leave events behind too; the job works in batches of 50, oldest first.
        for (var i = 0; i < 5; i++)
        {
            await RunAsync<ProcessOutboxJob>(j => j.ExecuteAsync(CancellationToken.None));
            if (await F.WithDbAsync(db => db.OutboxMessages.CountAsync(m => (m.Id == docEvent || m.Id == userEvent) && m.ProcessedAt == null)) == 0) break;
        }

        var processed = await F.WithDbAsync(db => db.OutboxMessages.AsNoTracking().Where(m => m.Id == docEvent || m.Id == userEvent || m.Id == unknownEvent).ToListAsync());
        Assert.All(processed, m => Assert.NotNull(m.ProcessedAt));
        Assert.All(processed, m => Assert.Null(m.LastError));

        var deleteDoc = F.Ai.Requests.Single(r => r.Method == "DELETE" && r.Path == $"/internal/v1/documents/{docId}");
        Assert.Equal("ingest", new JsonWebToken(deleteDoc.Headers["Authorization"]["Bearer ".Length..]).GetClaim("scp").Value);
        var deleteUser = F.Ai.Requests.Single(r => r.Method == "DELETE" && r.Path == $"/internal/v1/users/{owner.Id}");
        Assert.Equal("admin", new JsonWebToken(deleteUser.Headers["Authorization"]["Bearer ".Length..]).GetClaim("scp").Value);

        Assert.DoesNotContain(F.Storage.Objects.Keys, k => k.StartsWith(prefix, StringComparison.Ordinal));
        Assert.DoesNotContain(F.Storage.Objects.Keys, k => k.StartsWith($"parsed/{docId}/", StringComparison.Ordinal));
        Assert.DoesNotContain(F.Storage.Objects.Keys, k => k.StartsWith($"uploads/{owner.Id}/", StringComparison.Ordinal));
        Assert.Contains("uploads/someone-else/keep.txt", F.Storage.Objects.Keys);
        Assert.NotNull((await F.WithDbAsync(db => db.Documents.AsNoTracking().SingleAsync(d => d.Id == ownedDoc.Id))).DeletedAt);
    }

    [Fact]
    public async Task ProcessOutboxJob_records_failures_and_retries_later()
    {
        var docId = Guid.CreateVersion7();
        Guid eventId = Guid.Empty;
        await F.WithDbAsync(async db =>
        {
            db.Outbox(OutboxTypes.DocumentDeleted, new { documentId = docId, storagePrefix = (string?)null });
            await db.SaveChangesAsync();
            eventId = (await db.OutboxMessages.AsNoTracking().Where(m => m.ProcessedAt == null).ToListAsync())
                .Single(m => m.PayloadJson.Contains(docId.ToString())).Id;
            // Everything older is already processed so this event is in the first batch.
            await db.OutboxMessages.Where(m => m.ProcessedAt == null && m.Id != eventId).ExecuteUpdateAsync(s => s.SetProperty(m => m.ProcessedAt, DateTime.UtcNow));
            return 0;
        });
        F.Ai.Tutor = TutorScenario.Normal;
        F.Ai.FailDeletes = true;
        await RunAsync<ProcessOutboxJob>(j => j.ExecuteAsync(CancellationToken.None));
        var failed = await F.WithDbAsync(db => db.OutboxMessages.AsNoTracking().SingleAsync(m => m.Id == eventId));
        Assert.Null(failed.ProcessedAt);
        Assert.Equal(1, failed.Attempts);
        Assert.False(string.IsNullOrEmpty(failed.LastError));

        F.Ai.FailDeletes = false;
        await RunAsync<ProcessOutboxJob>(j => j.ExecuteAsync(CancellationToken.None));
        Assert.NotNull((await F.WithDbAsync(db => db.OutboxMessages.AsNoTracking().SingleAsync(m => m.Id == eventId))).ProcessedAt);
    }

    [Fact]
    public async Task RetentionCleanupJob_purges_old_soft_deleted_rows_and_anonymises_old_deleted_users()
    {
        var user = await F.CreateUserAsync();
        var oldDeleted = await F.CreateUserAsync();
        var recentDeleted = await F.CreateUserAsync();
        var old = DateTime.UtcNow.AddDays(-31);
        var recent = DateTime.UtcNow.AddDays(-5);

        var oldConvo = new Conversation { UserId = user.Id, CourseId = fx.CourseId, DeletedAt = old };
        var recentConvo = new Conversation { UserId = user.Id, CourseId = fx.CourseId, DeletedAt = recent };
        var liveConvo = new Conversation { UserId = user.Id, CourseId = fx.CourseId };
        var oldDoc = new Document { OwnerUserId = user.Id, FileName = "old.txt", ContentType = "text/plain", Sha256 = "x", DeletedAt = old };
        var recentDoc = new Document { OwnerUserId = user.Id, FileName = "recent.txt", ContentType = "text/plain", Sha256 = "x", DeletedAt = recent };
        var oldRun = new AiRun { TraceId = new string('b', 32), ReferenceId = "BBBBBBBB", UserIdHash = "h", StartedAt = DateTime.UtcNow.AddDays(-100) };
        var newRun = new AiRun { TraceId = new string('c', 32), ReferenceId = "CCCCCCCC", UserIdHash = "h", StartedAt = DateTime.UtcNow.AddDays(-1) };
        var oldStep = new AiRunStep { RunId = oldRun.Id, Step = "retrieve", StartedAt = oldRun.StartedAt, MetricsJson = "{\"resultCount\": 6}" };
        var newStep = new AiRunStep { RunId = newRun.Id, Step = "retrieve", StartedAt = newRun.StartedAt, MetricsJson = "{\"resultCount\": 2}" };
        var oldOutbox = new OutboxMessage { Type = OutboxTypes.UserDeleted, ProcessedAt = old, CreatedAt = old };
        var recentOutbox = new OutboxMessage { Type = OutboxTypes.UserDeleted, ProcessedAt = recent, CreatedAt = recent };
        await F.WithDbAsync(async db =>
        {
            db.AddRange(oldConvo, recentConvo, liveConvo, oldDoc, recentDoc, oldRun, newRun, oldStep, newStep, oldOutbox, recentOutbox);
            foreach (var (id, when) in new[] { (oldDeleted.Id, old), (recentDeleted.Id, recent) })
            {
                var u = await db.Users.SingleAsync(x => x.Id == id);
                u.DeletedAt = when;
                u.DateOfBirth = new DateOnly(2011, 1, 1);
                u.IsMinor = true;
                u.GuardianEmailNormalized = "guardian@example.com";
            }
            return await db.SaveChangesAsync();
        });

        await RunAsync<RetentionCleanupJob>(j => j.ExecuteAsync(CancellationToken.None));

        await F.WithDbAsync(async db =>
        {
            Assert.False(await db.Conversations.AnyAsync(c => c.Id == oldConvo.Id));
            Assert.True(await db.Conversations.AnyAsync(c => c.Id == recentConvo.Id));
            Assert.True(await db.Conversations.AnyAsync(c => c.Id == liveConvo.Id));
            Assert.False(await db.Documents.AnyAsync(d => d.Id == oldDoc.Id));
            Assert.True(await db.Documents.AnyAsync(d => d.Id == recentDoc.Id));
            Assert.Equal("{}", (await db.AiRunSteps.AsNoTracking().SingleAsync(s => s.Id == oldStep.Id)).MetricsJson.Replace(" ", ""));
            Assert.Contains("resultCount", (await db.AiRunSteps.AsNoTracking().SingleAsync(s => s.Id == newStep.Id)).MetricsJson);
            Assert.False(await db.OutboxMessages.AnyAsync(m => m.Id == oldOutbox.Id));
            Assert.True(await db.OutboxMessages.AnyAsync(m => m.Id == recentOutbox.Id));

            var anon = await db.Users.AsNoTracking().SingleAsync(u => u.Id == oldDeleted.Id);
            Assert.Equal($"deleted-{oldDeleted.Id:N}@deleted.invalid", anon.Email);
            Assert.Equal("Deleted user", anon.DisplayName);
            Assert.Null(anon.PasswordHash);
            Assert.Null(anon.DateOfBirth);
            Assert.Null(anon.GuardianEmailNormalized);
            var kept = await db.Users.AsNoTracking().SingleAsync(u => u.Id == recentDeleted.Id);
            Assert.Equal(recentDeleted.Email, kept.Email);
            Assert.NotNull(kept.DateOfBirth);
            return 0;
        });
    }
}
