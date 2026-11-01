using Microsoft.EntityFrameworkCore;
using Sathi.Core.Data;
using Sathi.Core.Domain;

namespace Sathi.Core.Learning;

/// <summary>
/// Side effects of a graded answer, shared by instant MCQ grading (API), GradeAnswerJob (auto-accept) and instructor review:
/// is_correct, mastery (+history) and the SM-2 revision card. Caller saves.
/// </summary>
public sealed class AnswerEffects(AppDbContext db, MasteryService mastery)
{
    /// <summary>Short answers count as correct when the score fraction is at least this.</summary>
    public const double CorrectFraction = 0.6;

    public async Task<MasteryChange> ApplyAsync(
        SubmittedAnswer answer, Question question, Guid userId, bool correct, double? scoreFraction, string source, CancellationToken ct)
    {
        answer.IsCorrect = correct;
        var change = await mastery.ApplyAsync(userId, question.ConceptId, correct, question.Difficulty, scoreFraction, source, answer.Id, ct);
        answer.MasteryBefore = change.Before;
        answer.MasteryAfter = change.After;
        await UpsertCardAsync(userId, question, Sm2.QualityFor(correct), ct);
        return change;
    }

    public async Task<RevisionCard> UpsertCardAsync(Guid userId, Question question, int quality, CancellationToken ct)
    {
        var now = DateTime.UtcNow;
        var card = db.RevisionCards.Local.FirstOrDefault(c => c.UserId == userId && c.QuestionId == question.Id)
                   ?? await db.RevisionCards.FirstOrDefaultAsync(c => c.UserId == userId && c.QuestionId == question.Id, ct);
        if (card is null)
        {
            card = new RevisionCard
            {
                UserId = userId, CourseId = question.CourseId, QuestionId = question.Id, ConceptId = question.ConceptId,
                EaseFactor = Sm2.DefaultEase, CreatedAt = now,
            };
            db.RevisionCards.Add(card);
        }
        Sm2.Apply(card, quality, now);
        return card;
    }

    /// <summary>Ensures a card exists without scheduling a review (used while a short answer awaits grading).</summary>
    public async Task EnsureCardAsync(Guid userId, Question question, CancellationToken ct)
    {
        if (await db.RevisionCards.AnyAsync(c => c.UserId == userId && c.QuestionId == question.Id, ct)) return;
        var now = DateTime.UtcNow;
        db.RevisionCards.Add(new RevisionCard
        {
            UserId = userId, CourseId = question.CourseId, QuestionId = question.Id, ConceptId = question.ConceptId,
            EaseFactor = Sm2.DefaultEase, IntervalDays = 1, Repetitions = 0, DueAt = now.AddDays(1), CreatedAt = now,
        });
    }
}
