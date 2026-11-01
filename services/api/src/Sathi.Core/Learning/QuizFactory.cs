using Microsoft.EntityFrameworkCore;
using Sathi.Core.Data;
using Sathi.Core.Domain;

namespace Sathi.Core.Learning;

/// <summary>Builds quizzes from the question bank.</summary>
public static class QuizFactory
{
    public const int MaxDiagnosticQuestions = 10;

    /// <summary>The course's diagnostic quiz: one published is_diagnostic question per concept (max 10).</summary>
    public static async Task<Quiz?> GetOrCreateDiagnosticQuizAsync(AppDbContext db, Guid courseId, CancellationToken ct)
    {
        var quiz = await db.Quizzes.Where(q => q.CourseId == courseId && q.Kind == QuizKinds.Diagnostic)
            .OrderBy(q => q.CreatedAt).FirstOrDefaultAsync(ct);
        var hasQuestions = quiz is not null && await db.QuizQuestions.AnyAsync(x => x.QuizId == quiz.Id, ct);
        if (hasQuestions) return quiz;

        var candidates = await db.Questions
            .Where(q => q.CourseId == courseId && q.IsDiagnostic && q.Status == QuestionStatuses.Published)
            .Join(db.Concepts, q => q.ConceptId, c => c.Id, (q, c) => new { q.Id, q.ConceptId, ConceptOrder = c.Id, q.Difficulty, q.Type })
            .ToListAsync(ct);
        var picked = candidates
            .GroupBy(x => x.ConceptId)
            .OrderBy(g => g.First().ConceptOrder)
            .Select(g => g.OrderBy(x => x.Type == QuestionTypes.Mcq ? 0 : 1).ThenBy(x => Math.Abs(x.Difficulty - 0.5)).First().Id)
            .Take(MaxDiagnosticQuestions)
            .ToList();
        if (picked.Count == 0) return null;

        if (quiz is null)
        {
            quiz = new Quiz { CourseId = courseId, Title = "Diagnostic", Kind = QuizKinds.Diagnostic, CreatedAt = DateTime.UtcNow };
            db.Quizzes.Add(quiz);
        }
        for (var i = 0; i < picked.Count; i++)
            db.QuizQuestions.Add(new QuizQuestion { QuizId = quiz.Id, QuestionId = picked[i], Position = i + 1 });
        await db.SaveChangesAsync(ct);
        return quiz;
    }

    public static async Task<Quiz> CreateQuizAsync(AppDbContext db, Guid courseId, string title, string kind, Guid? conceptId, Guid? lessonId,
        Guid? createdBy, IReadOnlyList<Guid> questionIds, CancellationToken ct)
    {
        var quiz = new Quiz
        {
            CourseId = courseId, Title = title, Kind = kind, ConceptId = conceptId, LessonId = lessonId, CreatedBy = createdBy, CreatedAt = DateTime.UtcNow,
        };
        db.Quizzes.Add(quiz);
        for (var i = 0; i < questionIds.Count; i++)
            db.QuizQuestions.Add(new QuizQuestion { QuizId = quiz.Id, QuestionId = questionIds[i], Position = i + 1 });
        await db.SaveChangesAsync(ct);
        return quiz;
    }
}
