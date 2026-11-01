/**
 * TypeScript shapes for the public API `/api/v1`.
 * Source of truth: docs/architecture/contracts.md §5, with the Release 2 additions in §11 (which win on conflict).
 * Keep field names identical. Shapes the contract leaves open are marked "ASSUMED" — align them with the API team.
 */

// ---------- §4.1 errors ----------
export interface ProblemDetails {
  type?: string;
  title?: string;
  status?: number;
  detail?: string;
  code?: string;
  traceId?: string;
  referenceId?: string;
  errors?: Record<string, string[]>;
}

// ---------- §5 pagination ----------
export interface Page<T> {
  items: T[];
  nextCursor: string | null;
}

// ---------- §5.1 auth & me ----------
export type Role = 'Student' | 'Instructor' | 'Admin';
export type Level = 'beginner' | 'intermediate' | 'advanced';

export interface Preferences {
  level: Level;
  timezone: string;
  reminderHour: number;
  remindersEnabled: boolean;
  activeCourseId: string | null;
}

export interface Me {
  id: string;
  email: string;
  displayName: string;
  roles: Role[];
  emailConfirmed: boolean;
  preferences: Preferences;
  onboardingCompleted: boolean;
  /** §11.4 */
  isMinor: boolean;
}

/** §5.1 + §11.2 (`staffInviteToken`) + §11.4 (`dateOfBirth`, `guardianEmail`). */
export interface RegisterRequest {
  email: string;
  password: string;
  displayName: string;
  /** YYYY-MM-DD */
  dateOfBirth: string;
  /** Required when the learner is under the age of majority (18); must differ from `email`. */
  guardianEmail?: string;
  staffInviteToken?: string;
}
/** §11.3 */
export interface ProfileUpdate {
  displayName: string;
}
export interface LoginRequest {
  email: string;
  password: string;
  rememberMe: boolean;
}
export type PreferencesUpdate = Partial<Preferences>;

// ---------- §5.2 courses, lessons, home, progress ----------
/** §11.1 */
export type CourseVisibility = 'public' | 'private';

export interface CourseSummary {
  id: string;
  slug: string;
  title: string;
  description: string;
  moduleCount: number;
  lessonCount: number;
  enrolled: boolean;
  diagnosticCompleted: boolean;
  /** §11.1 */
  visibility: CourseVisibility;
  /** §11.1 — the student's classes for this course. */
  classes: { id: string; name: string }[];
}

export type LessonStatus = 'not_started' | 'in_progress' | 'completed';

export interface CourseLessonItem {
  id: string;
  title: string;
  summary: string;
  position: number;
  estimatedMinutes: number;
  status: LessonStatus;
  percent: number;
}
export interface CourseModule {
  id: string;
  title: string;
  summary: string;
  position: number;
  lessons: CourseLessonItem[];
}
export interface Concept {
  id: string;
  slug: string;
  name: string;
  description: string;
}
export interface CourseDetail {
  id: string;
  slug: string;
  title: string;
  description: string;
  modules: CourseModule[];
  concepts: Concept[];
}

export interface Lesson {
  id: string;
  title: string;
  summary: string;
  contentMarkdown: string;
  estimatedMinutes: number;
  position: number;
  lessonCount: number;
  module: { id: string; title: string; position: number };
  course: { id: string; title: string };
  objectives: string[];
  concepts: { id: string; name: string }[];
  progress: { status: LessonStatus; percent: number };
  previousLessonId: string | null;
  nextLessonId: string | null;
}

export interface ConceptMastery {
  conceptId: string;
  name: string;
  mastery: number; // 0..1
  attempts: number;
  needsWork: boolean; // mastery < 0.5
}

export type StudyNextType = 'lesson' | 'concept_practice' | 'quiz' | 'revision';
export interface StudyNextItem {
  type: StudyNextType;
  targetId: string;
  title: string;
  reason: string;
}

export interface ContinueLesson {
  lessonId: string;
  title: string;
  summary: string;
  courseTitle: string;
  moduleTitle: string;
  modulePosition: number;
  lessonPosition: number;
  lessonCount: number;
  percent: number;
}

export interface Home {
  course: { id: string; title: string };
  continueLesson: ContinueLesson | null;
  revision: { dueCount: number; estimatedMinutes: number };
  mastery: ConceptMastery[];
  studyNext: StudyNextItem[];
  streakDays: number;
}

export interface ProgressOverview {
  mastery: ConceptMastery[];
  masteryTrend: { date: string; average: number }[];
  quizzes: { attemptId: string; title: string; completedAt: string; correct: number; total: number }[];
  lessonsCompleted: number;
  lessonCount: number;
  streakDays: number;
  questionsAsked: number;
}

// ---------- §5.3 tutor ----------
export type TutorMode = 'explain' | 'hint' | 'quiz_me';
export type Adjust = 'simpler' | 'harder';
export type SourceType = 'course' | 'upload' | 'web';
export type AnswerBasis = 'course' | 'upload' | 'web' | 'general';
/** §5.3 + §11.5 (`cancelled`). A failed message may carry errorCode `STREAM_INTERRUPTED`. */
export type MessageStatus = 'streaming' | 'complete' | 'partial' | 'failed' | 'cancelled';

export interface ConversationSummary {
  id: string;
  title: string;
  courseId: string;
  lessonId: string | null;
  updatedAt: string;
  lastMessagePreview: string;
}
export interface ConversationCreated {
  id: string;
  title: string;
  courseId: string;
  lessonId: string | null;
  createdAt: string;
}
export interface Citation {
  index: number;
  sourceType: SourceType;
  title: string;
  documentId: string | null;
  lessonId: string | null;
  page: number | null;
  url: string | null;
  snippet: string;
}
export interface Message {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  level: Level;
  mode: TutorMode;
  adjust: Adjust | null;
  webSearch: boolean;
  citations: Citation[];
  answerBasis: AnswerBasis[];
  status: MessageStatus;
  errorCode: string | null;
  referenceId: string | null;
  feedback: 1 | -1 | null;
  createdAt: string;
}
export interface Conversation {
  id: string;
  title: string;
  courseId: string;
  lessonId: string | null;
  lessonTitle: string | null;
  messages: Message[];
}
export interface SendMessageRequest {
  content: string;
  level: Level;
  mode: TutorMode;
  adjust?: Adjust;
  webSearch: boolean;
  replyToMessageId?: string;
}

// §5.3.1 SSE events (browser ← .NET). Every data object includes requestId.
export type TutorStage = 'retrieving' | 'searching_web' | 'reading_sources' | 'generating';
export interface StartEvent {
  conversationId: string;
  userMessageId: string;
  assistantMessageId: string;
  runId: string;
  referenceId: string;
  requestId?: string;
}
export interface StatusEvent {
  stage: TutorStage;
  message: string;
  requestId?: string;
}
export interface TokenEvent {
  text: string;
  requestId?: string;
}
export type CitationEvent = Citation & { requestId?: string };
export interface UsageEvent {
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  model: string;
  ttftMs: number;
  latencyMs: number;
  requestId?: string;
}
export interface ErrorEvent {
  code: string;
  message: string;
  referenceId: string;
  requestId?: string;
}
export interface DoneEvent {
  messageId: string;
  content: string;
  answerBasis: AnswerBasis[];
  citationsValid: number;
  citationsDropped: number;
  warnings: string[];
  /**
   * Release 2 (API behaviour, not yet in contracts.md): a run cancelled server-side ends with
   * `done` carrying `status: 'cancelled'` and `warnings: ['CANCELLED']` — it is a stopped answer, not a complete one.
   */
  status?: MessageStatus;
  requestId?: string;
}
export type TutorEvent =
  | { event: 'start'; data: StartEvent }
  | { event: 'status'; data: StatusEvent }
  | { event: 'token'; data: TokenEvent }
  | { event: 'citation'; data: CitationEvent }
  | { event: 'usage'; data: UsageEvent }
  | { event: 'error'; data: ErrorEvent }
  | { event: 'done'; data: DoneEvent };

// ---------- §5.4 practice, quizzes, diagnostic, revision ----------
export type QuizKind = 'diagnostic' | 'practice' | 'lesson_check' | 'revision';
export interface QuestionOption {
  id: string;
  label: string;
  text: string;
}
export interface AttemptQuestion {
  id: string;
  position: number;
  type: 'mcq' | 'short';
  stem: string;
  conceptId: string;
  conceptName: string;
  options: QuestionOption[];
}
export type GradingStatus = 'pending' | 'auto_accepted' | 'needs_review' | 'reviewed' | 'failed';
export interface MasteryChange {
  conceptId: string;
  name: string;
  before: number;
  after: number;
}
export interface AnswerResult {
  answerId: string;
  questionId: string;
  isCorrect: boolean | null;
  selectedOptionId: string | null;
  correctOptionId: string | null;
  explanation: string;
  mastery: MasteryChange | null;
  grading: {
    status: GradingStatus;
    score: number | null;
    maxScore: number | null;
    feedback: string | null;
  } | null;
}
export interface Attempt {
  attemptId: string;
  quizId: string;
  title: string;
  kind: QuizKind;
  conceptName: string | null;
  questions: AttemptQuestion[];
  answers: AnswerResult[];
  completed: boolean;
}
export interface AnswerRequest {
  questionId: string;
  selectedOptionId?: string;
  freeText?: string;
}
export interface AttemptCompletion {
  attemptId: string;
  correct: number;
  total: number;
  masteryChanges: MasteryChange[];
  studyNext: StudyNextItem[];
}
export interface PracticeSessionRequest {
  courseId: string;
  conceptId?: string;
  lessonId?: string;
  count?: number;
}
export interface RevisionCard {
  cardId: string;
  dueAt: string;
  question: AttemptQuestion;
}
export interface RevisionDue {
  dueCount: number;
  cards: RevisionCard[];
}
export interface RevisionReviewRequest {
  selectedOptionId?: string;
  freeText?: string;
  quality?: number;
}
export interface RevisionReviewResult {
  isCorrect: boolean;
  correctOptionId: string;
  explanation: string;
  nextDueAt: string;
  intervalDays: number;
}
export interface RevisionSchedule {
  days: { date: string; count: number }[];
}

// ---------- §5.5 notes ----------
export type DocumentStatus = 'queued' | 'processing' | 'ready' | 'failed';
export type DocumentStage = 'queued' | 'parsing' | 'indexing' | 'ready' | 'failed';
export interface DocumentItem {
  id: string;
  fileName: string;
  sizeBytes: number;
  contentType: string;
  status: DocumentStatus;
  stage: DocumentStage;
  progressPercent: number;
  passageCount: number | null;
  errorCode: string | null;
  errorMessage: string | null;
  referenceId: string | null;
  createdAt: string;
  updatedAt: string;
}

// ---------- §5.6 instructor ----------
export type CourseRole = 'owner' | 'instructor' | 'admin';
/** §11.1 */
export interface InstructorCourse {
  id: string;
  slug: string;
  title: string;
  description: string;
  isPublished: boolean;
  visibility: CourseVisibility;
  moduleCount: number;
  lessonCount: number;
  conceptCount: number;
  questionCount: number;
  studentCount: number;
  classCount: number;
  myRole: CourseRole;
  /** Present in the API's OpenAPI document (not in contracts.md); unused by the UI. */
  createdAt?: string;
  updatedAt?: string;
}
export interface CourseUpsert {
  title: string;
  slug: string;
  description: string;
  isPublished: boolean;
  visibility: CourseVisibility;
}
/** §11.1 GET /instructor/courses/{id}/instructors */
export interface CourseInstructor {
  userId: string;
  displayName: string;
  email: string;
  role: 'owner' | 'instructor';
  addedAt: string;
}

// ---------- §11.1 classes ----------
export interface ClassSummary {
  id: string;
  courseId: string;
  name: string;
  description: string | null;
  /** 8 characters without the dash; displayed `XXXX-XXXX`. */
  joinCode: string;
  joinEnabled: boolean;
  memberCount: number;
  pendingInvites: number;
  createdAt: string;
  archivedAt: string | null;
}
export interface ClassCreate {
  name: string;
  description?: string;
}
export interface ClassUpdate {
  name: string;
  description: string | null;
  joinEnabled: boolean;
}
export type JoinedVia = 'code' | 'invite' | 'added';
export interface ClassMember {
  userId: string;
  displayName: string;
  email: string;
  joinedAt: string;
  joinedVia: JoinedVia;
  lastActiveAt: string | null;
  averageMastery: number | null;
}
export interface ClassInviteResult {
  invited: number;
  alreadyMembers: string[];
  invalid: string[];
}
/** ASSUMED status values for GET /instructor/classes/{id}/invites (mirrors the invite columns). */
export type ClassInviteStatus = 'pending' | 'accepted' | 'expired' | 'revoked';
export interface ClassInvite {
  id: string;
  email: string;
  createdAt: string;
  expiresAt: string;
  status: ClassInviteStatus;
}
/** POST /classes/join and POST /classes/invites/{token}/accept */
export interface JoinClassResult {
  classId: string;
  className: string;
  course: CourseSummary;
}
/** GET /classes/invites/{token} (anonymous) */
export interface ClassInvitePreview {
  className: string;
  courseTitle: string;
  instructorName: string;
  emailMasked: string;
  status: 'valid' | 'expired' | 'accepted' | 'revoked';
}
/** GET /me/classes */
export interface MyClass {
  classId: string;
  name: string;
  course: { id: string; title: string };
  joinedAt: string;
}
export interface ModuleUpsert {
  title: string;
  summary: string;
  position: number;
}
export interface LessonUpsert {
  title: string;
  summary: string;
  contentMarkdown: string;
  estimatedMinutes: number;
  position: number;
  conceptIds: string[];
  objectives: string[];
}
export interface ConceptUpsert {
  name: string;
  slug: string;
  description: string;
  prerequisiteIds: string[];
}
export type QuestionStatus = 'draft' | 'published' | 'archived';
export interface RubricCriterion {
  id: string;
  description: string;
  points: number;
}
export interface Rubric {
  criteria: RubricCriterion[];
  modelAnswer: string;
}
/** ASSUMED item shape for GET /instructor/questions ("list with options/rubric"). */
export interface InstructorQuestion {
  id: string;
  courseId: string;
  conceptId: string;
  conceptName: string;
  lessonId: string | null;
  type: 'mcq' | 'short';
  stem: string;
  explanation: string;
  difficulty: number;
  source: 'seed' | 'generated' | 'instructor';
  status: QuestionStatus;
  isDiagnostic: boolean;
  options: { id?: string; label: string; text: string; isCorrect: boolean }[];
  rubric: Rubric | null;
  updatedAt: string;
}
export interface QuestionUpsert {
  conceptId: string;
  lessonId?: string | null;
  type: 'mcq' | 'short';
  stem: string;
  explanation: string;
  difficulty: number;
  status: QuestionStatus;
  isDiagnostic: boolean;
  options: { label: string; text: string; isCorrect: boolean }[];
  rubric?: Rubric | null;
}
export interface GenerateQuestionsRequest {
  courseId: string;
  conceptId: string;
  count: number;
  difficulty: number;
}
export interface GenerateQuestionsAccepted {
  runId: string;
  referenceId: string;
}
export interface GradingQueueItem {
  gradingId: string;
  studentDisplayName: string;
  questionStem: string;
  answerText: string;
  aiScore: number;
  maxScore: number;
  confidence: number;
  aiFeedback: string;
  rubric: Rubric;
  submittedAt: string;
}
export interface GradingReview {
  finalScore: number;
  feedback: string;
}
export interface ClassInsights {
  enrolled: number;
  activeLast7Days: number;
  questionsAsked7Days: number;
  helpfulRate: number | null;
  conceptMastery: { conceptId: string; name: string; averageMastery: number; studentsBelowHalf: number }[];
  pendingReviews: number;
}

// ---------- §5.7 admin ----------
export type RunType = 'chat' | 'ingestion' | 'quiz_generation' | 'grading' | 'revision_plan' | 'evaluation';
export type RunStatus = 'running' | 'succeeded' | 'failed' | 'cancelled';
/** ASSUMED: AiRunSummary is not spelled out; mirrors `ai_runs` columns. */
export interface AiRunSummary {
  id: string;
  traceId: string;
  referenceId: string;
  type: RunType;
  status: RunStatus;
  startedAt: string;
  finishedAt: string | null;
  model: string | null;
  latencyMs: number | null;
  errorCode: string | null;
}
export interface AiRunStep {
  step: string;
  startedAt: string;
  endedAt: string;
  outcome: 'ok' | 'empty' | 'failed' | 'skipped';
  metrics: Record<string, unknown>;
}
export interface AiRunDetail {
  run: {
    id: string;
    traceId: string;
    referenceId: string;
    type: RunType;
    status: RunStatus;
    startedAt: string;
    finishedAt: string | null;
    model: string | null;
    provider: string | null;
    promptHash: string | null;
    inputTokens: number | null;
    outputTokens: number | null;
    estimatedCostUsd: number | null;
    ttftMs: number | null;
    latencyMs: number | null;
    errorCode: string | null;
    errorMessage: string | null;
    hangfireJobId: string | null;
    conversationId: string | null;
    documentId: string | null;
    userIdHash: string | null;
  };
  steps: AiRunStep[];
  ingestionJob: {
    id: string;
    documentId: string;
    status: string;
    stage: string;
    attempt: number;
    errorCode: string | null;
    errorMessage: string | null;
    hangfireJobId: string | null;
  } | null;
  aiService: InternalRunDetail | null;
  links: { grafanaLogs: string; grafanaTrace: string; hangfireJob: string | null };
}
/** ASSUMED field subsets of ai.model_runs / retrieval_runs / search_runs (§3.2). */
export interface InternalRunDetail {
  modelRuns: {
    purpose: string;
    provider: string;
    model: string;
    promptName: string;
    promptVersion: string;
    inputTokens: number;
    outputTokens: number;
    estimatedCostUsd: number;
    ttftMs: number | null;
    latencyMs: number;
    retries: number;
    finishReason: string;
    errorCode: string | null;
    fallbackUsed: boolean;
  }[];
  retrievalRuns: {
    method: string;
    topK: number;
    resultCount: number;
    empty: boolean;
    timings: Record<string, number>;
    sources: { rank: number; sourceType: SourceType; title: string; url: string | null; score: number; cited: boolean }[];
  }[];
  searchRuns: {
    provider: string;
    resultCount: number;
    urls: string[];
    latencyMs: number;
    cacheHit: boolean;
    outcome: string;
    errorCode: string | null;
  }[];
}
export interface UsageSummary {
  days: {
    date: string;
    chatMessages: number;
    webSearches: number;
    uploads: number;
    inputTokens: number;
    outputTokens: number;
    costUsd: number;
  }[];
  activeUsers: number;
}

// ---------- §11.2 roles, staff invites, user administration ----------
export type AccountStatus = 'active' | 'pending_guardian' | 'deleted';
export interface AdminUser {
  id: string;
  email: string;
  displayName: string;
  roles: Role[];
  emailConfirmed: boolean;
  lockedOut: boolean;
  accountStatus: AccountStatus;
  isMinor: boolean;
  createdAt: string;
  lastActiveAt: string | null;
}
export interface AdminUserDetail extends AdminUser {
  courses: { id: string; title: string; role: string }[];
  classes: { id: string; name: string; courseTitle: string }[];
}
export type StaffRole = 'Instructor' | 'Admin';
export interface StaffInviteCreate {
  email: string;
  role: StaffRole;
  courseId?: string;
}
export interface StaffInviteCreated {
  id: string;
  email: string;
  role: StaffRole;
  courseId: string | null;
  expiresAt: string;
}
/** ASSUMED status values (mirrors the staff_invites columns). */
export type StaffInviteStatus = 'pending' | 'accepted' | 'expired' | 'revoked';
export interface StaffInvite {
  id: string;
  email: string;
  role: StaffRole;
  courseTitle: string | null;
  createdAt: string;
  expiresAt: string;
  status: StaffInviteStatus;
}
/** GET /auth/staff-invites/{token} (anonymous). ASSUMED status values as for StaffInvite. */
export interface StaffInvitePreview {
  emailMasked: string;
  role: StaffRole;
  courseTitle: string | null;
  status: StaffInviteStatus;
}

// ---------- §11.4 guardian consent ----------
export type ConsentStatus = 'pending' | 'granted' | 'declined' | 'withdrawn' | 'expired';
export interface GuardianConsentInfo {
  learnerDisplayName: string;
  learnerEmailMasked: string;
  policyVersion: string;
  dataWeProcess: string[];
  status: ConsentStatus;
}
export type GuardianDecision = 'granted' | 'declined' | 'withdrawn';

// ---------- §5.8 client errors ----------
export interface ClientErrorReport {
  kind: 'unhandled' | 'http' | 'sse_drop';
  message: string;
  traceId?: string;
  route: string;
  appVersion: string;
  userAgent: string;
  status?: number;
  url?: string;
}
