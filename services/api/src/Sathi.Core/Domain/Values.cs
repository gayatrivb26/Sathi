namespace Sathi.Core.Domain;

public static class Levels
{
    public const string Beginner = "beginner";
    public const string Intermediate = "intermediate";
    public const string Advanced = "advanced";
    public static readonly string[] All = [Beginner, Intermediate, Advanced];
}

public static class TutorModes
{
    public const string Explain = "explain";
    public const string Hint = "hint";
    public const string QuizMe = "quiz_me";
    public static readonly string[] All = [Explain, Hint, QuizMe];
}

public static class Adjustments
{
    public const string Simpler = "simpler";
    public const string Harder = "harder";
    public static readonly string[] All = [Simpler, Harder];
}

public static class MessageRoles
{
    public const string User = "user";
    public const string Assistant = "assistant";
}

public static class MessageStatuses
{
    public const string Streaming = "streaming";
    public const string Complete = "complete";
    public const string Partial = "partial";
    public const string Failed = "failed";
    public const string Cancelled = "cancelled";
}

public static class LessonStatuses
{
    public const string NotStarted = "not_started";
    public const string InProgress = "in_progress";
    public const string Completed = "completed";
}

public static class DocumentScopes
{
    public const string User = "user";
    public const string Course = "course";
}

public static class SourceTypes
{
    public const string Upload = "upload";
    public const string Course = "course";
    public const string Web = "web";
}

public static class DocumentStatuses
{
    public const string Queued = "queued";
    public const string Processing = "processing";
    public const string Ready = "ready";
    public const string Failed = "failed";
}

public static class IngestionStages
{
    public const string Queued = "queued";
    public const string Parsing = "parsing";
    public const string Indexing = "indexing";
    public const string Ready = "ready";
    public const string Failed = "failed";

    public static int Percent(string stage) => stage switch
    {
        Queued => 5,
        Parsing => 30,
        Indexing => 70,
        Ready => 100,
        _ => 0,
    };
}

public static class AiRunTypes
{
    public const string Chat = "chat";
    public const string Ingestion = "ingestion";
    public const string QuizGeneration = "quiz_generation";
    public const string Grading = "grading";
    public const string RevisionPlan = "revision_plan";
    public const string Evaluation = "evaluation";
}

public static class AiRunStatuses
{
    public const string Running = "running";
    public const string Succeeded = "succeeded";
    public const string Failed = "failed";
    public const string Cancelled = "cancelled";
}

public static class StepOutcomes
{
    public const string Ok = "ok";
    public const string Empty = "empty";
    public const string Failed = "failed";
    public const string Skipped = "skipped";
}

public static class QuestionTypes
{
    public const string Mcq = "mcq";
    public const string Short = "short";
}

public static class QuestionSources
{
    public const string Seed = "seed";
    public const string Generated = "generated";
    public const string Instructor = "instructor";
}

public static class QuestionStatuses
{
    public const string Draft = "draft";
    public const string Published = "published";
    public const string Archived = "archived";
    public static readonly string[] All = [Draft, Published, Archived];
}

public static class QuizKinds
{
    public const string Diagnostic = "diagnostic";
    public const string Practice = "practice";
    public const string LessonCheck = "lesson_check";
    public const string Revision = "revision";
}

public static class GradingStatuses
{
    public const string Pending = "pending";
    public const string AutoAccepted = "auto_accepted";
    public const string NeedsReview = "needs_review";
    public const string Reviewed = "reviewed";
    public const string Failed = "failed";
}

public static class MasterySources
{
    public const string Diagnostic = "diagnostic";
    public const string Practice = "practice";
    public const string Revision = "revision";
    public const string Grading = "grading";
}

public static class RecommendationTypes
{
    public const string Lesson = "lesson";
    public const string ConceptPractice = "concept_practice";
    public const string Quiz = "quiz";
    public const string Revision = "revision";
}

public static class UsageKinds
{
    public const string Chat = "chat";
    public const string WebSearch = "web_search";
    public const string Upload = "upload";
    public const string QuizGeneration = "quiz_generation";
    public const string Grading = "grading";
}

public static class OutboxTypes
{
    public const string DocumentDeleted = "document.deleted";
    public const string UserDeleted = "user.deleted";
}

public static class AuditActions
{
    public const string Login = "auth.login";
    public const string Logout = "auth.logout";
    public const string Register = "auth.register";
    public const string DocumentDelete = "document.delete";
    public const string UserDeleteRequested = "user.delete_requested";
    public const string GradingReview = "grading.review";
    public const string DebugCaptureEnable = "debug_capture.enable";
    public const string DebugCaptureDisable = "debug_capture.disable";
    public const string LogLevelChange = "admin.log_level";
    public const string ReminderSent = "reminder.sent";
    public const string ProfileUpdated = "user.profile_updated";
    public const string RolesChanged = "user.roles_changed";
    public const string UserLocked = "user.locked";
    public const string UserUnlocked = "user.unlocked";
    public const string VerificationResent = "user.verification_resent";
    public const string StaffInviteCreated = "staff_invite.created";
    public const string StaffInviteRevoked = "staff_invite.revoked";
    public const string StaffInviteAccepted = "staff_invite.accepted";
    public const string CourseCreated = "course.created";
    public const string CourseUpdated = "course.updated";
    public const string CourseDeleted = "course.deleted";
    public const string CourseInstructorAdded = "course.instructor_added";
    public const string CourseInstructorRemoved = "course.instructor_removed";
    public const string ClassCreated = "class.created";
    public const string ClassUpdated = "class.updated";
    public const string ClassCodeRegenerated = "class.code_regenerated";
    public const string ClassArchived = "class.archived";
    public const string ClassUnarchived = "class.unarchived";
    public const string ClassJoined = "class.joined";
    public const string ClassLeft = "class.left";
    public const string ClassMemberRemoved = "class.member_removed";
    public const string ClassInvitesSent = "class.invites_sent";
    public const string ClassInviteRevoked = "class.invite_revoked";
    public const string ClassInviteResent = "class.invite_resent";
    public const string GuardianConsentRequested = "guardian_consent.requested";
    public const string GuardianConsentGranted = "guardian_consent.granted";
    public const string GuardianConsentDeclined = "guardian_consent.declined";
    public const string GuardianConsentWithdrawn = "guardian_consent.withdrawn";
    public const string MessageCancelled = "message.cancelled";
}

public static class CourseVisibilities
{
    public const string Public = "public";
    public const string Private = "private";
    public static readonly string[] All = [Public, Private];
}

public static class CourseInstructorRoles
{
    public const string Owner = "owner";
    public const string Instructor = "instructor";
    /// <summary>Only reported as InstructorCourse.myRole for Admins without a course_instructors row.</summary>
    public const string Admin = "admin";
}

public static class ClassJoinMethods
{
    public const string Code = "code";
    public const string Invite = "invite";
    public const string Added = "added";
}

/// <summary>Derived status of class and staff invites.</summary>
public static class InviteStatuses
{
    public const string Valid = "valid";
    public const string Pending = "pending";
    public const string Expired = "expired";
    public const string Accepted = "accepted";
    public const string Revoked = "revoked";
}

public static class GuardianConsentStatuses
{
    public const string NotRequired = "not_required";
    public const string Pending = "pending";
    public const string Granted = "granted";
    public const string Declined = "declined";
    public const string Withdrawn = "withdrawn";
    public const string Expired = "expired";
}

public static class AccountStatuses
{
    public const string Active = "active";
    public const string PendingGuardian = "pending_guardian";
    public const string Deleted = "deleted";
    public static readonly string[] All = [Active, PendingGuardian, Deleted];
}
