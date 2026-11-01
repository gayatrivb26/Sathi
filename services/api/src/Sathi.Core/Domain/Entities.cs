namespace Sathi.Core.Domain;

// Entities for schema `app` (contract §3.1). Enums are lowercase text (see Domain/Values.cs).
// jsonb columns are mapped as raw JSON strings (property suffix "Json") and (de)serialised by callers.

public sealed class UserPreference
{
    public Guid UserId { get; set; }
    public string Level { get; set; } = Levels.Beginner;
    public string Timezone { get; set; } = "Asia/Kolkata";
    public int ReminderHour { get; set; } = 18;
    public bool RemindersEnabled { get; set; } = true;
    public Guid? ActiveCourseId { get; set; }
    public DateTime? OnboardingCompletedAt { get; set; }
}

public sealed class Course
{
    public Guid Id { get; set; } = Guid.CreateVersion7();
    public string Slug { get; set; } = "";
    public string Title { get; set; } = "";
    public string Description { get; set; } = "";
    public string Domain { get; set; } = "";
    public bool IsPublished { get; set; }
    /// <summary>public (any signed-in student) or private (class members only) — contract §11.1.</summary>
    public string Visibility { get; set; } = CourseVisibilities.Public;
    public Guid? CreatedBy { get; set; }
    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
    public DateTime UpdatedAt { get; set; } = DateTime.UtcNow;
    public List<CourseModule> Modules { get; set; } = [];
    public List<Concept> Concepts { get; set; } = [];
}

public sealed class Enrollment
{
    public Guid Id { get; set; } = Guid.CreateVersion7();
    public Guid UserId { get; set; }
    public Guid CourseId { get; set; }
    public DateTime EnrolledAt { get; set; } = DateTime.UtcNow;
    public DateTime? DiagnosticCompletedAt { get; set; }
    public Guid? CurrentLessonId { get; set; }
}

public sealed class CourseModule
{
    public Guid Id { get; set; } = Guid.CreateVersion7();
    public Guid CourseId { get; set; }
    public Course? Course { get; set; }
    public string Title { get; set; } = "";
    public string Summary { get; set; } = "";
    public int Position { get; set; }
    public List<Lesson> Lessons { get; set; } = [];
}

public sealed class Lesson
{
    public Guid Id { get; set; } = Guid.CreateVersion7();
    public Guid ModuleId { get; set; }
    public CourseModule? Module { get; set; }
    public string Title { get; set; } = "";
    public string Summary { get; set; } = "";
    public string ContentMarkdown { get; set; } = "";
    public int EstimatedMinutes { get; set; }
    public int Position { get; set; }
    public int Version { get; set; } = 1;
    public Guid? DocumentId { get; set; }
    public DateTime UpdatedAt { get; set; } = DateTime.UtcNow;
    public List<LessonConcept> LessonConcepts { get; set; } = [];
    public List<LearningObjective> Objectives { get; set; } = [];
}

public sealed class Concept
{
    public Guid Id { get; set; } = Guid.CreateVersion7();
    public Guid CourseId { get; set; }
    public string Slug { get; set; } = "";
    public string Name { get; set; } = "";
    public string Description { get; set; } = "";
}

public sealed class LessonConcept
{
    public Guid LessonId { get; set; }
    public Guid ConceptId { get; set; }
    public Concept? Concept { get; set; }
}

public sealed class LearningObjective
{
    public Guid Id { get; set; } = Guid.CreateVersion7();
    public Guid LessonId { get; set; }
    public string Text { get; set; } = "";
    public int Position { get; set; }
}

public sealed class ConceptPrerequisite
{
    public Guid ConceptId { get; set; }
    public Guid PrerequisiteConceptId { get; set; }
}

public sealed class LessonProgress
{
    public Guid Id { get; set; } = Guid.CreateVersion7();
    public Guid UserId { get; set; }
    public Guid LessonId { get; set; }
    public string Status { get; set; } = LessonStatuses.NotStarted;
    public int Percent { get; set; }
    public DateTime LastViewedAt { get; set; } = DateTime.UtcNow;
    public DateTime? CompletedAt { get; set; }
}

public sealed class Conversation
{
    public Guid Id { get; set; } = Guid.CreateVersion7();
    public Guid UserId { get; set; }
    public Guid CourseId { get; set; }
    public Guid? LessonId { get; set; }
    public string Title { get; set; } = "New conversation";
    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
    public DateTime UpdatedAt { get; set; } = DateTime.UtcNow;
    public DateTime? DeletedAt { get; set; }
}

public sealed class Message
{
    public Guid Id { get; set; } = Guid.CreateVersion7();
    public Guid ConversationId { get; set; }
    public string Role { get; set; } = MessageRoles.User;
    public string Content { get; set; } = "";
    public string Level { get; set; } = Levels.Beginner;
    public string Mode { get; set; } = TutorModes.Explain;
    public string? Adjust { get; set; }
    public bool WebSearch { get; set; }
    public string CitationsJson { get; set; } = "[]";
    public List<string> AnswerBasis { get; set; } = [];
    public string Status { get; set; } = MessageStatuses.Complete;
    public string? ErrorCode { get; set; }
    public Guid? RunId { get; set; }
    public string? IdempotencyKey { get; set; }
    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
    public DateTime? CompletedAt { get; set; }
}

public sealed class MessageFeedback
{
    public Guid Id { get; set; } = Guid.CreateVersion7();
    public Guid MessageId { get; set; }
    public Guid UserId { get; set; }
    public short Rating { get; set; }
    public string? Comment { get; set; }
    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
}

public sealed class Document
{
    public Guid Id { get; set; } = Guid.CreateVersion7();
    public string Scope { get; set; } = DocumentScopes.User;
    public Guid? OwnerUserId { get; set; }
    public Guid? CourseId { get; set; }
    public Guid? LessonId { get; set; }
    public string SourceType { get; set; } = SourceTypes.Upload;
    public string FileName { get; set; } = "";
    public string ContentType { get; set; } = "";
    public long SizeBytes { get; set; }
    public string Sha256 { get; set; } = "";
    public int CurrentVersion { get; set; } = 1;
    public string Status { get; set; } = DocumentStatuses.Queued;
    /// <summary>Upload Idempotency-Key (contract §11.6); unique per owner when not null.</summary>
    public string? IdempotencyKey { get; set; }
    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
    public DateTime UpdatedAt { get; set; } = DateTime.UtcNow;
    public DateTime? DeletedAt { get; set; }
}

public sealed class DocumentVersion
{
    public Guid Id { get; set; } = Guid.CreateVersion7();
    public Guid DocumentId { get; set; }
    public int Version { get; set; }
    public string StorageKey { get; set; } = "";
    public string Sha256 { get; set; } = "";
    public long SizeBytes { get; set; }
    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
}

public sealed class IngestionJob
{
    public Guid Id { get; set; } = Guid.CreateVersion7();
    public Guid DocumentId { get; set; }
    public int DocumentVersion { get; set; }
    public string Status { get; set; } = IngestionStages.Queued;
    public string Stage { get; set; } = IngestionStages.Queued;
    public int ProgressPercent { get; set; } = 5;
    public int? PassageCount { get; set; }
    public string? ErrorCode { get; set; }
    public string? ErrorMessage { get; set; }
    public string? ReferenceId { get; set; }
    public string TraceId { get; set; } = "";
    public string? HangfireJobId { get; set; }
    public int Attempt { get; set; } = 1;
    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
    public DateTime UpdatedAt { get; set; } = DateTime.UtcNow;
    public DateTime? CompletedAt { get; set; }
}

public sealed class AiRun
{
    public Guid Id { get; set; } = Guid.CreateVersion7();
    public string TraceId { get; set; } = "";
    public string ReferenceId { get; set; } = "";
    public string UserIdHash { get; set; } = "";
    public Guid? UserId { get; set; }
    public string Type { get; set; } = AiRunTypes.Chat;
    public string Status { get; set; } = AiRunStatuses.Running;
    public DateTime StartedAt { get; set; } = DateTime.UtcNow;
    public DateTime? FinishedAt { get; set; }
    public string? HangfireJobId { get; set; }
    public string? Model { get; set; }
    public string? Provider { get; set; }
    public string? PromptHash { get; set; }
    public int? InputTokens { get; set; }
    public int? OutputTokens { get; set; }
    public decimal? EstimatedCostUsd { get; set; }
    public int? TtftMs { get; set; }
    public int? LatencyMs { get; set; }
    public string? ErrorCode { get; set; }
    public string? ErrorMessage { get; set; }
    public Guid? ConversationId { get; set; }
    public Guid? DocumentId { get; set; }
}

public sealed class AiRunStep
{
    public Guid Id { get; set; } = Guid.CreateVersion7();
    public Guid RunId { get; set; }
    public string Step { get; set; } = "";
    public DateTime StartedAt { get; set; } = DateTime.UtcNow;
    public DateTime EndedAt { get; set; } = DateTime.UtcNow;
    public string Outcome { get; set; } = StepOutcomes.Ok;
    public string MetricsJson { get; set; } = "{}";
}

public sealed class Question
{
    public Guid Id { get; set; } = Guid.CreateVersion7();
    public Guid CourseId { get; set; }
    public Guid ConceptId { get; set; }
    public Concept? Concept { get; set; }
    public Guid? LessonId { get; set; }
    public string Type { get; set; } = QuestionTypes.Mcq;
    public string Stem { get; set; } = "";
    public string Explanation { get; set; } = "";
    public double Difficulty { get; set; } = 0.5;
    public string Source { get; set; } = QuestionSources.Seed;
    public string Status { get; set; } = QuestionStatuses.Published;
    public bool IsDiagnostic { get; set; }
    public Guid? CreatedBy { get; set; }
    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
    public DateTime UpdatedAt { get; set; } = DateTime.UtcNow;
    public List<QuestionOption> Options { get; set; } = [];
}

public sealed class QuestionOption
{
    public Guid Id { get; set; } = Guid.CreateVersion7();
    public Guid QuestionId { get; set; }
    public string Label { get; set; } = "A";
    public string Text { get; set; } = "";
    public bool IsCorrect { get; set; }
    public int Position { get; set; }
}

public sealed class Rubric
{
    public Guid Id { get; set; } = Guid.CreateVersion7();
    public Guid QuestionId { get; set; }
    public int Version { get; set; } = 1;
    public string CriteriaJson { get; set; } = "[]";
    public string ModelAnswer { get; set; } = "";
    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
}

public sealed class Quiz
{
    public Guid Id { get; set; } = Guid.CreateVersion7();
    public Guid CourseId { get; set; }
    public string Title { get; set; } = "";
    public string Kind { get; set; } = QuizKinds.Practice;
    public Guid? ConceptId { get; set; }
    public Guid? LessonId { get; set; }
    public Guid? CreatedBy { get; set; }
    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
}

public sealed class QuizQuestion
{
    public Guid QuizId { get; set; }
    public Guid QuestionId { get; set; }
    public int Position { get; set; }
}

public sealed class QuizAttempt
{
    public Guid Id { get; set; } = Guid.CreateVersion7();
    public Guid QuizId { get; set; }
    public Guid UserId { get; set; }
    public DateTime StartedAt { get; set; } = DateTime.UtcNow;
    public DateTime? CompletedAt { get; set; }
    public int CorrectCount { get; set; }
    public int QuestionCount { get; set; }
}

public sealed class SubmittedAnswer
{
    public Guid Id { get; set; } = Guid.CreateVersion7();
    public Guid AttemptId { get; set; }
    public Guid QuestionId { get; set; }
    public Guid? SelectedOptionId { get; set; }
    public string? FreeText { get; set; }
    public bool? IsCorrect { get; set; }
    public double? MasteryBefore { get; set; }
    public double? MasteryAfter { get; set; }
    public DateTime SubmittedAt { get; set; } = DateTime.UtcNow;
}

public sealed class GradingResult
{
    public Guid Id { get; set; } = Guid.CreateVersion7();
    public Guid SubmittedAnswerId { get; set; }
    public int RubricVersion { get; set; }
    public double Score { get; set; }
    public double MaxScore { get; set; }
    public double Confidence { get; set; }
    public string Feedback { get; set; } = "";
    public string CriteriaScoresJson { get; set; } = "[]";
    public string Status { get; set; } = GradingStatuses.Pending;
    public Guid? ReviewedBy { get; set; }
    public DateTime? ReviewedAt { get; set; }
    public double? FinalScore { get; set; }
    public string? ReviewerFeedback { get; set; }
    public Guid? RunId { get; set; }
    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
}

public sealed class ConceptMastery
{
    public Guid UserId { get; set; }
    public Guid ConceptId { get; set; }
    public double Mastery { get; set; } = 0.30;
    public int Attempts { get; set; }
    public int Correct { get; set; }
    public DateTime LastPracticedAt { get; set; } = DateTime.UtcNow;
    public DateTime UpdatedAt { get; set; } = DateTime.UtcNow;
}

public sealed class ConceptMasteryHistory
{
    public Guid Id { get; set; } = Guid.CreateVersion7();
    public Guid UserId { get; set; }
    public Guid ConceptId { get; set; }
    public double Before { get; set; }
    public double After { get; set; }
    public string Source { get; set; } = MasterySources.Practice;
    public Guid? SourceId { get; set; }
    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
}

public sealed class RevisionCard
{
    public Guid Id { get; set; } = Guid.CreateVersion7();
    public Guid UserId { get; set; }
    public Guid CourseId { get; set; }
    public Guid QuestionId { get; set; }
    public Guid ConceptId { get; set; }
    public double EaseFactor { get; set; } = 2.5;
    public int IntervalDays { get; set; }
    public int Repetitions { get; set; }
    public DateTime DueAt { get; set; } = DateTime.UtcNow;
    public DateTime? LastReviewedAt { get; set; }
    public int? LastQuality { get; set; }
    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
}

public sealed class Recommendation
{
    public Guid Id { get; set; } = Guid.CreateVersion7();
    public Guid UserId { get; set; }
    public Guid CourseId { get; set; }
    public string Type { get; set; } = RecommendationTypes.Lesson;
    public Guid TargetId { get; set; }
    public string Title { get; set; } = "";
    public string Reason { get; set; } = "";
    public double Score { get; set; }
    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
    public DateTime? DismissedAt { get; set; }
}

public sealed class UsageRecord
{
    public Guid Id { get; set; } = Guid.CreateVersion7();
    public Guid UserId { get; set; }
    public DateOnly Day { get; set; }
    public string Kind { get; set; } = UsageKinds.Chat;
    public int Count { get; set; }
    public long InputTokens { get; set; }
    public long OutputTokens { get; set; }
    public decimal CostUsd { get; set; }
}

public sealed class AuditEvent
{
    public Guid Id { get; set; } = Guid.CreateVersion7();
    public Guid? ActorUserId { get; set; }
    public string Action { get; set; } = "";
    public string EntityType { get; set; } = "";
    public Guid? EntityId { get; set; }
    public string MetadataJson { get; set; } = "{}";
    public string TraceId { get; set; } = "";
    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
}

public sealed class OutboxMessage
{
    public Guid Id { get; set; } = Guid.CreateVersion7();
    public string Type { get; set; } = "";
    public string PayloadJson { get; set; } = "{}";
    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
    public DateTime? ProcessedAt { get; set; }
    public int Attempts { get; set; }
    public string? LastError { get; set; }
}

// ---------------- Release 2 (contract §11) ----------------

public sealed class CourseInstructor
{
    public Guid CourseId { get; set; }
    public Guid UserId { get; set; }
    public string Role { get; set; } = CourseInstructorRoles.Instructor;
    public DateTime AddedAt { get; set; } = DateTime.UtcNow;
}

/// <summary>A class (cohort) of students for one course. Table <c>classes</c>.</summary>
public sealed class CourseClass
{
    public Guid Id { get; set; } = Guid.CreateVersion7();
    public Guid CourseId { get; set; }
    public string Name { get; set; } = "";
    public string? Description { get; set; }
    /// <summary>8 characters from the join-code alphabet, stored without the dash.</summary>
    public string JoinCode { get; set; } = "";
    public bool JoinEnabled { get; set; } = true;
    public Guid CreatedBy { get; set; }
    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
    public DateTime? ArchivedAt { get; set; }
}

public sealed class ClassMember
{
    public Guid ClassId { get; set; }
    public Guid UserId { get; set; }
    public DateTime JoinedAt { get; set; } = DateTime.UtcNow;
    public string JoinedVia { get; set; } = ClassJoinMethods.Code;
    public DateTime? RemovedAt { get; set; }
}

public sealed class ClassInvite
{
    public Guid Id { get; set; } = Guid.CreateVersion7();
    public Guid ClassId { get; set; }
    public string EmailNormalized { get; set; } = "";
    /// <summary>SHA-256 hex of the raw (base64url) token; the raw token is only ever emailed.</summary>
    public string TokenHash { get; set; } = "";
    public Guid InvitedBy { get; set; }
    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
    public DateTime ExpiresAt { get; set; }
    public DateTime? AcceptedAt { get; set; }
    public Guid? AcceptedUserId { get; set; }
    public DateTime? RevokedAt { get; set; }
}

public sealed class StaffInvite
{
    public Guid Id { get; set; } = Guid.CreateVersion7();
    public string EmailNormalized { get; set; } = "";
    public string Role { get; set; } = Roles.Instructor;
    public Guid? CourseId { get; set; }
    public string TokenHash { get; set; } = "";
    public Guid InvitedBy { get; set; }
    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
    public DateTime ExpiresAt { get; set; }
    public DateTime? AcceptedAt { get; set; }
    public Guid? AcceptedUserId { get; set; }
    public DateTime? RevokedAt { get; set; }
}

/// <summary>Verifiable guardian consent record for an under-18 learner (contract §11.4). Long retention.</summary>
public sealed class GuardianConsent
{
    public Guid Id { get; set; } = Guid.CreateVersion7();
    public Guid UserId { get; set; }
    public string GuardianEmailNormalized { get; set; } = "";
    public string TokenHash { get; set; } = "";
    public string PolicyVersion { get; set; } = "";
    public DateTime RequestedAt { get; set; } = DateTime.UtcNow;
    public DateTime ExpiresAt { get; set; }
    public DateTime? DecidedAt { get; set; }
    public string? Decision { get; set; }
    public string? IpHash { get; set; }
    public string? UserAgentHash { get; set; }
}
