using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Logging;
using Sathi.Core.Ai;
using Sathi.Core.Data;
using Sathi.Core.Domain;
using Sathi.Core.Security;

namespace Sathi.Core.Learning;

public sealed record MasteryChange(Guid ConceptId, double Before, double After);

/// <summary>
/// Applies one learning outcome to concept_mastery + concept_mastery_history. The update rule runs in the AI service
/// (POST /internal/v1/mastery/update); if that call fails the prior value is kept, a Warning is logged and the caller continues.
/// Does not call SaveChanges.
/// </summary>
public sealed class MasteryService(AppDbContext db, AiServiceClient ai, ILogger<MasteryService> logger)
{
    private static readonly EventId MasteryFallback = new(3001, "mastery.fallback");

    public async Task<MasteryChange> ApplyAsync(
        Guid userId, Guid conceptId, bool correct, double difficulty, double? score,
        string source, Guid? sourceId, CancellationToken ct)
    {
        var now = DateTime.UtcNow;
        var row = await db.ConceptMastery.FirstOrDefaultAsync(m => m.UserId == userId && m.ConceptId == conceptId, ct);
        if (row is null)
        {
            row = new ConceptMastery { UserId = userId, ConceptId = conceptId, Mastery = MasteryModel.DefaultPrior, UpdatedAt = now, LastPracticedAt = now };
            db.ConceptMastery.Add(row);
        }

        var before = row.Mastery;
        double after;
        if (source == MasterySources.Diagnostic)
        {
            after = correct ? MasteryModel.DiagnosticCorrect : MasteryModel.DiagnosticWrong;
        }
        else
        {
            try
            {
                var resp = await ai.UpdateMasteryAsync(
                    new MasteryUpdateRequest(before, row.Attempts, correct, difficulty, score),
                    new AiCallContext(userId, [ServiceScopes.Mastery], ScopeUserId: userId), ct);
                after = MasteryModel.Clamp(resp.Mastery);
            }
            catch (AiServiceException ex)
            {
                logger.LogWarning(MasteryFallback,
                    "Mastery update unavailable ({error_code}); keeping prior value for concept {concept_id}", ex.Code, conceptId);
                after = before;
            }
        }

        row.Mastery = after;
        row.Attempts += 1;
        if (correct) row.Correct += 1;
        row.LastPracticedAt = now;
        row.UpdatedAt = now;

        db.ConceptMasteryHistory.Add(new ConceptMasteryHistory
        {
            UserId = userId, ConceptId = conceptId, Before = before, After = after, Source = source, SourceId = sourceId, CreatedAt = now,
        });

        return new MasteryChange(conceptId, before, after);
    }
}
