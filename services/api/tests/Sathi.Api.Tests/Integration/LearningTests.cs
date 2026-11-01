using System.Net;
using System.Text.Json;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Sathi.Api.Tests.Infrastructure;
using Sathi.Core.Domain;
using Sathi.Core.Jobs;

namespace Sathi.Api.Tests.Integration;

[Collection(IntegrationCollection.Name)]
public class LearningTests(IntegrationFixture fx) : IDisposable
{
    private SathiApiFactory F => fx.Factory;

    public void Dispose() => F.Ai.Reset();

    private static Guid CorrectOption(JsonElement question) =>
        question.GetProperty("options").EnumerateArray().First(o => o.GetProperty("text").GetString() == "Right").GetProperty("id").GetGuid();

    private static Guid WrongOption(JsonElement question) =>
        question.GetProperty("options").EnumerateArray().First(o => o.GetProperty("text").GetString() != "Right").GetProperty("id").GetGuid();

    [Fact]
    public async Task Diagnostic_sets_priors_and_completes_onboarding()
    {
        var u = await F.CreateUserAsync();
        using var c = await TestClient.SignedInAsync(F, u.Email, u.Password);

        var courses = await TestClient.ReadJsonAsync(await c.GetAsync("/api/v1/courses"));
        Assert.Contains(courses.EnumerateArray(), x => x.GetProperty("id").GetGuid() == fx.CourseId);
        Assert.Equal(HttpStatusCode.OK, (await c.PostAsync($"/api/v1/courses/{fx.CourseId}/enroll")).StatusCode);

        var attempt = await TestClient.ReadJsonAsync(await c.PostAsync($"/api/v1/courses/{fx.CourseId}/diagnostic"));
        Assert.Equal("diagnostic", attempt.GetProperty("kind").GetString());
        var questions = attempt.GetProperty("questions").EnumerateArray().ToList();
        Assert.Equal(3, questions.Count); // one per concept
        var attemptId = attempt.GetProperty("attemptId").GetGuid();

        var right = await TestClient.ReadJsonAsync(await c.PostAsync($"/api/v1/attempts/{attemptId}/answers",
            new { questionId = questions[0].GetProperty("id").GetGuid(), selectedOptionId = CorrectOption(questions[0]) }, Guid.NewGuid().ToString()));
        Assert.True(right.GetProperty("isCorrect").GetBoolean());
        Assert.Equal(0.60, right.GetProperty("mastery").GetProperty("after").GetDouble(), 3);
        Assert.Equal(CorrectOption(questions[0]), right.GetProperty("correctOptionId").GetGuid());

        var wrong = await TestClient.ReadJsonAsync(await c.PostAsync($"/api/v1/attempts/{attemptId}/answers",
            new { questionId = questions[1].GetProperty("id").GetGuid(), selectedOptionId = WrongOption(questions[1]) }));
        Assert.False(wrong.GetProperty("isCorrect").GetBoolean());
        Assert.Equal(0.25, wrong.GetProperty("mastery").GetProperty("after").GetDouble(), 3);

        // Answering the same question again returns the stored result.
        var replay = await TestClient.ReadJsonAsync(await c.PostAsync($"/api/v1/attempts/{attemptId}/answers",
            new { questionId = questions[0].GetProperty("id").GetGuid(), selectedOptionId = WrongOption(questions[0]) }));
        Assert.Equal(right.GetProperty("answerId").GetGuid(), replay.GetProperty("answerId").GetGuid());

        var complete = await TestClient.ReadJsonAsync(await c.PostAsync($"/api/v1/attempts/{attemptId}/complete"));
        Assert.Equal(1, complete.GetProperty("correct").GetInt32());
        Assert.Equal(3, complete.GetProperty("total").GetInt32());
        Assert.Equal(2, complete.GetProperty("masteryChanges").GetArrayLength());
        Assert.True(complete.GetProperty("studyNext").GetArrayLength() is > 0 and <= 3);

        var me = await TestClient.ReadJsonAsync(await c.GetAsync("/api/v1/auth/me"));
        Assert.True(me.GetProperty("onboardingCompleted").GetBoolean());
        Assert.Equal(fx.CourseId, me.GetProperty("preferences").GetProperty("activeCourseId").GetGuid());

        // Every answered question has a revision card.
        Assert.Equal(2, await F.WithDbAsync(db => db.RevisionCards.CountAsync(r => r.UserId == u.Id)));

        var home = await TestClient.ReadJsonAsync(await c.GetAsync("/api/v1/home"));
        Assert.Equal(fx.CourseId, home.GetProperty("course").GetProperty("id").GetGuid());
        Assert.Equal("Gradient descent", home.GetProperty("continueLesson").GetProperty("title").GetString());
        var mastery = home.GetProperty("mastery").EnumerateArray().ToList();
        Assert.Equal(2, mastery.Count);
        Assert.True(mastery[0].GetProperty("mastery").GetDouble() >= mastery[1].GetProperty("mastery").GetDouble());
        Assert.True(mastery[1].GetProperty("needsWork").GetBoolean());
        Assert.Equal(1, home.GetProperty("streakDays").GetInt32());

        var progress = await TestClient.ReadJsonAsync(await c.GetAsync($"/api/v1/progress?courseId={fx.CourseId}"));
        Assert.Equal(3, progress.GetProperty("mastery").GetArrayLength());
        Assert.Equal(3, progress.GetProperty("lessonCount").GetInt32());
        Assert.Equal(1, progress.GetProperty("quizzes").GetArrayLength());
        Assert.True(progress.GetProperty("masteryTrend").GetArrayLength() >= 1);
    }

    [Fact]
    public async Task Practice_uses_ai_mastery_update_and_keeps_prior_when_unavailable()
    {
        var u = await F.CreateUserAsync();
        using var c = await TestClient.SignedInAsync(F, u.Email, u.Password);
        var concept = (await TestClient.ReadJsonAsync(await c.GetAsync($"/api/v1/courses/{fx.CourseId}"))).GetProperty("concepts")[0].GetProperty("id").GetGuid();
        var attempt = await TestClient.ReadJsonAsync(await c.PostAsync("/api/v1/practice/sessions", new { courseId = fx.CourseId, conceptId = concept, count = 3 }));
        var attemptId = attempt.GetProperty("attemptId").GetGuid();
        var qs = attempt.GetProperty("questions").EnumerateArray().ToList();
        Assert.Equal(3, qs.Count);

        var first = await TestClient.ReadJsonAsync(await c.PostAsync($"/api/v1/attempts/{attemptId}/answers",
            new { questionId = qs[0].GetProperty("id").GetGuid(), selectedOptionId = CorrectOption(qs[0]) }));
        var m = first.GetProperty("mastery");
        Assert.Equal(0.30, m.GetProperty("before").GetDouble(), 3);
        Assert.True(m.GetProperty("after").GetDouble() > 0.30);

        F.Ai.MasteryUnavailable = true;
        var second = await TestClient.ReadJsonAsync(await c.PostAsync($"/api/v1/attempts/{attemptId}/answers",
            new { questionId = qs[1].GetProperty("id").GetGuid(), selectedOptionId = WrongOption(qs[1]) }));
        Assert.Equal(second.GetProperty("mastery").GetProperty("before").GetDouble(), second.GetProperty("mastery").GetProperty("after").GetDouble(), 6);
        Assert.Contains(F.Logs.Lines, l => l.Contains("\"event\":\"mastery.fallback\"") && l.Contains("\"level\":\"warning\""));
    }

    [Fact]
    public async Task Short_answer_is_queued_for_grading_and_graded_by_the_job()
    {
        var u = await F.CreateUserAsync();
        using var c = await TestClient.SignedInAsync(F, u.Email, u.Password);
        var shortQ = await F.WithDbAsync(db => db.Questions.AsNoTracking().FirstAsync(q => q.CourseId == fx.CourseId && q.Type == QuestionTypes.Short));
        var attempt = await TestClient.ReadJsonAsync(await c.PostAsync("/api/v1/practice/sessions",
            new { courseId = fx.CourseId, conceptId = shortQ.ConceptId, count = 10 }));
        var attemptId = attempt.GetProperty("attemptId").GetGuid();
        Assert.Contains(attempt.GetProperty("questions").EnumerateArray(), q => q.GetProperty("id").GetGuid() == shortQ.Id);

        var result = await TestClient.ReadJsonAsync(await c.PostAsync($"/api/v1/attempts/{attemptId}/answers",
            new { questionId = shortQ.Id, freeText = "Cosine compares direction, not magnitude." }));
        Assert.Equal("pending", result.GetProperty("grading").GetProperty("status").GetString());
        Assert.Equal(JsonValueKind.Null, result.GetProperty("isCorrect").ValueKind);

        var job = F.Jobs.Jobs.Last(j => j.Job.Type == typeof(GradeAnswerJob));
        Assert.Equal(JobQueues.Critical, job.Queue);
        await using (var scope = F.Services.CreateAsyncScope())
            await ActivatorUtilities.CreateInstance<GradeAnswerJob>(scope.ServiceProvider)
                .ExecuteAsync((Guid)job.Job.Args[0]!, null, (Guid)job.Job.Args[2]!, CancellationToken.None);

        var polled = await TestClient.ReadJsonAsync(await c.GetAsync($"/api/v1/attempts/{attemptId}/answers/{result.GetProperty("answerId").GetGuid()}"));
        Assert.Equal("auto_accepted", polled.GetProperty("grading").GetProperty("status").GetString());
        Assert.Equal(2.0, polled.GetProperty("grading").GetProperty("score").GetDouble());
        Assert.True(polled.GetProperty("isCorrect").GetBoolean());
    }

    [Fact]
    public async Task Revision_review_applies_sm2()
    {
        var u = await F.CreateUserAsync();
        using var c = await TestClient.SignedInAsync(F, u.Email, u.Password);
        var q = await F.WithDbAsync(db => db.Questions.AsNoTracking().Include(x => x.Options).FirstAsync(x => x.CourseId == fx.CourseId && x.Type == QuestionTypes.Mcq));
        await F.WithDbAsync(async db =>
        {
            db.RevisionCards.Add(new RevisionCard
            {
                UserId = u.Id, CourseId = fx.CourseId, QuestionId = q.Id, ConceptId = q.ConceptId, EaseFactor = 2.5, IntervalDays = 1, Repetitions = 1,
                DueAt = DateTime.UtcNow.AddHours(-1),
            });
            return await db.SaveChangesAsync();
        });

        var due = await TestClient.ReadJsonAsync(await c.GetAsync($"/api/v1/revision/due?courseId={fx.CourseId}"));
        Assert.Equal(1, due.GetProperty("dueCount").GetInt32());
        var cardId = due.GetProperty("cards")[0].GetProperty("cardId").GetGuid();
        var correct = q.Options.First(o => o.IsCorrect).Id;
        var review = await TestClient.ReadJsonAsync(await c.PostAsync($"/api/v1/revision/cards/{cardId}/review", new { selectedOptionId = correct }));
        Assert.True(review.GetProperty("isCorrect").GetBoolean());
        Assert.Equal(3, review.GetProperty("intervalDays").GetInt32());

        var schedule = await TestClient.ReadJsonAsync(await c.GetAsync($"/api/v1/revision/schedule?courseId={fx.CourseId}"));
        Assert.Equal(14, schedule.GetProperty("days").GetArrayLength());
        Assert.Equal(1, schedule.GetProperty("days").EnumerateArray().Sum(d => d.GetProperty("count").GetInt32()));
    }

    [Fact]
    public async Task Lessons_and_course_outline()
    {
        var u = await F.CreateUserAsync();
        using var c = await TestClient.SignedInAsync(F, u.Email, u.Password);
        var course = await TestClient.ReadJsonAsync(await c.GetAsync($"/api/v1/courses/{fx.CourseId}"));
        var modules = course.GetProperty("modules");
        Assert.Equal(2, modules.GetArrayLength());
        var lessonId = modules[1].GetProperty("lessons")[0].GetProperty("id").GetGuid();

        var lesson = await TestClient.ReadJsonAsync(await c.GetAsync($"/api/v1/lessons/{lessonId}"));
        Assert.Equal("Embeddings", lesson.GetProperty("title").GetString());
        Assert.Equal(2, lesson.GetProperty("lessonCount").GetInt32());
        Assert.NotEqual(JsonValueKind.Null, lesson.GetProperty("previousLessonId").ValueKind);
        Assert.NotEqual(JsonValueKind.Null, lesson.GetProperty("nextLessonId").ValueKind);
        Assert.Contains("Cosine", lesson.GetProperty("contentMarkdown").GetString());

        Assert.Equal(HttpStatusCode.NoContent, (await c.PostAsync($"/api/v1/lessons/{lessonId}/progress", new { percent = 55, completed = false })).StatusCode);
        var home = await TestClient.ReadJsonAsync(await c.GetAsync($"/api/v1/home?courseId={fx.CourseId}"));
        Assert.Equal(lessonId, home.GetProperty("continueLesson").GetProperty("lessonId").GetGuid());
        Assert.Equal(55, home.GetProperty("continueLesson").GetProperty("percent").GetInt32());
        Assert.Equal(HttpStatusCode.NotFound, (await c.GetAsync($"/api/v1/lessons/{Guid.NewGuid()}")).StatusCode);
    }

    [Fact]
    public async Task Instructor_endpoints_require_staff_and_bump_lesson_version()
    {
        var student = await F.CreateUserAsync();
        using var s = await TestClient.SignedInAsync(F, student.Email, student.Password);
        Assert.Equal(HttpStatusCode.Forbidden, (await s.GetAsync("/api/v1/instructor/courses")).StatusCode);

        var teacher = await F.CreateUserAsync(Roles.Instructor);
        using var t = await TestClient.SignedInAsync(F, teacher.Email, teacher.Password);
        // Release 2: instructors manage only courses they have a course_instructors row for.
        var courses = await TestClient.ReadJsonAsync(await t.GetAsync("/api/v1/instructor/courses"));
        Assert.DoesNotContain(courses.EnumerateArray(), x => x.GetProperty("id").GetGuid() == fx.CourseId);
        Assert.Equal(HttpStatusCode.NotFound, (await t.GetAsync($"/api/v1/instructor/insights?courseId={fx.CourseId}")).StatusCode);
        await F.WithDbAsync(async db =>
        {
            db.CourseInstructors.Add(new CourseInstructor { CourseId = fx.CourseId, UserId = teacher.Id, Role = CourseInstructorRoles.Instructor });
            return await db.SaveChangesAsync();
        });
        courses = await TestClient.ReadJsonAsync(await t.GetAsync("/api/v1/instructor/courses"));
        var mine = courses.EnumerateArray().Single(x => x.GetProperty("id").GetGuid() == fx.CourseId);
        Assert.Equal("instructor", mine.GetProperty("myRole").GetString());
        Assert.Equal("public", mine.GetProperty("visibility").GetString());

        var slug = "course-" + Guid.NewGuid().ToString("N")[..8];
        var created = await t.PostAsync("/api/v1/instructor/courses", new { title = "New course", slug, description = "d", isPublished = false });
        Assert.Equal(HttpStatusCode.Created, created.StatusCode);
        var createdBody = await TestClient.ReadJsonAsync(created);
        var courseId = createdBody.GetProperty("id").GetGuid();
        Assert.Equal("owner", createdBody.GetProperty("myRole").GetString());
        var module = await TestClient.ReadJsonAsync(await t.PostAsync($"/api/v1/instructor/courses/{courseId}/modules", new { title = "M1", summary = "", position = 1 }));
        var concept = await TestClient.ReadJsonAsync(await t.PostAsync($"/api/v1/instructor/courses/{courseId}/concepts", new { name = "C1", slug = "c1", description = "", prerequisiteIds = Array.Empty<Guid>() }));
        var lesson = await TestClient.ReadJsonAsync(await t.PostAsync($"/api/v1/instructor/modules/{module.GetProperty("id").GetGuid()}/lessons", new
        {
            title = "L1", summary = "s", contentMarkdown = "# v1", estimatedMinutes = 5, position = 1,
            conceptIds = new[] { concept.GetProperty("id").GetGuid() }, objectives = new[] { "Know it" },
        }));
        var lessonId = lesson.GetProperty("id").GetGuid();
        Assert.Equal(1, lesson.GetProperty("version").GetInt32());
        var updated = await TestClient.ReadJsonAsync(await t.PutAsync($"/api/v1/instructor/lessons/{lessonId}", new
        {
            title = "L1", summary = "s", contentMarkdown = "# v2", estimatedMinutes = 5, position = 1,
            conceptIds = new[] { concept.GetProperty("id").GetGuid() }, objectives = new[] { "Know it" },
        }));
        Assert.Equal(2, updated.GetProperty("version").GetInt32());
        var indexJob = F.Jobs.Jobs.Last(j => j.Job.Type == typeof(IndexLessonJob));
        Assert.Equal((lessonId, 2), ((Guid)indexJob.Job.Args[0]!, (int)indexJob.Job.Args[1]!));

        // MCQ validation: exactly one correct option.
        var bad = await t.PostAsync("/api/v1/instructor/questions", new
        {
            conceptId = concept.GetProperty("id").GetGuid(), type = "mcq", stem = "?", explanation = "", difficulty = 0.5, status = "draft",
            isDiagnostic = false, options = new[] { new { label = "A", text = "x", isCorrect = true }, new { label = "B", text = "y", isCorrect = true } },
        });
        Assert.Equal(HttpStatusCode.BadRequest, bad.StatusCode);

        var gen = await t.PostAsync("/api/v1/instructor/questions/generate", new { courseId, conceptId = concept.GetProperty("id").GetGuid(), count = 3, difficulty = 0.5 });
        Assert.Equal(HttpStatusCode.Accepted, gen.StatusCode);
        Assert.Matches("^[0-9A-F]{4}-[0-9A-F]{4}$", (await TestClient.ReadJsonAsync(gen)).GetProperty("referenceId").GetString()!);

        var insights = await TestClient.ReadJsonAsync(await t.GetAsync($"/api/v1/instructor/insights?courseId={fx.CourseId}"));
        Assert.True(insights.GetProperty("enrolled").GetInt32() >= 0);
        Assert.Equal(3, insights.GetProperty("conceptMastery").GetArrayLength());
    }
}
