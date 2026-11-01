using Sathi.Core.Domain;

namespace Sathi.Core.Learning;

public readonly record struct Sm2State(double EaseFactor, int Repetitions, int IntervalDays);

/// <summary>
/// SM-2 (contract §7). q ∈ 0..5. q &lt; 3 → repetitions = 0, interval = 1. Otherwise repetitions += 1 and
/// interval = 1 (rep 1), 3 (rep 2), round(interval · EF) afterwards (EF = the ease factor before this review).
/// EF' = max(1.3, EF + 0.1 − (5 − q)·(0.08 + (5 − q)·0.02)). due_at = now + interval.
/// </summary>
public static class Sm2
{
    public const double MinEase = 1.3;
    public const double DefaultEase = 2.5;
    public const double MinutesPerCard = 1.2;

    public static Sm2State Next(Sm2State s, int quality)
    {
        var q = Math.Clamp(quality, 0, 5);
        int reps, interval;
        if (q < 3)
        {
            reps = 0;
            interval = 1;
        }
        else
        {
            reps = s.Repetitions + 1;
            interval = reps switch
            {
                1 => 1,
                2 => 3,
                _ => (int)Math.Round(Math.Max(1, s.IntervalDays) * s.EaseFactor, MidpointRounding.AwayFromZero),
            };
        }
        var ef = Math.Max(MinEase, s.EaseFactor + 0.1 - (5 - q) * (0.08 + (5 - q) * 0.02));
        return new Sm2State(Math.Round(ef, 4), reps, interval);
    }

    /// <summary>Correct → quality 4, incorrect → quality 1 (contract §5.4).</summary>
    public static int QualityFor(bool correct) => correct ? 4 : 1;

    public static void Apply(RevisionCard card, int quality, DateTime now)
    {
        var next = Next(new Sm2State(card.EaseFactor, card.Repetitions, card.IntervalDays), quality);
        card.EaseFactor = next.EaseFactor;
        card.Repetitions = next.Repetitions;
        card.IntervalDays = next.IntervalDays;
        card.LastQuality = Math.Clamp(quality, 0, 5);
        card.LastReviewedAt = now;
        card.DueAt = now.AddDays(next.IntervalDays);
    }

    public static int EstimatedMinutes(int cards) => cards <= 0 ? 0 : (int)Math.Ceiling(cards * MinutesPerCard);
}

/// <summary>Mastery constants shared with the AI service (contract §7).</summary>
public static class MasteryModel
{
    public const double DefaultPrior = 0.30;
    public const double Min = 0.02;
    public const double Max = 0.98;
    public const double DiagnosticCorrect = 0.60;
    public const double DiagnosticWrong = 0.25;
    public const double NeedsWorkThreshold = 0.5;

    public static double Clamp(double m) => Math.Clamp(m, Min, Max);
}
