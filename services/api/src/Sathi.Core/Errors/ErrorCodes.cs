namespace Sathi.Core.Errors;

/// <summary>Stable error codes (contract §4.2).</summary>
public static class ErrorCodes
{
    public const string ValidationFailed = "VALIDATION_FAILED";
    public const string AuthUnauthenticated = "AUTH_UNAUTHENTICATED";
    public const string AuthForbidden = "AUTH_FORBIDDEN";
    public const string AuthInvalidCredentials = "AUTH_INVALID_CREDENTIALS";
    public const string AuthEmailNotConfirmed = "AUTH_EMAIL_NOT_CONFIRMED";
    public const string AuthLockedOut = "AUTH_LOCKED_OUT";
    public const string AuthEmailTaken = "AUTH_EMAIL_TAKEN";
    public const string AuthInvalidToken = "AUTH_INVALID_TOKEN";
    public const string CsrfInvalid = "CSRF_INVALID";
    public const string NotFound = "NOT_FOUND";
    public const string Conflict = "CONFLICT";
    public const string RateLimited = "RATE_LIMITED";
    public const string QuotaExceeded = "QUOTA_EXCEEDED";
    public const string WebSearchQuotaExceeded = "WEB_SEARCH_QUOTA_EXCEEDED";
    public const string UploadInvalidType = "UPLOAD_INVALID_TYPE";
    public const string UploadTooLarge = "UPLOAD_TOO_LARGE";
    public const string LlmTimeout = "LLM_TIMEOUT";
    public const string LlmRateLimited = "LLM_RATE_LIMITED";
    public const string LlmUnavailable = "LLM_UNAVAILABLE";
    public const string LlmRefused = "LLM_REFUSED";
    public const string LlmDisabled = "LLM_DISABLED";
    public const string SpendCapReached = "SPEND_CAP_REACHED";
    public const string AiServiceUnavailable = "AI_SERVICE_UNAVAILABLE";
    public const string RagNoResults = "RAG_NO_RESULTS";
    public const string WebSearchFailed = "WEB_SEARCH_FAILED";
    public const string IngestParseFailed = "INGEST_PARSE_FAILED";
    public const string IngestNoText = "INGEST_NO_TEXT";
    public const string IngestUnsupportedType = "INGEST_UNSUPPORTED_TYPE";
    public const string IngestIndexFailed = "INGEST_INDEX_FAILED";
    public const string GradingLowConfidence = "GRADING_LOW_CONFIDENCE";
    public const string GradingFailed = "GRADING_FAILED";
    public const string QuizGenerationFailed = "QUIZ_GENERATION_FAILED";
    public const string ServiceTokenInvalid = "SERVICE_TOKEN_INVALID";
    public const string InternalError = "INTERNAL_ERROR";

    // ---- Release 2 (contract §11.11) ----
    public const string ClassCodeInvalid = "CLASS_CODE_INVALID";
    public const string ClassJoinDisabled = "CLASS_JOIN_DISABLED";
    public const string ClassInviteEmailMismatch = "CLASS_INVITE_EMAIL_MISMATCH";
    public const string ClassInviteExpired = "CLASS_INVITE_EXPIRED";
    public const string CourseHasStudents = "COURSE_HAS_STUDENTS";
    public const string CourseLastOwner = "COURSE_LAST_OWNER";
    public const string UserNotFound = "USER_NOT_FOUND";
    public const string UserNotInstructor = "USER_NOT_INSTRUCTOR";
    public const string RoleSelfDemotion = "ROLE_SELF_DEMOTION";
    public const string RoleLastAdmin = "ROLE_LAST_ADMIN";
    public const string StaffInviteInvalid = "STAFF_INVITE_INVALID";
    public const string AuthTooYoung = "AUTH_TOO_YOUNG";
    public const string AuthGuardianConsentPending = "AUTH_GUARDIAN_CONSENT_PENDING";
    public const string AuthGuardianConsentDeclined = "AUTH_GUARDIAN_CONSENT_DECLINED";
    /// <summary>Message error code only (never an HTTP status): the stream was still "streaming" after Tutor:StaleStreamMinutes.</summary>
    public const string StreamInterrupted = "STREAM_INTERRUPTED";

    public static string TypeUri(string code) =>
        "https://sathi.app/errors/" + code.ToLowerInvariant().Replace('_', '-');

    public static string DefaultTitle(string code) => code switch
    {
        ValidationFailed => "Some fields need attention",
        AuthUnauthenticated => "Please sign in",
        AuthForbidden => "Not allowed",
        AuthInvalidCredentials => "Wrong email or password",
        AuthEmailNotConfirmed => "Verify your email first",
        AuthLockedOut => "Account temporarily locked",
        AuthEmailTaken => "Email already registered",
        AuthInvalidToken => "Link invalid or expired",
        CsrfInvalid => "Security check failed",
        NotFound => "Not found",
        Conflict => "Conflict",
        RateLimited => "Too many requests",
        QuotaExceeded => "Daily limit reached",
        WebSearchQuotaExceeded => "Daily limit reached",
        UploadInvalidType => "File type not allowed",
        UploadTooLarge => "File too large",
        AiServiceUnavailable => "Tutor temporarily unavailable",
        InternalError => "Something went wrong",
        ClassCodeInvalid => "Class code not recognised",
        ClassJoinDisabled => "Joining is turned off",
        ClassInviteEmailMismatch => "Invitation is for another email",
        ClassInviteExpired => "Invitation expired",
        CourseHasStudents => "Course has students",
        CourseLastOwner => "Course needs an owner",
        UserNotFound => "User not found",
        UserNotInstructor => "Not an instructor",
        RoleSelfDemotion => "Not allowed on your own account",
        RoleLastAdmin => "At least one administrator is required",
        StaffInviteInvalid => "Invitation no longer valid",
        AuthTooYoung => "Too young to register",
        AuthGuardianConsentPending => "Waiting for guardian consent",
        AuthGuardianConsentDeclined => "Guardian consent declined",
        _ => "Request failed",
    };
}
