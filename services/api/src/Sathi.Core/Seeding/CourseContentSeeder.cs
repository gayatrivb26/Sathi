using System.Text.Json;
using System.Text.Json.Serialization;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Logging;
using Sathi.Core.Ai;
using Sathi.Core.Data;
using Sathi.Core.Domain;
using Sathi.Core.Security;

namespace Sathi.Core.Seeding;

// ---- content file shapes (contract §9) ----
public sealed class CourseFile
{
    public string Slug { get; set; } = "";
    public string Title { get; set; } = "";
    public string Description { get; set; } = "";
    public string Domain { get; set; } = "";
    public bool? IsPublished { get; set; }
    public List<ConceptFile> Concepts { get; set; } = [];
    public List<ModuleFile> Modules { get; set; } = [];
}

public sealed class ConceptFile
{
    public string Slug { get; set; } = "";
    public string Name { get; set; } = "";
    public string Description { get; set; } = "";
    public List<string> Prerequisites { get; set; } = [];
}

public sealed class ModuleFile
{
    public string Title { get; set; } = "";
    public string Summary { get; set; } = "";
    public List<LessonFile> Lessons { get; set; } = [];
}

public sealed class LessonFile
{
    public string Slug { get; set; } = "";
    public string Title { get; set; } = "";
    public string Summary { get; set; } = "";
    public int EstimatedMinutes { get; set; } = 10;
    public List<string> Concepts { get; set; } = [];
    public List<string> Objectives { get; set; } = [];
    public string File { get; set; } = "";
}

public sealed class QuestionFile
{
    public string Concept { get; set; } = "";
    public string? Lesson { get; set; }
    public string Type { get; set; } = QuestionTypes.Mcq;
    public string Stem { get; set; } = "";
    public string Explanation { get; set; } = "";
    public JsonElement Difficulty { get; set; }
    public bool IsDiagnostic { get; set; }
    public List<OptionFile> Options { get; set; } = [];
    public RubricFile? Rubric { get; set; }
}

public sealed class OptionFile
{
    public string Label { get; set; } = "";
    public string Text { get; set; } = "";
    public bool IsCorrect { get; set; }
}

public sealed class RubricFile
{
    public List<RubricCriterion> Criteria { get; set; } = [];
    public string ModelAnswer { get; set; } = "";
}

public sealed record SeedResult(int Courses, int Lessons, int LessonsChanged, int Questions);

/// <summary>
/// Idempotent upsert of course content from Seed:ContentPath (contract §9). Courses and concepts are matched by slug;
/// modules by position; lessons and questions get deterministic ids (UUID v5 of course/lesson slug, or course/concept/stem),
/// so re-running never duplicates. A changed lesson body bumps lessons.version.
/// </summary>
public sealed class CourseContentSeeder(AppDbContext db, ILogger<CourseContentSeeder> logger)
{
    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web)
    {
        ReadCommentHandling = JsonCommentHandling.Skip,
        AllowTrailingCommas = true,
        NumberHandling = JsonNumberHandling.AllowReadingFromString,
    };

    public static Guid LessonId(string courseSlug, string lessonSlug) => DeterministicGuid.Create($"lesson:{courseSlug}:{lessonSlug}");
    public static Guid ModuleId(string courseSlug, int position) => DeterministicGuid.Create($"module:{courseSlug}:{position}");
    public static Guid QuestionId(string courseSlug, string conceptSlug, string stem) =>
        DeterministicGuid.Create($"question:{courseSlug}:{conceptSlug}:{stem.Trim()}");

    public async Task<SeedResult?> SeedAsync(string contentPath, CancellationToken ct)
    {
        var coursePath = Path.Combine(contentPath, "course.json");
        if (!File.Exists(coursePath))
        {
            logger.LogWarning("No course content at {path}; skipping content seed", coursePath);
            return null;
        }

        var course = JsonSerializer.Deserialize<CourseFile>(await File.ReadAllTextAsync(coursePath, ct), Json)
                     ?? throw new InvalidOperationException("course.json is empty");
        if (string.IsNullOrWhiteSpace(course.Slug)) throw new InvalidOperationException("course.json has no slug");

        var now = DateTime.UtcNow;
        await using var tx = await db.Database.BeginTransactionAsync(ct);

        // ---- course ----
        var c = await db.Courses.FirstOrDefaultAsync(x => x.Slug == course.Slug, ct);
        if (c is null)
        {
            c = new Course { Slug = course.Slug, CreatedAt = now };
            db.Courses.Add(c);
        }
        c.Title = course.Title;
        c.Description = course.Description;
        c.Domain = string.IsNullOrWhiteSpace(course.Domain) ? course.Slug : course.Domain;
        c.IsPublished = course.IsPublished ?? true;
        c.UpdatedAt = now;
        await db.SaveChangesAsync(ct);

        // ---- concepts ----
        var concepts = await db.Concepts.Where(x => x.CourseId == c.Id).ToDictionaryAsync(x => x.Slug, ct);
        foreach (var cf in course.Concepts)
        {
            if (!concepts.TryGetValue(cf.Slug, out var concept))
            {
                concept = new Concept { CourseId = c.Id, Slug = cf.Slug };
                db.Concepts.Add(concept);
                concepts[cf.Slug] = concept;
            }
            concept.Name = cf.Name;
            concept.Description = cf.Description;
        }
        await db.SaveChangesAsync(ct);

        var conceptIds = concepts.Values.Select(x => x.Id).ToList();
        await db.ConceptPrerequisites.Where(p => conceptIds.Contains(p.ConceptId)).ExecuteDeleteAsync(ct);
        foreach (var cf in course.Concepts)
            foreach (var pre in cf.Prerequisites.Distinct())
                if (concepts.TryGetValue(pre, out var p) && pre != cf.Slug)
                    db.ConceptPrerequisites.Add(new ConceptPrerequisite { ConceptId = concepts[cf.Slug].Id, PrerequisiteConceptId = p.Id });
        await db.SaveChangesAsync(ct);

        // ---- modules + lessons ----
        var lessonsBySlug = new Dictionary<string, Guid>();
        int lessonCount = 0, changed = 0;
        for (var mi = 0; mi < course.Modules.Count; mi++)
        {
            var mf = course.Modules[mi];
            var position = mi + 1;
            var moduleId = ModuleId(course.Slug, position);
            var module = await db.CourseModules.FirstOrDefaultAsync(m => m.Id == moduleId, ct);
            if (module is null)
            {
                module = new CourseModule { Id = moduleId, CourseId = c.Id };
                db.CourseModules.Add(module);
            }
            module.Title = mf.Title;
            module.Summary = mf.Summary;
            module.Position = position;

            for (var li = 0; li < mf.Lessons.Count; li++)
            {
                var lf = mf.Lessons[li];
                var lessonId = LessonId(course.Slug, lf.Slug);
                lessonsBySlug[lf.Slug] = lessonId;
                var markdown = await ReadLessonAsync(contentPath, lf.File, ct);
                var lesson = await db.Lessons.Include(l => l.LessonConcepts).Include(l => l.Objectives)
                    .FirstOrDefaultAsync(l => l.Id == lessonId, ct);
                if (lesson is null)
                {
                    lesson = new Lesson { Id = lessonId, Version = 1, ContentMarkdown = markdown };
                    db.Lessons.Add(lesson);
                }
                else if (lesson.ContentMarkdown != markdown)
                {
                    lesson.ContentMarkdown = markdown;
                    lesson.Version += 1;
                    changed++;
                }
                lesson.ModuleId = moduleId;
                lesson.Title = lf.Title;
                lesson.Summary = lf.Summary;
                lesson.EstimatedMinutes = lf.EstimatedMinutes > 0 ? lf.EstimatedMinutes : 10;
                lesson.Position = li + 1;
                lesson.UpdatedAt = now;

                var wanted = lf.Concepts.Where(concepts.ContainsKey).Select(s => concepts[s].Id).Distinct().ToHashSet();
                lesson.LessonConcepts.RemoveAll(x => !wanted.Contains(x.ConceptId));
                foreach (var id in wanted.Where(id => lesson.LessonConcepts.All(x => x.ConceptId != id)))
                    lesson.LessonConcepts.Add(new LessonConcept { LessonId = lessonId, ConceptId = id });

                var objectives = lf.Objectives.Where(o => !string.IsNullOrWhiteSpace(o)).ToList();
                if (!lesson.Objectives.OrderBy(o => o.Position).Select(o => o.Text).SequenceEqual(objectives))
                {
                    db.LearningObjectives.RemoveRange(lesson.Objectives);
                    lesson.Objectives.Clear();
                    for (var oi = 0; oi < objectives.Count; oi++)
                        lesson.Objectives.Add(new LearningObjective { LessonId = lessonId, Text = objectives[oi], Position = oi + 1 });
                }
                lessonCount++;
            }
        }
        await db.SaveChangesAsync(ct);

        // ---- questions ----
        var questionCount = 0;
        var questionsPath = Path.Combine(contentPath, "questions.json");
        if (File.Exists(questionsPath))
        {
            var questions = JsonSerializer.Deserialize<List<QuestionFile>>(await File.ReadAllTextAsync(questionsPath, ct), Json) ?? [];
            var seededIds = new HashSet<Guid>();
            foreach (var qf in questions)
            {
                if (!concepts.TryGetValue(qf.Concept, out var concept) || string.IsNullOrWhiteSpace(qf.Stem))
                {
                    logger.LogWarning("Skipping question with unknown concept {concept}", qf.Concept);
                    continue;
                }
                var id = QuestionId(course.Slug, qf.Concept, qf.Stem);
                if (!seededIds.Add(id)) continue;
                var q = await db.Questions.Include(x => x.Options).FirstOrDefaultAsync(x => x.Id == id, ct);
                if (q is null)
                {
                    q = new Question { Id = id, CourseId = c.Id, Source = QuestionSources.Seed, Status = QuestionStatuses.Published, CreatedAt = now };
                    db.Questions.Add(q);
                }
                q.ConceptId = concept.Id;
                q.LessonId = qf.Lesson is { } ls && lessonsBySlug.TryGetValue(ls, out var lid) ? lid : null;
                q.Type = qf.Type == QuestionTypes.Short ? QuestionTypes.Short : QuestionTypes.Mcq;
                q.Stem = qf.Stem.Trim();
                q.Explanation = qf.Explanation;
                q.Difficulty = ParseDifficulty(qf.Difficulty);
                q.IsDiagnostic = qf.IsDiagnostic;
                if (q.Status == QuestionStatuses.Archived && q.Source == QuestionSources.Seed) q.Status = QuestionStatuses.Published;
                q.UpdatedAt = now;

                // Options are updated in place by label so answers referencing them stay valid.
                for (var oi = 0; oi < qf.Options.Count; oi++)
                {
                    var of = qf.Options[oi];
                    var label = string.IsNullOrWhiteSpace(of.Label) ? ((char)('A' + oi)).ToString() : of.Label.Trim();
                    var opt = q.Options.FirstOrDefault(o => o.Label == label);
                    if (opt is null)
                    {
                        opt = new QuestionOption { Id = DeterministicGuid.Create($"option:{id}:{label}"), QuestionId = id, Label = label };
                        q.Options.Add(opt);
                    }
                    opt.Text = of.Text;
                    opt.IsCorrect = of.IsCorrect;
                    opt.Position = oi;
                }
                var labels = qf.Options.Select((o, i) => string.IsNullOrWhiteSpace(o.Label) ? ((char)('A' + i)).ToString() : o.Label.Trim()).ToHashSet();
                foreach (var extra in q.Options.Where(o => !labels.Contains(o.Label)).ToList())
                {
                    q.Options.Remove(extra);
                    db.QuestionOptions.Remove(extra);
                }

                if (qf.Rubric is { } rf)
                {
                    var criteriaJson = JsonSerializer.Serialize(rf.Criteria, AiJson.Options);
                    var latest = await db.Rubrics.Where(r => r.QuestionId == id).OrderByDescending(r => r.Version).FirstOrDefaultAsync(ct);
                    // Compare as JSON (jsonb normalises whitespace/key order) so re-runs don't create new versions.
                    if (latest is null || !JsonEquivalent(latest.CriteriaJson, criteriaJson) || latest.ModelAnswer != rf.ModelAnswer)
                        db.Rubrics.Add(new Rubric { QuestionId = id, Version = (latest?.Version ?? 0) + 1, CriteriaJson = criteriaJson, ModelAnswer = rf.ModelAnswer, CreatedAt = now });
                }
                questionCount++;
            }
            await db.SaveChangesAsync(ct);

            // Seed questions no longer present in the file are archived (never deleted: answers may reference them).
            await db.Questions.Where(q => q.CourseId == c.Id && q.Source == QuestionSources.Seed && q.Status != QuestionStatuses.Archived && !seededIds.Contains(q.Id))
                .ExecuteUpdateAsync(s => s.SetProperty(q => q.Status, QuestionStatuses.Archived), ct);
        }

        await tx.CommitAsync(ct);
        logger.LogInformation("Seeded course {course_slug}: {lessons} lessons ({changed} changed), {questions} questions",
            course.Slug, lessonCount, changed, questionCount);
        return new SeedResult(1, lessonCount, changed, questionCount);
    }

    private static async Task<string> ReadLessonAsync(string root, string file, CancellationToken ct)
    {
        if (string.IsNullOrWhiteSpace(file)) return "";
        var full = Path.GetFullPath(Path.Combine(root, file));
        if (!full.StartsWith(Path.GetFullPath(root), StringComparison.OrdinalIgnoreCase))
            throw new InvalidOperationException($"Lesson file {file} escapes the content directory");
        if (!File.Exists(full)) return "";
        var text = await File.ReadAllTextAsync(full, ct);
        return text.Replace("\r\n", "\n");
    }

    private static double ParseDifficulty(JsonElement e) => e.ValueKind switch
    {
        JsonValueKind.Number => Math.Clamp(e.GetDouble(), 0, 1),
        JsonValueKind.String => e.GetString()?.ToLowerInvariant() switch
        {
            "easy" => 0.3,
            "hard" => 0.7,
            var s when double.TryParse(s, System.Globalization.NumberStyles.Float, System.Globalization.CultureInfo.InvariantCulture, out var d) => Math.Clamp(d, 0, 1),
            _ => 0.5,
        },
        _ => 0.5,
    };

    private static bool JsonEquivalent(string a, string b)
    {
        try
        {
            using var da = JsonDocument.Parse(a);
            using var dbb = JsonDocument.Parse(b);
            return JsonElement.DeepEquals(da.RootElement, dbb.RootElement);
        }
        catch (JsonException)
        {
            return false;
        }
    }
}
