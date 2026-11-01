using System.Text.Json;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Logging;
using Sathi.Core.Access;
using Sathi.Core.Ai;
using Sathi.Core.Data;
using Sathi.Core.Domain;
using Sathi.Core.Learning;

namespace Sathi.Core.Seeding;

/// <summary>
/// Gives the demo student a realistic history so Home and Progress look alive: enrolment + onboarding, mastery for
/// gradient-descent 0.82, embeddings 0.68, backpropagation 0.42, attention 0.35 (when present) with 10 days of history,
/// completed lessons, a lesson in progress (~55%) in module 3, 5 revision cards due today, past quiz attempts and a conversation.
/// Runs once per user (skipped when the user already has mastery rows).
/// </summary>
public sealed class DemoDataSeeder(AppDbContext db, ILogger<DemoDataSeeder> logger)
{
    private static readonly (string Slug, double Target)[] Targets =
    [
        ("gradient-descent", 0.82), ("embeddings", 0.68), ("backpropagation", 0.42), ("attention", 0.35),
    ];

    public async Task SeedAsync(AppUser student, CancellationToken ct)
    {
        var course = await db.Courses.Where(c => c.IsPublished).OrderBy(c => c.Slug == "ai-engineering" ? 0 : 1).ThenBy(c => c.CreatedAt)
            .FirstOrDefaultAsync(ct);
        if (course is null)
        {
            logger.LogWarning("No published course; demo history skipped");
            return;
        }
        if (await db.ConceptMastery.AnyAsync(m => m.UserId == student.Id, ct))
        {
            logger.LogInformation("Demo history already present; skipping");
            return;
        }

        var now = DateTime.UtcNow;
        DateTime Day(int daysAgo, int hour = 18)
        {
            var d = now.Date.AddDays(-daysAgo).AddHours(hour);
            return d > now ? now.AddMinutes(-5) : d;
        }

        var modules = await db.CourseModules.Where(m => m.CourseId == course.Id).OrderBy(m => m.Position)
            .Include(m => m.Lessons).ToListAsync(ct);
        var orderedLessons = modules.SelectMany(m => m.Lessons.OrderBy(l => l.Position).Select(l => (Module: m, Lesson: l))).ToList();
        var concepts = await db.Concepts.Where(c => c.CourseId == course.Id).ToListAsync(ct);
        var bySlug = concepts.ToDictionary(c => c.Slug);

        // ---- enrolment, preferences ----
        var inProgressModule = modules.Count >= 3 ? modules[2] : modules.LastOrDefault();
        // The demo student is part-way through module 3 (lesson 4 of 7, "Scaled dot-product attention").
        var moduleLessons = inProgressModule?.Lessons.OrderBy(l => l.Position).ToList() ?? [];
        var currentLesson = moduleLessons.Count == 0 ? null : moduleLessons[Math.Min(3, moduleLessons.Count - 1)];
        var enrollment = await db.Enrollments.FirstOrDefaultAsync(e => e.UserId == student.Id && e.CourseId == course.Id, ct);
        if (enrollment is null)
        {
            enrollment = new Enrollment { UserId = student.Id, CourseId = course.Id, EnrolledAt = Day(11) };
            db.Enrollments.Add(enrollment);
        }
        enrollment.DiagnosticCompletedAt = Day(10, 17);
        enrollment.CurrentLessonId = currentLesson?.Id;

        var prefs = await db.UserPreferences.FirstOrDefaultAsync(p => p.UserId == student.Id, ct);
        if (prefs is null) { prefs = new UserPreference { UserId = student.Id }; db.UserPreferences.Add(prefs); }
        prefs.Level = Levels.Intermediate;
        prefs.ActiveCourseId = course.Id;
        prefs.OnboardingCompletedAt = Day(10, 17);

        // ---- lesson progress: modules before the in-progress one are completed ----
        var completedLessons = inProgressModule is null
            ? new List<(CourseModule Module, Lesson Lesson)>()
            : orderedLessons.Where(x => x.Module.Position < inProgressModule.Position
                || (x.Module.Id == inProgressModule.Id && currentLesson is not null && x.Lesson.Position < currentLesson.Position)).ToList();
        for (var i = 0; i < completedLessons.Count; i++)
        {
            var when = Day(Math.Max(1, 9 - i), 19);
            db.LessonProgress.Add(new LessonProgress
            {
                UserId = student.Id, LessonId = completedLessons[i].Lesson.Id, Status = LessonStatuses.Completed, Percent = 100,
                LastViewedAt = when, CompletedAt = when,
            });
        }
        if (currentLesson is not null)
            db.LessonProgress.Add(new LessonProgress
            {
                UserId = student.Id, LessonId = currentLesson.Id, Status = LessonStatuses.InProgress, Percent = 55, LastViewedAt = Day(1, 20),
            });

        // ---- mastery + 10 days of history ----
        var historyDays = new[] { 10, 7, 5, 3, 2, 1 };
        foreach (var (slug, target) in Targets)
        {
            if (!bySlug.TryGetValue(slug, out var concept)) continue;
            var start = target >= 0.5 ? MasteryModel.DiagnosticCorrect : MasteryModel.DiagnosticWrong;
            var prev = MasteryModel.DefaultPrior;
            for (var i = 0; i < historyDays.Length; i++)
            {
                var value = i == 0 ? start : Math.Round(start + (target - start) * i / (historyDays.Length - 1), 3);
                db.ConceptMasteryHistory.Add(new ConceptMasteryHistory
                {
                    UserId = student.Id, ConceptId = concept.Id, Before = prev, After = value,
                    Source = i == 0 ? MasterySources.Diagnostic : MasterySources.Practice, CreatedAt = Day(historyDays[i], 18 + (i % 3)),
                });
                prev = value;
            }
            db.ConceptMastery.Add(new ConceptMastery
            {
                UserId = student.Id, ConceptId = concept.Id, Mastery = target, Attempts = 9, Correct = (int)Math.Round(9 * target),
                LastPracticedAt = Day(1, 19), UpdatedAt = Day(1, 19),
            });
        }
        await db.SaveChangesAsync(ct);

        // ---- quizzes: diagnostic + two practice attempts ----
        var diag = await QuizFactory.GetOrCreateDiagnosticQuizAsync(db, course.Id, ct);
        if (diag is not null)
        {
            var qids = await db.QuizQuestions.Where(x => x.QuizId == diag.Id).OrderBy(x => x.Position).Select(x => x.QuestionId).ToListAsync(ct);
            await AddAttemptAsync(diag.Id, student.Id, qids, Day(10, 17), correctEvery: 2, ct);
        }

        var focus = Targets.Select(t => bySlug.GetValueOrDefault(t.Slug)?.Id).Where(id => id is not null).Select(id => id!.Value).ToList();
        var practicePool = await db.Questions
            .Where(q => q.CourseId == course.Id && q.Status == QuestionStatuses.Published && q.Type == QuestionTypes.Mcq
                        && (focus.Count == 0 || focus.Contains(q.ConceptId)))
            .OrderBy(q => q.Id).Select(q => new { q.Id, q.ConceptId }).Take(40).ToListAsync(ct);
        if (practicePool.Count >= 5)
        {
            var first = practicePool.Take(5).Select(q => q.Id).ToList();
            var second = practicePool.Skip(5).Take(5).Select(q => q.Id).ToList();
            var quiz1 = await QuizFactory.CreateQuizAsync(db, course.Id, "Practice: Mixed", QuizKinds.Practice, null, null, student.Id, first, ct);
            await AddAttemptAsync(quiz1.Id, student.Id, first, Day(5, 18), correctEvery: 3, ct);
            if (second.Count >= 3)
            {
                var quiz2 = await QuizFactory.CreateQuizAsync(db, course.Id, "Practice: Mixed", QuizKinds.Practice, null, null, student.Id, second, ct);
                await AddAttemptAsync(quiz2.Id, student.Id, second, Day(2, 18), correctEvery: 5, ct);
            }
        }

        // ---- 5 revision cards due today ----
        var cardQuestions = await db.Questions
            .Where(q => q.CourseId == course.Id && q.Status == QuestionStatuses.Published && q.Type == QuestionTypes.Mcq)
            .OrderBy(q => focus.Contains(q.ConceptId) ? 0 : 1).ThenBy(q => q.Id)
            .Select(q => new { q.Id, q.ConceptId }).Take(5).ToListAsync(ct);
        var existingCards = await db.RevisionCards.Where(c => c.UserId == student.Id).Select(c => c.QuestionId).ToListAsync(ct);
        foreach (var (q, i) in cardQuestions.Select((q, i) => (q, i)))
        {
            if (existingCards.Contains(q.Id)) continue;
            db.RevisionCards.Add(new RevisionCard
            {
                UserId = student.Id, CourseId = course.Id, QuestionId = q.Id, ConceptId = q.ConceptId, EaseFactor = 2.5,
                IntervalDays = i % 2 == 0 ? 1 : 3, Repetitions = i % 2 == 0 ? 1 : 2, DueAt = now.AddHours(-1 - i),
                LastReviewedAt = now.AddDays(-(i % 2 == 0 ? 1 : 3)), LastQuality = 4, CreatedAt = Day(9),
            });
        }

        // ---- a past conversation ----
        var convo = new Conversation
        {
            UserId = student.Id, CourseId = course.Id, LessonId = currentLesson?.Id, Title = "Why does attention divide by √d?",
            CreatedAt = Day(2, 20), UpdatedAt = Day(2, 20),
        };
        db.Conversations.Add(convo);
        db.Messages.Add(new Message
        {
            ConversationId = convo.Id, Role = MessageRoles.User, Content = "Why does attention divide by √d?", Level = Levels.Intermediate,
            Mode = TutorModes.Explain, Status = MessageStatuses.Complete, CreatedAt = Day(2, 20), CompletedAt = Day(2, 20),
        });
        db.Messages.Add(new Message
        {
            ConversationId = convo.Id, Role = MessageRoles.Assistant, Level = Levels.Intermediate, Mode = TutorModes.Explain,
            Content = "Dot products of d-dimensional vectors grow with d, so without scaling the softmax saturates and gradients vanish. " +
                      "Dividing by √d keeps the scores' variance near 1, which keeps the softmax in a useful range.",
            AnswerBasis = [SourceTypes.Course], CitationsJson = "[]", Status = MessageStatuses.Complete,
            CreatedAt = Day(2, 20).AddSeconds(8), CompletedAt = Day(2, 20).AddSeconds(12),
        });

        await db.SaveChangesAsync(ct);
        logger.LogInformation("Seeded demo history for the demo student in course {course_slug}", course.Slug);
    }

    public const string DemoClassName = "AI Engineering · Batch A";

    /// <summary>
    /// Release 2 demo access data (idempotent): the demo instructor owns the AI Engineering course (course_instructors),
    /// a demo class "AI Engineering · Batch A" with a join code exists, and the demo student is a member. The course stays public.
    /// </summary>
    public async Task SeedClassAsync(AppUser instructor, AppUser student, CancellationToken ct)
    {
        var course = await db.Courses.Where(c => c.Slug == "ai-engineering").FirstOrDefaultAsync(ct)
                     ?? await db.Courses.Where(c => c.IsPublished).OrderBy(c => c.CreatedAt).FirstOrDefaultAsync(ct);
        if (course is null)
        {
            logger.LogWarning("No course; demo class skipped");
            return;
        }

        if (!await db.CourseInstructors.AnyAsync(ci => ci.CourseId == course.Id && ci.UserId == instructor.Id, ct))
            db.CourseInstructors.Add(new CourseInstructor
            {
                CourseId = course.Id, UserId = instructor.Id, Role = CourseInstructorRoles.Owner, AddedAt = DateTime.UtcNow,
            });

        var cls = await db.Classes.FirstOrDefaultAsync(c => c.CourseId == course.Id && c.Name == DemoClassName, ct);
        if (cls is null)
        {
            string code;
            do code = JoinCodes.Generate();
            while (await db.Classes.AnyAsync(c => c.JoinCode == code, ct));
            cls = new CourseClass
            {
                CourseId = course.Id, Name = DemoClassName, Description = "Demo cohort for the AI Engineering course.", JoinCode = code,
                JoinEnabled = true, CreatedBy = instructor.Id, CreatedAt = DateTime.UtcNow,
            };
            db.Classes.Add(cls);
        }

        if (!await db.ClassMembers.AnyAsync(m => m.ClassId == cls.Id && m.UserId == student.Id, ct))
            db.ClassMembers.Add(new ClassMember
            {
                ClassId = cls.Id, UserId = student.Id, JoinedAt = DateTime.UtcNow, JoinedVia = ClassJoinMethods.Added,
            });

        await db.SaveChangesAsync(ct);
        logger.LogInformation("Demo class ready (join code {join_code})", JoinCodes.Format(cls.JoinCode));
    }

    private async Task AddAttemptAsync(Guid quizId, Guid userId, IReadOnlyList<Guid> questionIds, DateTime when, int correctEvery, CancellationToken ct)
    {
        var options = await db.QuestionOptions.Where(o => questionIds.Contains(o.QuestionId)).ToListAsync(ct);
        var attempt = new QuizAttempt { QuizId = quizId, UserId = userId, StartedAt = when.AddMinutes(-8), CompletedAt = when, QuestionCount = questionIds.Count };
        db.QuizAttempts.Add(attempt);
        var correct = 0;
        for (var i = 0; i < questionIds.Count; i++)
        {
            var qOptions = options.Where(o => o.QuestionId == questionIds[i]).OrderBy(o => o.Position).ToList();
            var right = (i + 1) % correctEvery != 0;
            var chosen = right ? qOptions.FirstOrDefault(o => o.IsCorrect) : qOptions.FirstOrDefault(o => !o.IsCorrect);
            if (right) correct++;
            db.SubmittedAnswers.Add(new SubmittedAnswer
            {
                AttemptId = attempt.Id, QuestionId = questionIds[i], SelectedOptionId = chosen?.Id, IsCorrect = right,
                SubmittedAt = when.AddMinutes(-8 + i),
            });
        }
        attempt.CorrectCount = correct;
        await db.SaveChangesAsync(ct);
    }
}
