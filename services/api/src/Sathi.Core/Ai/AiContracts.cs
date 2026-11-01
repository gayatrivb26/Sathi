using System.Text.Json;
using System.Text.Json.Serialization;

namespace Sathi.Core.Ai;

// Internal API shapes (contract §6). camelCase on the wire.

public static class AiJson
{
    public static readonly JsonSerializerOptions Options = new(JsonSerializerDefaults.Web)
    {
        DefaultIgnoreCondition = JsonIgnoreCondition.Never,
    };
}

public sealed record CourseRef(Guid Id, string Title);
public sealed record LessonRef(Guid Id, string Title);
public sealed record HistoryTurn(string Role, string Content);
public sealed record WeakConcept(string Name, double Mastery);

public sealed record TutorRequest(
    Guid RunId,
    Guid ConversationId,
    CourseRef Course,
    LessonRef? Lesson,
    string Question,
    string Level,
    string Mode,
    string? Adjust,
    string? PreviousAnswer,
    bool WebSearch,
    IReadOnlyList<HistoryTurn> History,
    IReadOnlyList<WeakConcept> WeakConcepts);

/// <summary>Citation (contract §5.3).</summary>
public sealed record Citation(
    int Index,
    string SourceType,
    string Title,
    Guid? DocumentId,
    Guid? LessonId,
    int? Page,
    string? Url,
    string Snippet);

public sealed record SseEvent(string Event, string Data);

public sealed record ParseRequest(Guid DocumentId, int DocumentVersion, string StorageKey, string ContentType, string FileName);
public sealed record ParseResponse(int PageCount, int CharCount, string ParsedKey);

public sealed record IndexRequest(
    Guid DocumentId, int DocumentVersion, string ParsedKey, string Scope, Guid? OwnerUserId, Guid? CourseId, Guid? LessonId,
    string SourceType, string Title);

public sealed record IndexResponse(int PassageCount, string? EmbeddingModel);

public sealed record IngestTextRequest(
    Guid DocumentId, int DocumentVersion, string Scope, Guid CourseId, Guid LessonId, string SourceType, string Title, string Markdown);

public sealed record QuizConceptRef(Guid Id, string Name, string Description);

public sealed record QuizGenerateRequest(Guid CourseId, QuizConceptRef Concept, int Count, double Difficulty, IReadOnlyList<string> LessonTitles);

public sealed record GeneratedOption(string Label, string Text, bool IsCorrect);

public sealed record GeneratedQuestion(string Stem, string Explanation, double Difficulty, List<GeneratedOption> Options);

public sealed record QuizGenerateResponse(
    List<GeneratedQuestion> Questions, string? Model, string? PromptHash, int InputTokens, int OutputTokens, decimal CostUsd);

public sealed record RubricCriterion(string Id, string Description, double Points);

public sealed record GradeRubric(int Version, IReadOnlyList<RubricCriterion> Criteria, string ModelAnswer);

public sealed record GradeRequest(string QuestionStem, GradeRubric Rubric, string AnswerText);

public sealed record CriterionScore(string Id, double Points, string? Comment);

public sealed record GradeResponse(
    double Score, double MaxScore, double Confidence, string Feedback, List<CriterionScore>? CriteriaScores,
    string? Model, string? PromptHash, int InputTokens, int OutputTokens, decimal CostUsd);

public sealed record MasteryUpdateRequest(double Prior, int Attempts, bool Correct, double Difficulty, double? Score);

public sealed record MasteryUpdateResponse(double Mastery);

public sealed record RecommendationConcept(Guid Id, string Name, double Mastery, int Attempts, DateTime? LastPracticedAt, IReadOnlyList<Guid> PrerequisiteIds);

public sealed record RecommendationsRequest(
    IReadOnlyList<RecommendationConcept> Concepts,
    LessonRef? NextLesson,
    int RevisionDue,
    IReadOnlyDictionary<Guid, IReadOnlyList<Guid>> LessonConcepts);

public sealed record RecommendationItem(string Type, Guid TargetId, string Title, string Reason, double Score);

public sealed record RecommendationsResponse(List<RecommendationItem> Items);

public sealed record EvalRunRequest(string Dataset);

public sealed record DebugCaptureRequest(Guid ConversationId, bool Enabled, DateTime ExpiresAt);
