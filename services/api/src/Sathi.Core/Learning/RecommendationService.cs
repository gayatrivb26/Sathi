using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Logging;
using Sathi.Core.Ai;
using Sathi.Core.Data;
using Sathi.Core.Domain;
using Sathi.Core.Security;

namespace Sathi.Core.Learning;

public sealed record StudyNextItem(string Type, Guid TargetId, string Title, string Reason);

/// <summary>
/// "What to study next" (contract §7). Asks the AI service; falls back to a deterministic local ranking with the same rules
/// when it is unavailable. Persists the result in app.recommendations (replacing undismissed rows).
/// </summary>
public sealed class RecommendationService(AppDbContext db, AiServiceClient ai, ILogger<RecommendationService> logger)
{
    private static readonly EventId Fallback = new(3002, "recommendations.fallback");

    public async Task<IReadOnlyList<StudyNextItem>> GetOrComputeAsync(Guid userId, Guid courseId, TimeSpan maxAge, CancellationToken ct)
    {
        var since = DateTime.UtcNow - maxAge;
        var stored = await db.Recommendations
            .Where(r => r.UserId == userId && r.CourseId == courseId && r.DismissedAt == null && r.CreatedAt >= since)
            .OrderByDescending(r => r.Score)
            .Take(3)
            .ToListAsync(ct);
        if (stored.Count > 0)
            return stored.Select(r => new StudyNextItem(r.Type, r.TargetId, r.Title, r.Reason)).ToList();
        return await ComputeAsync(userId, courseId, ct);
    }

    public async Task<IReadOnlyList<StudyNextItem>> ComputeAsync(Guid userId, Guid courseId, CancellationToken ct)
    {
        var input = await BuildInputAsync(userId, courseId, ct);
        List<RecommendationItem> items;
        try
        {
            var resp = await ai.RecommendationsAsync(input.Request,
                new AiCallContext(userId, [ServiceScopes.Mastery], [courseId], userId), ct);
            items = (resp?.Items ?? []).Take(3).ToList();
            if (items.Count == 0) items = Local(input);
        }
        catch (AiServiceException ex)
        {
            logger.LogWarning(Fallback, "Recommendations unavailable ({error_code}); using local ranking", ex.Code);
            items = Local(input);
        }

        var now = DateTime.UtcNow;
        await db.Recommendations.Where(r => r.UserId == userId && r.CourseId == courseId && r.DismissedAt == null)
            .ExecuteDeleteAsync(ct);
        foreach (var i in items)
        {
            db.Recommendations.Add(new Recommendation
            {
                UserId = userId, CourseId = courseId, Type = i.Type, TargetId = i.TargetId, Title = i.Title,
                Reason = i.Reason, Score = i.Score, CreatedAt = now,
            });
        }
        await db.SaveChangesAsync(ct);
        return items.Select(i => new StudyNextItem(i.Type, i.TargetId, i.Title, i.Reason)).ToList();
    }

    private sealed record Input(
        RecommendationsRequest Request,
        Guid CourseId,
        LessonRef? RecentLesson,
        Dictionary<Guid, string> ConceptNames);

    private async Task<Input> BuildInputAsync(Guid userId, Guid courseId, CancellationToken ct)
    {
        var concepts = await db.Concepts.Where(c => c.CourseId == courseId).ToListAsync(ct);
        var ids = concepts.Select(c => c.Id).ToList();
        var mastery = await db.ConceptMastery.Where(m => m.UserId == userId && ids.Contains(m.ConceptId)).ToDictionaryAsync(m => m.ConceptId, ct);
        var prereqs = await db.ConceptPrerequisites.Where(p => ids.Contains(p.ConceptId)).ToListAsync(ct);

        var lessons = await db.Lessons
            .Where(l => l.Module!.CourseId == courseId)
            .OrderBy(l => l.Module!.Position).ThenBy(l => l.Position)
            .Select(l => new { l.Id, l.Title })
            .ToListAsync(ct);
        var lessonIds = lessons.Select(l => l.Id).ToList();
        var progress = await db.LessonProgress.Where(p => p.UserId == userId && lessonIds.Contains(p.LessonId)).ToListAsync(ct);
        var completed = progress.Where(p => p.Status == LessonStatuses.Completed).Select(p => p.LessonId).ToHashSet();
        var enrollment = await db.Enrollments.FirstOrDefaultAsync(e => e.UserId == userId && e.CourseId == courseId, ct);

        var next = lessons.FirstOrDefault(l => l.Id == enrollment?.CurrentLessonId && !completed.Contains(l.Id))
                   ?? lessons.FirstOrDefault(l => !completed.Contains(l.Id));
        var recentProgress = progress.Where(p => p.Status == LessonStatuses.Completed).OrderByDescending(p => p.CompletedAt).FirstOrDefault();
        var recent = recentProgress is null ? null : lessons.FirstOrDefault(l => l.Id == recentProgress.LessonId);

        var now = DateTime.UtcNow;
        var revisionDue = await db.RevisionCards.CountAsync(c => c.UserId == userId && c.CourseId == courseId && c.DueAt <= now, ct);

        var lessonConcepts = new Dictionary<Guid, IReadOnlyList<Guid>>();
        if (recent is not null)
        {
            var lc = await db.LessonConcepts.Where(x => x.LessonId == recent.Id).Select(x => x.ConceptId).ToListAsync(ct);
            lessonConcepts[recent.Id] = lc;
        }

        var request = new RecommendationsRequest(
            concepts.Select(c => new RecommendationConcept(
                c.Id, c.Name,
                mastery.TryGetValue(c.Id, out var m) ? m.Mastery : MasteryModel.DefaultPrior,
                mastery.TryGetValue(c.Id, out var m2) ? m2.Attempts : 0,
                mastery.TryGetValue(c.Id, out var m3) ? m3.LastPracticedAt : null,
                prereqs.Where(p => p.ConceptId == c.Id).Select(p => p.PrerequisiteConceptId).ToList())).ToList(),
            next is null ? null : new LessonRef(next.Id, next.Title),
            revisionDue,
            lessonConcepts);

        return new Input(request, courseId, recent is null ? null : new LessonRef(recent.Id, recent.Title),
            concepts.ToDictionary(c => c.Id, c => c.Name));
    }

    /// <summary>Deterministic fallback with the contract §7 candidate rules.</summary>
    private static List<RecommendationItem> Local(Input input)
    {
        var req = input.Request;
        var byId = req.Concepts.ToDictionary(c => c.Id);
        var candidates = new List<RecommendationItem>();

        foreach (var c in req.Concepts.Where(c => c.Attempts > 0 && c.Mastery < MasteryModel.NeedsWorkThreshold))
        {
            var prereqsOk = c.PrerequisiteIds.All(p => !byId.TryGetValue(p, out var pc) || pc.Attempts == 0 || pc.Mastery >= 0.5);
            if (!prereqsOk) continue;
            candidates.Add(new RecommendationItem(RecommendationTypes.ConceptPractice, c.Id, $"Practice {c.Name}",
                $"Your mastery of {c.Name} is {Math.Round(c.Mastery * 100)}% — a short practice set will strengthen it.", 1 - c.Mastery));
        }

        if (req.RevisionDue > 0)
            candidates.Add(new RecommendationItem(RecommendationTypes.Revision, input.CourseId, "Review due cards",
                $"You have {req.RevisionDue} revision card{(req.RevisionDue == 1 ? "" : "s")} due — reviewing now keeps them fresh.", 0.6));

        if (req.NextLesson is { } next)
            candidates.Add(new RecommendationItem(RecommendationTypes.Lesson, next.Id, next.Title,
                "This is the next lesson in your course.", 0.5));

        if (input.RecentLesson is { } recent && req.LessonConcepts.TryGetValue(recent.Id, out var lc) && lc.Count > 0)
            candidates.Add(new RecommendationItem(RecommendationTypes.Quiz, recent.Id, $"Quick check: {recent.Title}",
                "A short quiz on the lesson you just finished helps it stick.", 0.4));

        return candidates.OrderByDescending(c => c.Score).Take(3).ToList();
    }
}
