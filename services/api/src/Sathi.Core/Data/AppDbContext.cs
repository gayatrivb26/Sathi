using Microsoft.AspNetCore.DataProtection.EntityFrameworkCore;
using Microsoft.AspNetCore.Identity;
using Microsoft.AspNetCore.Identity.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore;
using Sathi.Core.Domain;

namespace Sathi.Core.Data;

public sealed class AppDbContext(DbContextOptions<AppDbContext> options)
    : IdentityDbContext<AppUser, AppRole, Guid>(options), IDataProtectionKeyContext
{
    public const string Schema = "app";

    public DbSet<DataProtectionKey> DataProtectionKeys => Set<DataProtectionKey>();
    public DbSet<UserPreference> UserPreferences => Set<UserPreference>();
    public DbSet<Course> Courses => Set<Course>();
    public DbSet<Enrollment> Enrollments => Set<Enrollment>();
    public DbSet<CourseModule> CourseModules => Set<CourseModule>();
    public DbSet<Lesson> Lessons => Set<Lesson>();
    public DbSet<Concept> Concepts => Set<Concept>();
    public DbSet<LessonConcept> LessonConcepts => Set<LessonConcept>();
    public DbSet<LearningObjective> LearningObjectives => Set<LearningObjective>();
    public DbSet<ConceptPrerequisite> ConceptPrerequisites => Set<ConceptPrerequisite>();
    public DbSet<LessonProgress> LessonProgress => Set<LessonProgress>();
    public DbSet<Conversation> Conversations => Set<Conversation>();
    public DbSet<Message> Messages => Set<Message>();
    public DbSet<MessageFeedback> MessageFeedback => Set<MessageFeedback>();
    public DbSet<Document> Documents => Set<Document>();
    public DbSet<DocumentVersion> DocumentVersions => Set<DocumentVersion>();
    public DbSet<IngestionJob> IngestionJobs => Set<IngestionJob>();
    public DbSet<AiRun> AiRuns => Set<AiRun>();
    public DbSet<AiRunStep> AiRunSteps => Set<AiRunStep>();
    public DbSet<Question> Questions => Set<Question>();
    public DbSet<QuestionOption> QuestionOptions => Set<QuestionOption>();
    public DbSet<Rubric> Rubrics => Set<Rubric>();
    public DbSet<Quiz> Quizzes => Set<Quiz>();
    public DbSet<QuizQuestion> QuizQuestions => Set<QuizQuestion>();
    public DbSet<QuizAttempt> QuizAttempts => Set<QuizAttempt>();
    public DbSet<SubmittedAnswer> SubmittedAnswers => Set<SubmittedAnswer>();
    public DbSet<GradingResult> GradingResults => Set<GradingResult>();
    public DbSet<ConceptMastery> ConceptMastery => Set<ConceptMastery>();
    public DbSet<ConceptMasteryHistory> ConceptMasteryHistory => Set<ConceptMasteryHistory>();
    public DbSet<RevisionCard> RevisionCards => Set<RevisionCard>();
    public DbSet<Recommendation> Recommendations => Set<Recommendation>();
    public DbSet<UsageRecord> UsageRecords => Set<UsageRecord>();
    public DbSet<AuditEvent> AuditEvents => Set<AuditEvent>();
    public DbSet<OutboxMessage> OutboxMessages => Set<OutboxMessage>();
    public DbSet<CourseInstructor> CourseInstructors => Set<CourseInstructor>();
    public DbSet<CourseClass> Classes => Set<CourseClass>();
    public DbSet<ClassMember> ClassMembers => Set<ClassMember>();
    public DbSet<ClassInvite> ClassInvites => Set<ClassInvite>();
    public DbSet<StaffInvite> StaffInvites => Set<StaffInvite>();
    public DbSet<GuardianConsent> GuardianConsents => Set<GuardianConsent>();

    protected override void OnModelCreating(ModelBuilder b)
    {
        base.OnModelCreating(b);
        b.HasDefaultSchema(Schema);

        // ---- Identity (snake_case table names, contract §3.1) ----
        b.Entity<AppUser>(e =>
        {
            e.ToTable("users");
            e.Property(u => u.DisplayName).IsRequired();
            e.Property(u => u.Id).ValueGeneratedNever();
            e.Property(u => u.DateOfBirth).HasColumnType("date");
            e.Property(u => u.IsMinor).HasDefaultValue(false);
            e.Property(u => u.GuardianConsentStatus).HasDefaultValue(GuardianConsentStatuses.NotRequired);
        });
        b.Entity<AppRole>(e => { e.ToTable("roles"); e.Property(r => r.Id).ValueGeneratedNever(); });
        b.Entity<IdentityUserRole<Guid>>().ToTable("user_roles");
        b.Entity<IdentityUserClaim<Guid>>().ToTable("user_claims");
        b.Entity<IdentityUserLogin<Guid>>().ToTable("user_logins");
        b.Entity<IdentityUserToken<Guid>>().ToTable("user_tokens");
        b.Entity<IdentityRoleClaim<Guid>>().ToTable("role_claims");
        b.Entity<DataProtectionKey>().ToTable("data_protection_keys");

        b.Entity<UserPreference>(e =>
        {
            e.ToTable("user_preferences");
            e.HasKey(x => x.UserId);
            e.HasOne<AppUser>().WithOne().HasForeignKey<UserPreference>(x => x.UserId).OnDelete(DeleteBehavior.Cascade);
            e.Property(x => x.Timezone).HasDefaultValue("Asia/Kolkata");
            e.Property(x => x.ReminderHour).HasDefaultValue(18);
        });

        b.Entity<Course>(e =>
        {
            e.ToTable("courses");
            e.HasIndex(x => x.Slug).IsUnique();
            e.Property(x => x.Visibility).HasDefaultValue(CourseVisibilities.Public);
        });

        b.Entity<Enrollment>(e =>
        {
            e.ToTable("enrollments");
            e.HasIndex(x => new { x.UserId, x.CourseId }).IsUnique();
            e.HasOne<AppUser>().WithMany().HasForeignKey(x => x.UserId).OnDelete(DeleteBehavior.Cascade);
            e.HasOne<Course>().WithMany().HasForeignKey(x => x.CourseId).OnDelete(DeleteBehavior.Cascade);
            e.HasOne<Lesson>().WithMany().HasForeignKey(x => x.CurrentLessonId).OnDelete(DeleteBehavior.SetNull);
        });

        b.Entity<CourseModule>(e =>
        {
            e.ToTable("course_modules");
            e.HasIndex(x => new { x.CourseId, x.Position });
            e.HasOne(x => x.Course).WithMany(c => c.Modules).HasForeignKey(x => x.CourseId).OnDelete(DeleteBehavior.Cascade);
        });

        b.Entity<Lesson>(e =>
        {
            e.ToTable("lessons");
            e.HasIndex(x => new { x.ModuleId, x.Position });
            e.HasOne(x => x.Module).WithMany(m => m.Lessons).HasForeignKey(x => x.ModuleId).OnDelete(DeleteBehavior.Cascade);
        });

        b.Entity<Concept>(e =>
        {
            e.ToTable("concepts");
            e.HasIndex(x => new { x.CourseId, x.Slug }).IsUnique();
            e.HasOne<Course>().WithMany(c => c.Concepts).HasForeignKey(x => x.CourseId).OnDelete(DeleteBehavior.Cascade);
        });

        b.Entity<LessonConcept>(e =>
        {
            e.ToTable("lesson_concepts");
            e.HasKey(x => new { x.LessonId, x.ConceptId });
            e.HasOne<Lesson>().WithMany(l => l.LessonConcepts).HasForeignKey(x => x.LessonId).OnDelete(DeleteBehavior.Cascade);
            e.HasOne(x => x.Concept).WithMany().HasForeignKey(x => x.ConceptId).OnDelete(DeleteBehavior.Cascade);
        });

        b.Entity<LearningObjective>(e =>
        {
            e.ToTable("learning_objectives");
            e.HasIndex(x => new { x.LessonId, x.Position });
            e.HasOne<Lesson>().WithMany(l => l.Objectives).HasForeignKey(x => x.LessonId).OnDelete(DeleteBehavior.Cascade);
        });

        b.Entity<ConceptPrerequisite>(e =>
        {
            e.ToTable("concept_prerequisites");
            e.HasKey(x => new { x.ConceptId, x.PrerequisiteConceptId });
            e.HasOne<Concept>().WithMany().HasForeignKey(x => x.ConceptId).OnDelete(DeleteBehavior.Cascade);
            e.HasOne<Concept>().WithMany().HasForeignKey(x => x.PrerequisiteConceptId).OnDelete(DeleteBehavior.Cascade);
        });

        b.Entity<LessonProgress>(e =>
        {
            e.ToTable("lesson_progress");
            e.HasIndex(x => new { x.UserId, x.LessonId }).IsUnique();
            e.HasOne<AppUser>().WithMany().HasForeignKey(x => x.UserId).OnDelete(DeleteBehavior.Cascade);
            e.HasOne<Lesson>().WithMany().HasForeignKey(x => x.LessonId).OnDelete(DeleteBehavior.Cascade);
        });

        b.Entity<Conversation>(e =>
        {
            e.ToTable("conversations");
            e.HasIndex(x => new { x.UserId, x.UpdatedAt }).IsDescending(false, true);
            e.HasOne<AppUser>().WithMany().HasForeignKey(x => x.UserId).OnDelete(DeleteBehavior.Cascade);
            e.HasOne<Course>().WithMany().HasForeignKey(x => x.CourseId).OnDelete(DeleteBehavior.Cascade);
            e.HasOne<Lesson>().WithMany().HasForeignKey(x => x.LessonId).OnDelete(DeleteBehavior.SetNull);
        });

        b.Entity<Message>(e =>
        {
            e.ToTable("messages");
            e.HasIndex(x => new { x.ConversationId, x.CreatedAt });
            e.HasIndex(x => new { x.ConversationId, x.IdempotencyKey }).IsUnique().HasFilter("idempotency_key IS NOT NULL");
            e.Property(x => x.CitationsJson).HasColumnName("citations").HasColumnType("jsonb");
            e.Property(x => x.AnswerBasis).HasColumnType("text[]");
            e.HasOne<Conversation>().WithMany().HasForeignKey(x => x.ConversationId).OnDelete(DeleteBehavior.Cascade);
        });

        b.Entity<MessageFeedback>(e =>
        {
            e.ToTable("message_feedback");
            e.HasIndex(x => new { x.MessageId, x.UserId }).IsUnique();
            e.HasOne<Message>().WithMany().HasForeignKey(x => x.MessageId).OnDelete(DeleteBehavior.Cascade);
            e.HasOne<AppUser>().WithMany().HasForeignKey(x => x.UserId).OnDelete(DeleteBehavior.Cascade);
        });

        b.Entity<Document>(e =>
        {
            e.ToTable("documents");
            e.HasIndex(x => new { x.OwnerUserId, x.CreatedAt }).IsDescending(false, true);
            e.HasIndex(x => new { x.CourseId, x.Scope });
            e.HasIndex(x => new { x.OwnerUserId, x.IdempotencyKey }).IsUnique().HasFilter("idempotency_key IS NOT NULL");
        });

        b.Entity<DocumentVersion>(e =>
        {
            e.ToTable("document_versions");
            e.HasIndex(x => new { x.DocumentId, x.Version }).IsUnique();
            e.HasOne<Document>().WithMany().HasForeignKey(x => x.DocumentId).OnDelete(DeleteBehavior.Cascade);
        });

        b.Entity<IngestionJob>(e =>
        {
            e.ToTable("ingestion_jobs");
            e.HasIndex(x => new { x.DocumentId, x.DocumentVersion }).IsUnique();
            e.HasIndex(x => x.ReferenceId);
            e.HasOne<Document>().WithMany().HasForeignKey(x => x.DocumentId).OnDelete(DeleteBehavior.Cascade);
        });

        b.Entity<AiRun>(e =>
        {
            e.ToTable("ai_runs");
            e.HasIndex(x => x.ReferenceId);
            e.HasIndex(x => x.TraceId);
            e.HasIndex(x => new { x.Status, x.StartedAt }).IsDescending(false, true);
            e.Property(x => x.EstimatedCostUsd).HasColumnType("numeric(12,6)");
        });

        b.Entity<AiRunStep>(e =>
        {
            e.ToTable("ai_run_steps");
            e.HasIndex(x => x.RunId);
            e.Property(x => x.MetricsJson).HasColumnName("metrics").HasColumnType("jsonb");
            e.HasOne<AiRun>().WithMany().HasForeignKey(x => x.RunId).OnDelete(DeleteBehavior.Cascade);
        });

        b.Entity<Question>(e =>
        {
            e.ToTable("question_bank");
            e.HasIndex(x => new { x.CourseId, x.ConceptId, x.Status });
            e.HasOne<Course>().WithMany().HasForeignKey(x => x.CourseId).OnDelete(DeleteBehavior.Cascade);
            e.HasOne(x => x.Concept).WithMany().HasForeignKey(x => x.ConceptId).OnDelete(DeleteBehavior.Cascade);
            e.HasOne<Lesson>().WithMany().HasForeignKey(x => x.LessonId).OnDelete(DeleteBehavior.SetNull);
        });

        b.Entity<QuestionOption>(e =>
        {
            e.ToTable("question_options");
            e.HasIndex(x => new { x.QuestionId, x.Position });
            e.HasOne<Question>().WithMany(q => q.Options).HasForeignKey(x => x.QuestionId).OnDelete(DeleteBehavior.Cascade);
        });

        b.Entity<Rubric>(e =>
        {
            e.ToTable("rubrics");
            e.HasIndex(x => new { x.QuestionId, x.Version }).IsUnique();
            e.Property(x => x.CriteriaJson).HasColumnName("criteria").HasColumnType("jsonb");
            e.HasOne<Question>().WithMany().HasForeignKey(x => x.QuestionId).OnDelete(DeleteBehavior.Cascade);
        });

        b.Entity<Quiz>(e =>
        {
            e.ToTable("quizzes");
            e.HasIndex(x => new { x.CourseId, x.Kind });
            e.HasOne<Course>().WithMany().HasForeignKey(x => x.CourseId).OnDelete(DeleteBehavior.Cascade);
        });

        b.Entity<QuizQuestion>(e =>
        {
            e.ToTable("quiz_questions");
            e.HasKey(x => new { x.QuizId, x.QuestionId });
            e.HasOne<Quiz>().WithMany().HasForeignKey(x => x.QuizId).OnDelete(DeleteBehavior.Cascade);
            e.HasOne<Question>().WithMany().HasForeignKey(x => x.QuestionId).OnDelete(DeleteBehavior.Cascade);
        });

        b.Entity<QuizAttempt>(e =>
        {
            e.ToTable("quiz_attempts");
            e.HasIndex(x => new { x.UserId, x.StartedAt }).IsDescending(false, true);
            e.HasOne<Quiz>().WithMany().HasForeignKey(x => x.QuizId).OnDelete(DeleteBehavior.Cascade);
            e.HasOne<AppUser>().WithMany().HasForeignKey(x => x.UserId).OnDelete(DeleteBehavior.Cascade);
        });

        b.Entity<SubmittedAnswer>(e =>
        {
            e.ToTable("submitted_answers");
            e.HasIndex(x => new { x.AttemptId, x.QuestionId }).IsUnique();
            e.HasOne<QuizAttempt>().WithMany().HasForeignKey(x => x.AttemptId).OnDelete(DeleteBehavior.Cascade);
            e.HasOne<Question>().WithMany().HasForeignKey(x => x.QuestionId).OnDelete(DeleteBehavior.Cascade);
        });

        b.Entity<GradingResult>(e =>
        {
            e.ToTable("grading_results");
            e.HasIndex(x => x.Status);
            e.HasIndex(x => x.SubmittedAnswerId);
            e.Property(x => x.CriteriaScoresJson).HasColumnName("criteria_scores").HasColumnType("jsonb");
            e.HasOne<SubmittedAnswer>().WithMany().HasForeignKey(x => x.SubmittedAnswerId).OnDelete(DeleteBehavior.Cascade);
        });

        b.Entity<ConceptMastery>(e =>
        {
            e.ToTable("concept_mastery");
            e.HasKey(x => new { x.UserId, x.ConceptId });
            e.HasOne<AppUser>().WithMany().HasForeignKey(x => x.UserId).OnDelete(DeleteBehavior.Cascade);
            e.HasOne<Concept>().WithMany().HasForeignKey(x => x.ConceptId).OnDelete(DeleteBehavior.Cascade);
        });

        b.Entity<ConceptMasteryHistory>(e =>
        {
            e.ToTable("concept_mastery_history");
            e.HasIndex(x => new { x.UserId, x.CreatedAt });
            e.HasOne<AppUser>().WithMany().HasForeignKey(x => x.UserId).OnDelete(DeleteBehavior.Cascade);
            e.HasOne<Concept>().WithMany().HasForeignKey(x => x.ConceptId).OnDelete(DeleteBehavior.Cascade);
        });

        b.Entity<RevisionCard>(e =>
        {
            e.ToTable("revision_cards");
            e.HasIndex(x => new { x.UserId, x.QuestionId }).IsUnique();
            e.HasIndex(x => new { x.UserId, x.DueAt });
            e.Property(x => x.EaseFactor).HasDefaultValue(2.5);
            e.HasOne<AppUser>().WithMany().HasForeignKey(x => x.UserId).OnDelete(DeleteBehavior.Cascade);
            e.HasOne<Question>().WithMany().HasForeignKey(x => x.QuestionId).OnDelete(DeleteBehavior.Cascade);
            e.HasOne<Concept>().WithMany().HasForeignKey(x => x.ConceptId).OnDelete(DeleteBehavior.Cascade);
        });

        b.Entity<Recommendation>(e =>
        {
            e.ToTable("recommendations");
            e.HasIndex(x => new { x.UserId, x.CourseId, x.CreatedAt }).IsDescending(false, false, true);
            e.HasOne<AppUser>().WithMany().HasForeignKey(x => x.UserId).OnDelete(DeleteBehavior.Cascade);
        });

        b.Entity<UsageRecord>(e =>
        {
            e.ToTable("usage_records");
            e.HasIndex(x => new { x.UserId, x.Day, x.Kind }).IsUnique();
            e.Property(x => x.CostUsd).HasColumnType("numeric(12,6)");
            e.HasOne<AppUser>().WithMany().HasForeignKey(x => x.UserId).OnDelete(DeleteBehavior.Cascade);
        });

        b.Entity<AuditEvent>(e =>
        {
            e.ToTable("audit_events");
            e.HasIndex(x => new { x.ActorUserId, x.CreatedAt });
            e.Property(x => x.MetadataJson).HasColumnName("metadata").HasColumnType("jsonb");
        });

        b.Entity<OutboxMessage>(e =>
        {
            e.ToTable("outbox_messages");
            e.HasIndex(x => x.ProcessedAt);
            e.Property(x => x.PayloadJson).HasColumnName("payload").HasColumnType("jsonb");
        });

        // ---- Release 2: course access, classes, staff invites, guardian consent (contract §11) ----
        b.Entity<CourseInstructor>(e =>
        {
            e.ToTable("course_instructors");
            e.HasKey(x => new { x.CourseId, x.UserId });
            e.HasIndex(x => x.UserId);
            e.HasOne<Course>().WithMany().HasForeignKey(x => x.CourseId).OnDelete(DeleteBehavior.Cascade);
            e.HasOne<AppUser>().WithMany().HasForeignKey(x => x.UserId).OnDelete(DeleteBehavior.Cascade);
        });

        b.Entity<CourseClass>(e =>
        {
            e.ToTable("classes");
            e.HasIndex(x => x.JoinCode).IsUnique();
            e.HasIndex(x => x.CourseId);
            // DB default true for raw inserts; EF always sends the value (false is the CLR sentinel and would otherwise be dropped).
            e.Property(x => x.JoinEnabled).HasDefaultValue(true).ValueGeneratedNever();
            e.HasOne<Course>().WithMany().HasForeignKey(x => x.CourseId).OnDelete(DeleteBehavior.Cascade);
        });

        b.Entity<ClassMember>(e =>
        {
            e.ToTable("class_members");
            e.HasKey(x => new { x.ClassId, x.UserId });
            e.HasIndex(x => x.UserId);
            e.HasOne<CourseClass>().WithMany().HasForeignKey(x => x.ClassId).OnDelete(DeleteBehavior.Cascade);
            e.HasOne<AppUser>().WithMany().HasForeignKey(x => x.UserId).OnDelete(DeleteBehavior.Cascade);
        });

        b.Entity<ClassInvite>(e =>
        {
            e.ToTable("class_invites");
            e.HasIndex(x => new { x.ClassId, x.EmailNormalized }).IsUnique().HasFilter("accepted_at IS NULL AND revoked_at IS NULL");
            e.HasIndex(x => x.TokenHash).IsUnique();
            e.HasOne<CourseClass>().WithMany().HasForeignKey(x => x.ClassId).OnDelete(DeleteBehavior.Cascade);
        });

        b.Entity<StaffInvite>(e =>
        {
            e.ToTable("staff_invites");
            e.HasIndex(x => x.TokenHash).IsUnique();
            e.HasIndex(x => x.EmailNormalized);
            e.HasOne<Course>().WithMany().HasForeignKey(x => x.CourseId).OnDelete(DeleteBehavior.SetNull);
        });

        b.Entity<GuardianConsent>(e =>
        {
            e.ToTable("guardian_consents");
            e.HasIndex(x => x.TokenHash).IsUnique();
            e.HasIndex(x => x.UserId);
            e.HasOne<AppUser>().WithMany().HasForeignKey(x => x.UserId).OnDelete(DeleteBehavior.Cascade);
        });

        // IDs are generated in app code (UUID v7) — never by EF, so graph discovery always means "Added".
        foreach (var entity in b.Model.GetEntityTypes())
        {
            var pk = entity.FindPrimaryKey();
            if (pk is { Properties.Count: 1 } && pk.Properties[0].ClrType == typeof(Guid))
                pk.Properties[0].ValueGenerated = Microsoft.EntityFrameworkCore.Metadata.ValueGenerated.Never;
        }
    }

    protected override void ConfigureConventions(ModelConfigurationBuilder c)
    {
        // All timestamps are timestamptz in UTC.
        c.Properties<DateTime>().HaveColumnType("timestamp with time zone");
        c.Properties<DateTime?>().HaveColumnType("timestamp with time zone");
    }
}
