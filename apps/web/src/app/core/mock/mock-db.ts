/* Mock-only in-memory database, persisted to sessionStorage so reloads keep state. */
import {
  AiRunDetail,
  AiRunSummary,
  AnswerResult,
  Attempt,
  AttemptCompletion,
  AttemptQuestion,
  Citation,
  ConceptMastery,
  ClassSummary,
  CourseDetail,
  CourseSummary,
  CourseVisibility,
  DocumentItem,
  GradingQueueItem,
  Home,
  InstructorQuestion,
  Lesson,
  LessonStatus,
  Me,
  Message,
  Preferences,
  ProgressOverview,
  QuizKind,
  Role,
  StudyNextItem,
} from '../models/api.models';
import { COURSE_ID, CONCEPTS, MODULES, QUESTIONS, SeedConcept } from './mock-content';

const STORAGE_KEY = 'sathi.mock.db.v4';
const SESSION_KEY = 'sathi.mock.session';
export const LAST_VERIFY_LINK_KEY = 'sathi.mock.lastVerifyLink';
export const LAST_CONSENT_LINK_KEY = 'sathi.mock.lastConsentLink';
export const LAST_STAFF_INVITE_LINK_KEY = 'sathi.mock.lastStaffInviteLink';
export const LAST_CLASS_INVITE_LINK_KEY = 'sathi.mock.lastClassInviteLink';
export const JOIN_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export const DAY_MS = 86_400_000;

const DAY = 86_400_000;
const iso = (t: number) => new Date(t).toISOString();
const now = () => Date.now();
export const uid = () => globalThis.crypto.randomUUID();
export const hex = (n: number) => Array.from(globalThis.crypto.getRandomValues(new Uint8Array(n)), (b) => b.toString(16).padStart(2, '0')).join('');
export const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

export type ConsentState = 'not_required' | 'pending' | 'granted' | 'declined' | 'withdrawn';
export interface MockUser {
  id: string;
  email: string;
  displayName: string;
  roles: Role[];
  emailConfirmed: boolean;
  prefs: Preferences;
  onboardingCompletedAt: string | null;
  streakDays: number;
  deleted?: boolean;
  dateOfBirth?: string | null;
  isMinor?: boolean;
  guardianEmail?: string | null;
  consentStatus?: ConsentState;
  /** ISO time; far future = locked until unlocked. */
  lockedUntil?: string | null;
  createdAt?: string;
  lastActiveAt?: string | null;
}
interface MockLesson {
  id: string;
  moduleId: string;
  title: string;
  summary: string;
  contentMarkdown: string;
  estimatedMinutes: number;
  position: number;
  conceptIds: string[];
  objectives: string[];
}
interface MockModule {
  id: string;
  courseId: string;
  title: string;
  summary: string;
  position: number;
}
export interface MockCourse {
  id: string;
  slug: string;
  title: string;
  description: string;
  isPublished: boolean;
  visibility: CourseVisibility;
}
export interface MockClass {
  id: string;
  courseId: string;
  name: string;
  description: string | null;
  joinCode: string;
  joinEnabled: boolean;
  createdBy: string;
  createdAt: string;
  archivedAt: string | null;
}
export interface MockMember {
  classId: string;
  userId: string;
  joinedAt: string;
  joinedVia: 'code' | 'invite' | 'added';
  removedAt: string | null;
}
export interface MockInvite {
  id: string;
  classId: string;
  email: string;
  token: string;
  invitedBy: string;
  createdAt: string;
  expiresAt: string;
  acceptedAt: string | null;
  revokedAt: string | null;
}
export interface MockStaffInvite {
  id: string;
  email: string;
  role: 'Instructor' | 'Admin';
  courseId: string | null;
  token: string;
  invitedBy: string;
  createdAt: string;
  expiresAt: string;
  acceptedAt: string | null;
  revokedAt: string | null;
}
export interface MockConsent {
  id: string;
  userId: string;
  guardianEmail: string;
  token: string;
  requestedAt: string;
  expiresAt: string;
  decidedAt: string | null;
  decision: 'granted' | 'declined' | 'withdrawn' | null;
}
interface MockAttempt {
  id: string;
  quizId: string;
  userId: string;
  title: string;
  kind: QuizKind;
  conceptName: string | null;
  questionIds: string[];
  answers: (AnswerResult & { freeText?: string; polls?: number })[];
  completed: boolean;
  startedAt: string;
  completedAt: string | null;
  courseId: string;
}
interface MockCard {
  id: string;
  userId: string;
  questionId: string;
  conceptId: string;
  ef: number;
  interval: number;
  reps: number;
  dueAt: string;
}
export interface MockDoc extends DocumentItem {
  ownerId: string;
  polls: number;
  failAt: 'parsing' | null;
}
interface MockGrading {
  id: string;
  attemptId: string;
  answerId: string;
  userId: string;
  studentDisplayName: string;
  questionId: string;
  answerText: string;
  aiScore: number;
  maxScore: number;
  confidence: number;
  aiFeedback: string;
  status: 'needs_review' | 'reviewed';
  submittedAt: string;
}
export interface MockConversation {
  id: string;
  userId: string;
  courseId: string;
  lessonId: string | null;
  title: string;
  createdAt: string;
  updatedAt: string;
  messages: Message[];
}

export interface DbState {
  users: MockUser[];
  courses: MockCourse[];
  modules: MockModule[];
  lessons: MockLesson[];
  concepts: (SeedConcept & { courseId: string; prerequisiteIds: string[] })[];
  questions: InstructorQuestion[];
  enrollments: { userId: string; courseId: string; enrolledAt: string; diagnosticCompletedAt: string | null; currentLessonId: string | null }[];
  progress: { userId: string; lessonId: string; status: LessonStatus; percent: number }[];
  mastery: { userId: string; conceptId: string; mastery: number; attempts: number; correct: number; misses: number; lastPracticedAt: string }[];
  trend: { userId: string; date: string; average: number }[];
  attempts: MockAttempt[];
  cards: MockCard[];
  docs: MockDoc[];
  gradings: MockGrading[];
  conversations: MockConversation[];
  runs: AiRunDetail[];
  questionsAsked: Record<string, number>;
  courseInstructors: { courseId: string; userId: string; role: 'owner' | 'instructor'; addedAt: string }[];
  classes: MockClass[];
  members: MockMember[];
  invites: MockInvite[];
  staffInvites: MockStaffInvite[];
  consents: MockConsent[];
}

// ---------------------------------------------------------------- seed
function seed(): DbState {
  const t = now();
  const users: MockUser[] = [
    { id: 'usr-asha', email: 'asha@sathi.dev', displayName: 'Asha Verma', roles: ['Student'], emailConfirmed: true, onboardingCompletedAt: iso(t - 20 * DAY), streakDays: 4, prefs: { level: 'intermediate', timezone: 'Asia/Kolkata', reminderHour: 18, remindersEnabled: true, activeCourseId: COURSE_ID } },
    { id: 'usr-new', email: 'new@sathi.dev', displayName: 'Rohan Mehta', roles: ['Student'], emailConfirmed: true, onboardingCompletedAt: null, streakDays: 0, prefs: { level: 'beginner', timezone: 'Asia/Kolkata', reminderHour: 18, remindersEnabled: true, activeCourseId: null } },
    { id: 'usr-meera', email: 'instructor@sathi.dev', displayName: 'Meera Iyer', roles: ['Student', 'Instructor'], emailConfirmed: true, onboardingCompletedAt: iso(t - 60 * DAY), streakDays: 12, prefs: { level: 'advanced', timezone: 'Asia/Kolkata', reminderHour: 9, remindersEnabled: false, activeCourseId: COURSE_ID } },
    { id: 'usr-kabir', email: 'admin@sathi.dev', displayName: 'Kabir Rao', roles: ['Student', 'Instructor', 'Admin'], emailConfirmed: true, onboardingCompletedAt: iso(t - 90 * DAY), streakDays: 2, prefs: { level: 'advanced', timezone: 'Asia/Kolkata', reminderHour: 20, remindersEnabled: false, activeCourseId: COURSE_ID } },
  ];
  users.push(
    { id: 'usr-dev', email: 'instructor2@sathi.dev', displayName: 'Dev Kapoor', roles: ['Student', 'Instructor'], emailConfirmed: true, onboardingCompletedAt: iso(t - 40 * DAY), streakDays: 0, prefs: { level: 'advanced', timezone: 'Asia/Kolkata', reminderHour: 9, remindersEnabled: false, activeCourseId: null } },
    { id: 'usr-tara', email: 'tara@sathi.dev', displayName: 'Tara Singh', roles: ['Student'], emailConfirmed: true, onboardingCompletedAt: null, streakDays: 0, dateOfBirth: '2012-03-14', isMinor: true, guardianEmail: 'parent.singh@example.com', consentStatus: 'pending', prefs: { level: 'beginner', timezone: 'Asia/Kolkata', reminderHour: 18, remindersEnabled: true, activeCourseId: null } },
  );
  const extraNames = ['Rahul Nair', 'Priya Shah', 'Ishaan Gupta', 'Neha Kulkarni', 'Arjun Reddy', 'Kavya Menon', 'Vikram Joshi', 'Sneha Patil', 'Aditya Banerjee', 'Pooja Desai', 'Karan Malhotra', 'Ananya Pillai', 'Rohit Chauhan', 'Divya Krishnan', 'Siddharth Bose', 'Meghna Rao', 'Nikhil Saxena', 'Riya Kapoor', 'Varun Sethi', 'Aisha Khan', 'Manish Tiwari', 'Lakshmi Iyer', 'Harsh Vardhan', 'Zoya Mirza'];
  extraNames.forEach((name, i) => {
    const handle = name.split(' ')[0].toLowerCase();
    users.push({ id: `usr-${handle}`, email: `${handle}@example.in`, displayName: name, roles: ['Student'], emailConfirmed: i % 9 !== 4, onboardingCompletedAt: iso(t - (10 + i) * DAY), streakDays: i % 5, lockedUntil: i === 7 ? iso(t + 10 * 60_000) : null, prefs: { level: 'intermediate', timezone: 'Asia/Kolkata', reminderHour: 18, remindersEnabled: true, activeCourseId: COURSE_ID } });
  });
  users.forEach((u, i) => {
    u.createdAt ??= iso(t - (120 - i * 3) * DAY);
    u.lastActiveAt ??= iso(t - (i % 6) * DAY - i * 3_600_000);
    u.consentStatus ??= 'not_required';
    u.isMinor ??= false;
  });
  const courses: MockCourse[] = [
    { id: COURSE_ID, slug: 'ai-engineering', title: 'AI Engineering', description: 'From gradient descent to retrieval-augmented generation — the maths, the code and the production habits.', isPublished: true, visibility: 'public' },
    { id: 'crs-python', slug: 'python-for-ai', title: 'Python for AI', description: 'NumPy, pandas and the Python habits you need before training models.', isPublished: true, visibility: 'public' },
    { id: 'crs-stats', slug: 'probability-statistics', title: 'Probability & Statistics', description: 'Distributions, estimation and the statistics behind evaluation.', isPublished: true, visibility: 'public' },
    { id: 'crs-dl-lab', slug: 'deep-learning-lab', title: 'Deep Learning Lab', description: 'A hands-on lab for the Thursday group: build, train and debug small networks.', isPublished: true, visibility: 'private' },
  ];
  const modules: MockModule[] = [];
  const lessons: MockLesson[] = [];
  MODULES.forEach((m, mi) => {
    modules.push({ id: m.id, courseId: COURSE_ID, title: m.title, summary: m.summary, position: mi + 1 });
    m.lessons.forEach((l, li) =>
      lessons.push({ id: l.id, moduleId: m.id, title: l.title, summary: l.summary, contentMarkdown: l.markdown ?? '', estimatedMinutes: l.minutes, position: li + 1, conceptIds: l.concepts, objectives: l.objectives }),
    );
  });
  // Minimal content for the two extra courses.
  for (const c of courses.slice(1)) {
    const modId = `mod-${c.slug}`;
    modules.push({ id: modId, courseId: c.id, title: 'Getting started', summary: 'First steps.', position: 1 });
    lessons.push({ id: `les-${c.slug}-1`, moduleId: modId, title: 'Welcome', summary: `An overview of ${c.title}.`, contentMarkdown: `Welcome to **${c.title}**.`, estimatedMinutes: 5, position: 1, conceptIds: [], objectives: ['Know what this course covers'] });
  }
  const concepts = CONCEPTS.map((c) => ({ ...c, courseId: COURSE_ID, prerequisiteIds: [] as string[] }));
  const questions: InstructorQuestion[] = QUESTIONS.map((q) => ({
    id: q.id,
    courseId: COURSE_ID,
    conceptId: q.concept,
    conceptName: CONCEPTS.find((c) => c.id === q.concept)?.name ?? '',
    lessonId: q.lesson ?? null,
    type: q.type,
    stem: q.stem,
    explanation: q.explanation,
    difficulty: q.difficulty,
    source: 'seed',
    status: 'published',
    isDiagnostic: !!q.diagnostic,
    options: (q.options ?? []).map((text, i) => ({ id: `${q.id}-o${i}`, label: 'ABCD'[i], text, isCorrect: i === q.correct })),
    rubric: q.rubric ?? null,
    updatedAt: iso(t - 30 * DAY),
  }));
  questions.push({
    id: 'q-draft-1', courseId: COURSE_ID, conceptId: 'cpt-attn', conceptName: 'Attention', lessonId: null, type: 'mcq',
    stem: 'What does a single attention head output for each token?', explanation: 'A weighted average of value vectors.', difficulty: 0.5, source: 'generated', status: 'draft', isDiagnostic: false,
    options: [ { id: 'qd1-a', label: 'A', text: 'A weighted average of value vectors', isCorrect: true }, { id: 'qd1-b', label: 'B', text: 'The largest key', isCorrect: false }, { id: 'qd1-c', label: 'C', text: 'A one-hot vector', isCorrect: false }, { id: 'qd1-d', label: 'D', text: 'The query itself', isCorrect: false } ],
    rubric: null, updatedAt: iso(t - DAY),
  });

  const enrollments: DbState['enrollments'] = ['usr-asha', 'usr-meera', 'usr-kabir'].map((u) => ({ userId: u, courseId: COURSE_ID, enrolledAt: iso(t - 30 * DAY), diagnosticCompletedAt: iso(t - 30 * DAY), currentLessonId: 'les-attention' }));
  const progress: DbState['progress'] = [];
  const done = ['les-linalg', 'les-loss', 'les-gd', 'les-perceptron', 'les-backprop', 'les-optim', 'les-embeddings', 'les-attn-basics', 'les-qkv'];
  for (const id of done) progress.push({ userId: 'usr-asha', lessonId: id, status: 'completed', percent: 100 });
  progress.push({ userId: 'usr-asha', lessonId: 'les-attention', status: 'in_progress', percent: 57 });

  const m = (conceptId: string, mastery: number, attempts: number, correct: number, misses: number) => ({ userId: 'usr-asha', conceptId, mastery, attempts, correct, misses, lastPracticedAt: iso(t - 2 * DAY) });
  const mastery: DbState['mastery'] = [m('cpt-gd', 0.82, 9, 8, 0), m('cpt-loss', 0.74, 6, 5, 1), m('cpt-emb', 0.68, 5, 4, 1), m('cpt-softmax', 0.55, 4, 2, 1), m('cpt-backprop', 0.42, 7, 3, 3), m('cpt-attn', 0.35, 3, 1, 2)];
  const trendVals = [0.34, 0.37, 0.39, 0.41, 0.44, 0.47, 0.5, 0.53, 0.55, 0.59];
  const trend = trendVals.map((average, i) => ({ userId: 'usr-asha', date: iso(t - (trendVals.length - i) * 2 * DAY).slice(0, 10), average }));

  const cards: MockCard[] = ['q-bp-1', 'q-at-1', 'q-sm-1', 'q-bp-2', 'q-at-2'].map((qid, i) => ({
    id: `card-${i + 1}`, userId: 'usr-asha', questionId: qid, conceptId: questions.find((q) => q.id === qid)!.conceptId, ef: 2.5, interval: 1, reps: 1, dueAt: iso(t - (i + 1) * 3_600_000),
  }));
  ['q-gd-1', 'q-emb-1', 'q-loss-1', 'q-gd-2', 'q-tr-1', 'q-rag-1', 'q-emb-2', 'q-loss-2'].forEach((qid, i) =>
    cards.push({ id: `card-f${i}`, userId: 'usr-asha', questionId: qid, conceptId: questions.find((q) => q.id === qid)!.conceptId, ef: 2.5, interval: 3, reps: 2, dueAt: iso(t + [1, 1, 2, 3, 3, 5, 8, 11][i] * DAY) }),
  );

  const docs: MockDoc[] = [
    { id: 'doc-lecture3', ownerId: 'usr-asha', fileName: 'Lecture 3 notes.pdf', sizeBytes: 2_480_000, contentType: 'application/pdf', status: 'ready', stage: 'ready', progressPercent: 100, passageCount: 42, errorCode: null, errorMessage: null, referenceId: null, createdAt: iso(t - 5 * DAY), updatedAt: iso(t - 5 * DAY), polls: 0, failAt: null },
    { id: 'doc-cheatsheet', ownerId: 'usr-asha', fileName: 'Backprop cheatsheet.md', sizeBytes: 18_400, contentType: 'text/markdown', status: 'processing', stage: 'indexing', progressPercent: 70, passageCount: null, errorCode: null, errorMessage: null, referenceId: null, createdAt: iso(t - 60_000), updatedAt: iso(t - 30_000), polls: 0, failAt: null },
    { id: 'doc-scanned', ownerId: 'usr-asha', fileName: 'Scanned handout.pdf', sizeBytes: 5_120_000, contentType: 'application/pdf', status: 'failed', stage: 'failed', progressPercent: 30, passageCount: null, errorCode: 'INGEST_NO_TEXT', errorMessage: 'No selectable text found.', referenceId: '7F3A-91C2', createdAt: iso(t - 3_600_000), updatedAt: iso(t - 3_500_000), polls: 0, failAt: null },
  ];

  const gradings: MockGrading[] = [
    { id: 'grd-1', attemptId: 'att-x1', answerId: 'ans-x1', userId: 'usr-asha', studentDisplayName: 'Asha Verma', questionId: 'q-bp-5', answerText: 'Because the error is known at the end, so we start there and use the chain rule to push it back to each earlier weight.', aiScore: 2, maxScore: 4, confidence: 0.58, aiFeedback: 'Mentions the chain rule and that the loss is at the output. Does not explain reuse of intermediate gradients.', status: 'needs_review', submittedAt: iso(t - 3 * 3_600_000) },
    { id: 'grd-2', attemptId: 'att-x2', answerId: 'ans-x2', userId: 'usr-rahul', studentDisplayName: 'Rahul Nair', questionId: 'q-at-4', answerText: 'It mixes the values using weights from softmax of q·k.', aiScore: 3, maxScore: 4, confidence: 0.66, aiFeedback: 'Correct core idea, terse. Weighted average and softmax of query–key scores both present.', status: 'needs_review', submittedAt: iso(t - 5 * 3_600_000) },
    { id: 'grd-3', attemptId: 'att-x3', answerId: 'ans-x3', userId: 'usr-priya', studentDisplayName: 'Priya Shah', questionId: 'q-bp-5', answerText: 'Backprop goes backwards because thats how the network was built.', aiScore: 0.5, maxScore: 4, confidence: 0.41, aiFeedback: 'Does not mention the chain rule or the loss. The reasoning is circular.', status: 'needs_review', submittedAt: iso(t - 26 * 3_600_000) },
  ];

  const cites = (withWeb: boolean): Citation[] => {
    const c: Citation[] = [
      { index: 1, sourceType: 'upload', title: 'Lecture 3 notes.pdf', documentId: 'doc-lecture3', lessonId: null, page: 12, url: null, snippet: 'Scaling by the square root of the key dimension keeps the dot products from growing with d, which keeps softmax away from saturation.' },
      { index: 2, sourceType: 'course', title: 'Attention basics', documentId: null, lessonId: 'les-attn-basics', page: null, url: null, snippet: 'If q and k have independent components with variance 1, then q·k has variance d_k.' },
    ];
    if (withWeb) c.push({ index: 3, sourceType: 'web', title: 'Attention Is All You Need', documentId: null, lessonId: null, page: null, url: 'https://arxiv.org/abs/1706.03762', snippet: 'We suspect that for large values of d_k, the dot products grow large in magnitude, pushing the softmax function into regions where it has extremely small gradients.' });
    return c;
  };
  const msg = (role: 'user' | 'assistant', content: string, extra: Partial<Message> = {}): Message => ({
    id: uid(), role, content, level: 'intermediate', mode: 'explain', adjust: null, webSearch: false, citations: [], answerBasis: [], status: 'complete', errorCode: null, referenceId: null, feedback: null, createdAt: iso(t - 2 * DAY), ...extra,
  });
  const conversations: MockConversation[] = [
    {
      id: 'conv-sqrt', userId: 'usr-asha', courseId: COURSE_ID, lessonId: 'les-attention', title: 'Why divide by √d in attention?', createdAt: iso(t - 2 * DAY), updatedAt: iso(t - 2 * DAY),
      messages: [
        msg('user', 'Why do we divide by the square root of d in attention?'),
        msg('assistant', 'Dot products grow as vectors get longer, which pushes softmax toward one-hot outputs and tiny gradients. Dividing by $\\sqrt{d_k}$ keeps the scores in a stable range [1].\n\nTry it: if each entry has variance 1, what is the variance of a dot product of length $d$? [2]', { citations: cites(false), answerBasis: ['upload', 'course'], feedback: 1 }),
      ],
    },
    {
      id: 'conv-chain', userId: 'usr-asha', courseId: COURSE_ID, lessonId: 'les-backprop', title: 'Chain rule intuition', createdAt: iso(t - 4 * DAY), updatedAt: iso(t - 4 * DAY),
      messages: [msg('user', 'Can you give me an intuition for the chain rule?'), msg('assistant', 'Think of gears: if gear A turns gear B twice as fast, and B turns C three times as fast, then A turns C $2 \\times 3 = 6$ times as fast. Derivatives multiply along a chain the same way [1].', { citations: [{ index: 1, sourceType: 'course', title: 'Backpropagation', documentId: null, lessonId: 'les-backprop', page: null, url: null, snippet: 'If y = f(g(x)), then dy/dx = dy/dg · dg/dx.' }], answerBasis: ['course'] })],
    },
    {
      id: 'conv-rrf', userId: 'usr-asha', courseId: COURSE_ID, lessonId: null, title: 'What is reciprocal rank fusion?', createdAt: iso(t - 7 * DAY), updatedAt: iso(t - 7 * DAY),
      messages: [msg('user', 'What is reciprocal rank fusion?', { webSearch: true }), msg('assistant', 'Reciprocal Rank Fusion merges several ranked lists by summing $\\frac{1}{k + \\text{rank}}$ for each document [1]. The constant $k = 60$ comes from the original paper [2].', { webSearch: true, citations: [{ index: 1, sourceType: 'course', title: 'Hybrid search and RRF', documentId: null, lessonId: 'les-hybrid', page: null, url: null, snippet: 'RRF score = Σ 1/(k + rank_i).' }, { index: 2, sourceType: 'web', title: 'Reciprocal Rank Fusion outperforms Condorcet', documentId: null, lessonId: null, page: null, url: 'https://plg.uwaterloo.ca/~gvcormac/cormacksigir09-rrf.pdf', snippet: 'k = 60 was fixed during a pilot investigation and not altered.' }], answerBasis: ['course', 'web'] })],
    },
  ];

  const runs: AiRunDetail[] = [];
  runs.push(makeIngestionFailureRun('7F3A91C2' + hex(12), 'doc-scanned', t - 3_500_000));
  const types: AiRunSummary['type'][] = ['chat', 'chat', 'ingestion', 'grading', 'chat', 'quiz_generation', 'chat', 'chat', 'grading', 'chat', 'ingestion'];
  types.forEach((type, i) => {
    const failed = i === 1 || i === 6;
    runs.push(makeRun(type, failed ? (type === 'chat' ? 'LLM_TIMEOUT' : 'GRADING_FAILED') : null, t - (i + 1) * 47 * 60_000));
  });

  // ---- Release 2: co-instructors, classes, invites, staff invites, guardian consent
  const courseInstructors: DbState['courseInstructors'] = [
    { courseId: COURSE_ID, userId: 'usr-meera', role: 'owner', addedAt: iso(t - 200 * DAY) },
    { courseId: 'crs-python', userId: 'usr-meera', role: 'owner', addedAt: iso(t - 150 * DAY) },
    { courseId: 'crs-dl-lab', userId: 'usr-meera', role: 'owner', addedAt: iso(t - 30 * DAY) },
    { courseId: 'crs-stats', userId: 'usr-kabir', role: 'owner', addedAt: iso(t - 150 * DAY) },
    { courseId: 'crs-stats', userId: 'usr-dev', role: 'instructor', addedAt: iso(t - 60 * DAY) },
  ];
  const classes: MockClass[] = [
    { id: 'cls-monday', courseId: COURSE_ID, name: 'Monday cohort', description: 'Evening batch, Mondays 6–8 pm.', joinCode: 'MNDYCHRT', joinEnabled: true, createdBy: 'usr-meera', createdAt: iso(t - 45 * DAY), archivedAt: null },
    { id: 'cls-weekend', courseId: COURSE_ID, name: 'Weekend batch', description: null, joinCode: 'WKNDB4TC', joinEnabled: false, createdBy: 'usr-meera', createdAt: iso(t - 35 * DAY), archivedAt: null },
    { id: 'cls-spring', courseId: COURSE_ID, name: 'Spring 2026 cohort', description: 'Finished in April.', joinCode: 'SPRNG26X', joinEnabled: false, createdBy: 'usr-meera', createdAt: iso(t - 220 * DAY), archivedAt: iso(t - 120 * DAY) },
    { id: 'cls-lab-a', courseId: 'crs-dl-lab', name: 'Lab group A', description: 'Thursday lab, room 204.', joinCode: 'DEEPLAB7', joinEnabled: true, createdBy: 'usr-meera', createdAt: iso(t - 20 * DAY), archivedAt: null },
  ];
  const members: MockMember[] = [{ classId: 'cls-monday', userId: 'usr-asha', joinedAt: iso(t - 30 * DAY), joinedVia: 'code', removedAt: null }];
  extraNames.forEach((name, i) => {
    const userId = `usr-${name.split(' ')[0].toLowerCase()}`;
    const classId = i < 12 ? 'cls-monday' : i < 19 ? 'cls-weekend' : 'cls-lab-a';
    members.push({ classId, userId, joinedAt: iso(t - (28 - i) * DAY), joinedVia: i % 4 === 0 ? 'invite' : 'code', removedAt: null });
    enrollments.push({ userId, courseId: classId === 'cls-lab-a' ? 'crs-dl-lab' : COURSE_ID, enrolledAt: iso(t - (28 - i) * DAY), diagnosticCompletedAt: iso(t - (28 - i) * DAY), currentLessonId: null });
  });
  const invites: MockInvite[] = [
    { id: 'inv-1', classId: 'cls-monday', email: 'new@sathi.dev', token: 'demo-class-invite', invitedBy: 'usr-meera', createdAt: iso(t - 2 * DAY), expiresAt: iso(t + 12 * DAY), acceptedAt: null, revokedAt: null },
    { id: 'inv-2', classId: 'cls-monday', email: 'farhan@example.in', token: 'demo-class-invite-2', invitedBy: 'usr-meera', createdAt: iso(t - 3 * DAY), expiresAt: iso(t + 11 * DAY), acceptedAt: null, revokedAt: null },
    { id: 'inv-3', classId: 'cls-monday', email: 'old@example.in', token: 'demo-class-invite-expired', invitedBy: 'usr-meera', createdAt: iso(t - 20 * DAY), expiresAt: iso(t - 6 * DAY), acceptedAt: null, revokedAt: null },
  ];
  const staffInvites: MockStaffInvite[] = [
    { id: 'sinv-1', email: 'teacher@school.in', role: 'Instructor', courseId: COURSE_ID, token: 'demo-staff-invite', invitedBy: 'usr-kabir', createdAt: iso(t - DAY), expiresAt: iso(t + 6 * DAY), acceptedAt: null, revokedAt: null },
    { id: 'sinv-2', email: 'ops@sathi.dev', role: 'Admin', courseId: null, token: 'demo-staff-invite-old', invitedBy: 'usr-kabir', createdAt: iso(t - 12 * DAY), expiresAt: iso(t - 5 * DAY), acceptedAt: null, revokedAt: null },
  ];
  const consents: MockConsent[] = [
    { id: 'gc-1', userId: 'usr-tara', guardianEmail: 'parent.singh@example.com', token: 'demo-consent', requestedAt: iso(t - 3_600_000), expiresAt: iso(t + 7 * DAY - 3_600_000), decidedAt: null, decision: null },
  ];

  // Enough history to need "Load older conversations" (the first page is 20).
  const topics = ['Softmax temperature', 'Vanishing gradients', 'Cosine similarity', 'Learning rate warm-up', 'Layer normalisation', 'Dropout intuition', 'Tokenisation basics', 'Positional encodings', 'Beam search', 'Precision vs recall', 'Overfitting signs', 'Weight decay', 'Batch size effects', 'Chunking documents', 'BM25 in one line', 'Embedding drift', 'Prompt caching', 'Eval datasets', 'Hallucination checks', 'Cross-entropy loss', 'Adam vs SGD', 'ReLU vs GELU', 'KV cache'];
  topics.forEach((title, i) => {
    const at = t - (9 + i) * DAY;
    conversations.push({
      id: `conv-old-${i}`, userId: 'usr-asha', courseId: COURSE_ID, lessonId: null, title, createdAt: iso(at), updatedAt: iso(at),
      messages: [
        msg('user', `Can you explain ${title.toLowerCase()}?`, { createdAt: iso(at) }),
        msg('assistant', `Here is a short explanation of ${title.toLowerCase()} [1].`, { createdAt: iso(at), citations: [{ index: 1, sourceType: 'course', title: 'Course notes', documentId: null, lessonId: 'les-attention', page: null, url: null, snippet: `${title} in brief.` }], answerBasis: ['course'] }),
      ],
    });
  });
  conversations.push(
    {
      id: 'conv-stopped', userId: 'usr-asha', courseId: COURSE_ID, lessonId: null, title: 'Explain LoRA', createdAt: iso(t - 5 * DAY), updatedAt: iso(t - 5 * DAY),
      messages: [msg('user', 'Explain LoRA in detail', { createdAt: iso(t - 5 * DAY) }), msg('assistant', 'LoRA freezes the pretrained weights and learns a small low-rank update instead, so', { status: 'cancelled', createdAt: iso(t - 5 * DAY) })],
    },
    {
      id: 'conv-stuck', userId: 'usr-asha', courseId: COURSE_ID, lessonId: null, title: 'What is a mixture of experts?', createdAt: iso(t - 6 * DAY), updatedAt: iso(t - 6 * DAY),
      messages: [msg('user', 'What is a mixture of experts?', { createdAt: iso(t - 6 * DAY) }), msg('assistant', 'A mixture of experts routes each token to', { status: 'streaming', createdAt: iso(t - 6 * DAY), referenceId: '4C2E-9A17' })],
    },
  );

  return { users, courses, modules, lessons, concepts, questions, enrollments, progress, mastery, trend, attempts: [], cards, docs, gradings, conversations, runs, questionsAsked: { 'usr-asha': 23 }, courseInstructors, classes, members, invites, staffInvites, consents };
}

export function makeRun(type: AiRunSummary['type'], errorCode: string | null, startedAt: number, traceIdIn?: string): AiRunDetail {
  const traceId = traceIdIn ?? hex(16);
  const ref = traceId.slice(0, 8).toUpperCase();
  const latency = type === 'chat' ? 3200 + Math.round(Math.random() * 4000) : 9000;
  const runId = uid();
  const failed = !!errorCode;
  const step = (name: string, offset: number, dur: number, outcome: 'ok' | 'empty' | 'failed' | 'skipped', metrics: Record<string, unknown>) => ({ step: name, startedAt: iso(startedAt + offset), endedAt: iso(startedAt + offset + dur), outcome, metrics });
  const steps =
    type === 'chat'
      ? [step('retrieve', 20, 180, 'ok', { method: 'hybrid', resultCount: 6, topK: 8 }), step('llm', 220, latency - 300, failed ? 'failed' : 'ok', { model: 'claude-opus-5-5', finishReason: failed ? 'timeout' : 'end_turn' }), step('citation_check', latency - 60, 40, failed ? 'skipped' : 'ok', { valid: 2, dropped: 0 })]
      : type === 'grading'
        ? [step('grade', 50, 2400, failed ? 'failed' : 'ok', { confidence: 0.62, rubricVersion: 1 })]
        : [step('generate', 50, 6000, 'ok', { count: 5 })];
  return {
    run: {
      id: runId, traceId, referenceId: `${ref.slice(0, 4)}-${ref.slice(4)}`, type, status: failed ? 'failed' : 'succeeded', startedAt: iso(startedAt), finishedAt: iso(startedAt + latency),
      model: 'claude-opus-5-5', provider: 'anthropic', promptHash: 'sha256:' + hex(8), inputTokens: 1800 + Math.round(Math.random() * 1500), outputTokens: failed ? 0 : 240 + Math.round(Math.random() * 300),
      estimatedCostUsd: failed ? 0.009 : 0.031, ttftMs: failed ? null : 820, latencyMs: latency, errorCode, errorMessage: failed ? (errorCode === 'LLM_TIMEOUT' ? 'Provider did not respond within 60 s (after 2 retries).' : 'Grader returned invalid JSON twice.') : null,
      hangfireJobId: type === 'chat' ? null : String(1000 + Math.round(Math.random() * 900)), conversationId: type === 'chat' ? 'conv-sqrt' : null, documentId: null, userIdHash: '3f9a12bc77de0a41',
    },
    steps,
    ingestionJob: null,
    aiService: type === 'chat'
      ? {
          modelRuns: [{ purpose: 'tutor', provider: 'anthropic', model: 'claude-opus-5-5', promptName: 'tutor.answer', promptVersion: 'v7', inputTokens: 2140, outputTokens: failed ? 0 : 312, estimatedCostUsd: 0.031, ttftMs: failed ? null : 820, latencyMs: latency - 300, retries: failed ? 2 : 0, finishReason: failed ? 'timeout' : 'end_turn', errorCode, fallbackUsed: failed }],
          retrievalRuns: [{ method: 'hybrid', topK: 8, resultCount: 6, empty: false, timings: { vectorMs: 38, keywordMs: 12, fuseMs: 2 }, sources: [ { rank: 1, sourceType: 'upload', title: 'Lecture 3 notes.pdf', url: null, score: 0.83, cited: true }, { rank: 2, sourceType: 'course', title: 'Attention basics', url: null, score: 0.79, cited: true }, { rank: 3, sourceType: 'course', title: 'Attention mechanisms', url: null, score: 0.71, cited: false } ] }],
          searchRuns: [],
        }
      : null,
    links: { grafanaLogs: `http://localhost:3000/explore?traceId=${traceId}`, grafanaTrace: `http://localhost:3000/explore?tempo=${traceId}`, hangfireJob: type === 'chat' ? null : `/hangfire/jobs/details/${1000 + Math.round(Math.random() * 900)}` },
  };
}

export function makeIngestionFailureRun(traceId: string, documentId: string, startedAt: number): AiRunDetail {
  const run = makeRun('ingestion', 'INGEST_NO_TEXT', startedAt, traceId);
  run.run.errorMessage = 'Parsed 6 pages, 0 characters of selectable text (likely a scanned PDF).';
  run.run.documentId = documentId;
  run.run.model = null;
  run.run.provider = null;
  run.run.inputTokens = null;
  run.run.outputTokens = null;
  run.run.estimatedCostUsd = 0;
  run.run.hangfireJobId = '1207';
  run.steps = [
    { step: 'parse', startedAt: iso(startedAt + 120), endedAt: iso(startedAt + 2_300), outcome: 'failed', metrics: { pageCount: 6, charCount: 0, parser: 'pdfplumber' } },
    { step: 'index', startedAt: iso(startedAt + 2_300), endedAt: iso(startedAt + 2_300), outcome: 'skipped', metrics: {} },
  ];
  run.ingestionJob = { id: uid(), documentId, status: 'failed', stage: 'parsing', attempt: 3, errorCode: 'INGEST_NO_TEXT', errorMessage: 'No selectable text found.', hangfireJobId: '1207' };
  run.links.hangfireJob = '/hangfire/jobs/details/1207';
  return run;
}

// ---------------------------------------------------------------- database
export class MockDb {
  s: DbState;

  constructor() {
    this.s = this.load() ?? seed();
  }

  private load(): DbState | null {
    try {
      const raw = sessionStorage.getItem(STORAGE_KEY);
      return raw ? (JSON.parse(raw) as DbState) : null;
    } catch {
      return null;
    }
  }
  save(): void {
    try {
      sessionStorage.setItem(STORAGE_KEY, JSON.stringify(this.s));
    } catch {
      /* quota — ignore */
    }
  }

  // ----- session
  get sessionUserId(): string | null {
    try {
      return sessionStorage.getItem(SESSION_KEY);
    } catch {
      return null;
    }
  }
  set sessionUserId(id: string | null) {
    try {
      if (id) sessionStorage.setItem(SESSION_KEY, id);
      else sessionStorage.removeItem(SESSION_KEY);
    } catch {
      /* ignore */
    }
  }
  currentUser(): MockUser | null {
    const id = this.sessionUserId;
    return this.s.users.find((u) => u.id === id && !u.deleted) ?? null;
  }
  me(u: MockUser): Me {
    return { id: u.id, email: u.email, displayName: u.displayName, roles: u.roles, emailConfirmed: u.emailConfirmed, preferences: { ...u.prefs }, onboardingCompleted: !!u.onboardingCompletedAt, isMinor: !!u.isMinor };
  }

  // ----- access (contracts.md §11.1)
  user(id: string): MockUser | undefined {
    return this.s.users.find((u) => u.id === id);
  }
  isAdmin(userId: string): boolean {
    return !!this.user(userId)?.roles.includes('Admin');
  }
  /** Course instructor row or Admin. */
  courseRole(userId: string, courseId: string): 'owner' | 'instructor' | 'admin' | null {
    const row = this.s.courseInstructors.find((x) => x.userId === userId && x.courseId === courseId);
    if (row) return row.role;
    return this.isAdmin(userId) ? 'admin' : null;
  }
  activeClassesOf(userId: string, courseId?: string): MockClass[] {
    const ids = new Set(this.s.members.filter((m) => m.userId === userId && !m.removedAt).map((m) => m.classId));
    return this.s.classes.filter((c) => ids.has(c.id) && !c.archivedAt && (!courseId || c.courseId === courseId));
  }
  /** Published and (public or an active member of a live class) — or staff of the course. */
  canSeeCourse(userId: string, courseId: string): boolean {
    const c = this.s.courses.find((x) => x.id === courseId);
    if (!c) return false;
    if (this.courseRole(userId, courseId)) return true;
    return c.isPublished && (c.visibility === 'public' || this.activeClassesOf(userId, courseId).length > 0);
  }
  courseOfLesson(lessonId: string): string | null {
    const l = this.s.lessons.find((x) => x.id === lessonId);
    return this.s.modules.find((m) => m.id === l?.moduleId)?.courseId ?? null;
  }

  // ----- courses
  courseSummaries(userId: string): CourseSummary[] {
    return this.s.courses
      .filter((c) => c.isPublished && this.canSeeCourse(userId, c.id))
      .map((c) => this.courseSummary(c.id, userId)!);
  }
  courseSummary(courseId: string, userId: string): CourseSummary | null {
    const c = this.s.courses.find((x) => x.id === courseId);
    if (!c) return null;
    const mods = this.s.modules.filter((m) => m.courseId === c.id);
    const enr = this.s.enrollments.find((e) => e.userId === userId && e.courseId === c.id);
    return {
      id: c.id, slug: c.slug, title: c.title, description: c.description, moduleCount: mods.length, lessonCount: this.lessonsOf(c.id).length, enrolled: !!enr, diagnosticCompleted: !!enr?.diagnosticCompletedAt,
      visibility: c.visibility, classes: this.activeClassesOf(userId, c.id).map(({ id, name }) => ({ id, name })),
    };
  }
  lessonsOf(courseId: string): MockLesson[] {
    const mods = this.s.modules.filter((m) => m.courseId === courseId).sort((a, b) => a.position - b.position);
    return mods.flatMap((m) => this.s.lessons.filter((l) => l.moduleId === m.id).sort((a, b) => a.position - b.position));
  }
  lessonProgress(userId: string, lessonId: string): { status: LessonStatus; percent: number } {
    const p = this.s.progress.find((x) => x.userId === userId && x.lessonId === lessonId);
    return p ? { status: p.status, percent: p.percent } : { status: 'not_started', percent: 0 };
  }
  courseDetail(courseId: string, userId: string): CourseDetail | null {
    const c = this.s.courses.find((x) => x.id === courseId);
    if (!c) return null;
    return {
      id: c.id, slug: c.slug, title: c.title, description: c.description,
      modules: this.s.modules.filter((m) => m.courseId === courseId).sort((a, b) => a.position - b.position).map((m) => ({
        id: m.id, title: m.title, summary: m.summary, position: m.position,
        lessons: this.s.lessons.filter((l) => l.moduleId === m.id).sort((a, b) => a.position - b.position).map((l) => ({ id: l.id, title: l.title, summary: l.summary, position: l.position, estimatedMinutes: l.estimatedMinutes, ...this.lessonProgress(userId, l.id) })),
      })),
      concepts: this.s.concepts.filter((x) => x.courseId === courseId).map(({ id, slug, name, description }) => ({ id, slug, name, description })),
    };
  }
  enroll(userId: string, courseId: string): void {
    if (!this.s.enrollments.some((e) => e.userId === userId && e.courseId === courseId)) {
      this.s.enrollments.push({ userId, courseId, enrolledAt: iso(now()), diagnosticCompletedAt: null, currentLessonId: this.lessonsOf(courseId)[0]?.id ?? null });
    }
    const u = this.s.users.find((x) => x.id === userId);
    if (u) u.prefs.activeCourseId = courseId;
  }
  lesson(lessonId: string, userId: string): Lesson | null {
    const l = this.s.lessons.find((x) => x.id === lessonId);
    if (!l) return null;
    const mod = this.s.modules.find((m) => m.id === l.moduleId)!;
    const course = this.s.courses.find((c) => c.id === mod.courseId)!;
    const all = this.lessonsOf(course.id);
    const idx = all.findIndex((x) => x.id === lessonId);
    const inModule = this.s.lessons.filter((x) => x.moduleId === mod.id);
    return {
      id: l.id, title: l.title, summary: l.summary, contentMarkdown: l.contentMarkdown, estimatedMinutes: l.estimatedMinutes, position: l.position, lessonCount: inModule.length,
      module: { id: mod.id, title: mod.title, position: mod.position }, course: { id: course.id, title: course.title }, objectives: l.objectives,
      concepts: l.conceptIds.map((id) => ({ id, name: this.conceptName(id) })), progress: this.lessonProgress(userId, l.id),
      previousLessonId: all[idx - 1]?.id ?? null, nextLessonId: all[idx + 1]?.id ?? null,
    };
  }
  setProgress(userId: string, lessonId: string, percent: number, completed: boolean): void {
    let p = this.s.progress.find((x) => x.userId === userId && x.lessonId === lessonId);
    if (!p) {
      p = { userId, lessonId, status: 'in_progress', percent: 0 };
      this.s.progress.push(p);
    }
    p.percent = Math.max(p.percent, Math.round(clamp(percent, 0, 100)));
    if (completed) {
      p.status = 'completed';
      p.percent = 100;
    } else if (p.status !== 'completed') p.status = 'in_progress';
    const lesson = this.s.lessons.find((l) => l.id === lessonId);
    const mod = this.s.modules.find((m) => m.id === lesson?.moduleId);
    const enr = this.s.enrollments.find((e) => e.userId === userId && e.courseId === mod?.courseId);
    if (enr) enr.currentLessonId = completed ? (this.lesson(lessonId, userId)?.nextLessonId ?? lessonId) : lessonId;
  }
  conceptName(id: string): string {
    return this.s.concepts.find((c) => c.id === id)?.name ?? 'Concept';
  }

  // ----- mastery
  masteryOf(userId: string, conceptId: string) {
    let row = this.s.mastery.find((m) => m.userId === userId && m.conceptId === conceptId);
    if (!row) {
      row = { userId, conceptId, mastery: 0.3, attempts: 0, correct: 0, misses: 0, lastPracticedAt: iso(now()) };
      this.s.mastery.push(row);
    }
    return row;
  }
  /** contracts.md §7 mastery update. */
  updateMastery(userId: string, conceptId: string, outcome: number, difficulty: number, diagnostic = false): { before: number; after: number } {
    const row = this.masteryOf(userId, conceptId);
    const before = row.mastery;
    let after: number;
    if (diagnostic) after = outcome >= 0.5 ? 0.6 : 0.25;
    else {
      const p = 1 / (1 + Math.exp(-6 * (before - difficulty)));
      const k = Math.max(0.06, 0.3 / Math.sqrt(1 + row.attempts));
      after = clamp(before + k * (outcome - p), 0.02, 0.98);
    }
    row.mastery = after;
    row.attempts++;
    if (outcome >= 0.5) row.correct++;
    else row.misses++;
    row.lastPracticedAt = iso(now());
    return { before, after };
  }
  /** Like the real API: every concept of the course, unpractised ones with attempts 0 and the 0.3 starting estimate. */
  masteryList(userId: string, courseId: string): ConceptMastery[] {
    return this.s.concepts
      .filter((c) => c.courseId === courseId)
      .map((c) => {
        const m = this.s.mastery.find((x) => x.userId === userId && x.conceptId === c.id);
        const mastery = m?.mastery ?? 0.3;
        return { conceptId: c.id, name: c.name, mastery, attempts: m?.attempts ?? 0, needsWork: mastery < 0.5 };
      })
      .sort((a, b) => b.mastery - a.mastery);
  }
  studyNext(userId: string, courseId: string): StudyNextItem[] {
    const items: StudyNextItem[] = [];
    const weakest = this.masteryList(userId, courseId).filter((m) => m.needsWork && m.attempts > 0).sort((a, b) => a.mastery - b.mastery)[0];
    if (weakest) {
      const row = this.masteryOf(userId, weakest.conceptId);
      const misses = row.misses;
      items.push({ type: 'concept_practice', targetId: weakest.conceptId, title: weakest.name, reason: `Weakest concept. ${misses > 1 ? `${['', 'One', 'Two', 'Three', 'Four', 'Five'][Math.min(misses, 5)]} recent misses` : 'A recent miss'}${weakest.conceptId === 'cpt-backprop' ? ' on the chain rule' : ''}.` });
    }
    const enr = this.s.enrollments.find((e) => e.userId === userId && e.courseId === courseId);
    const current = enr?.currentLessonId ? this.s.lessons.find((l) => l.id === enr.currentLessonId) : null;
    if (current) {
      items.push({ type: 'quiz', targetId: current.id, title: `${current.title.split(' ')[0]} quiz`, reason: 'Check your understanding after today’s lesson.' });
    }
    const due = this.dueCards(userId).length;
    if (due > 0) items.push({ type: 'revision', targetId: courseId, title: 'Revision', reason: `${due} card${due === 1 ? '' : 's'} due — about ${Math.max(1, Math.ceil(due * 1.2))} minutes.` });
    else if (current) items.push({ type: 'lesson', targetId: current.id, title: current.title, reason: 'Next lesson in your course.' });
    return items.slice(0, 3);
  }

  home(userId: string, courseId: string): Home | null {
    const c = this.s.courses.find((x) => x.id === courseId);
    if (!c) return null;
    const enr = this.s.enrollments.find((e) => e.userId === userId && e.courseId === courseId);
    const all = this.lessonsOf(courseId);
    const lessonId = enr?.currentLessonId ?? all.find((l) => this.lessonProgress(userId, l.id).status !== 'completed')?.id ?? null;
    let continueLesson: Home['continueLesson'] = null;
    if (lessonId) {
      const l = this.lesson(lessonId, userId)!;
      continueLesson = { lessonId: l.id, title: l.title, summary: l.summary, courseTitle: c.title, moduleTitle: l.module.title, modulePosition: l.module.position, lessonPosition: l.position, lessonCount: l.lessonCount, percent: l.progress.percent };
    }
    const due = this.dueCards(userId).length;
    const u = this.s.users.find((x) => x.id === userId)!;
    return { course: { id: c.id, title: c.title }, continueLesson, revision: { dueCount: due, estimatedMinutes: Math.ceil(due * 1.2) }, mastery: this.masteryList(userId, courseId), studyNext: this.studyNext(userId, courseId), streakDays: u.streakDays };
  }

  progressOverview(userId: string, courseId: string): ProgressOverview {
    const all = this.masteryList(userId, courseId);
    const list = all.filter((m) => m.attempts > 0);
    const avg = list.length ? list.reduce((s, m) => s + m.mastery, 0) / list.length : 0;
    const trend = this.s.trend.filter((t) => t.userId === userId).map(({ date, average }) => ({ date, average }));
    if (list.length) trend.push({ date: iso(now()).slice(0, 10), average: avg });
    const lessons = this.lessonsOf(courseId);
    const quizzes = this.s.attempts
      .filter((a) => a.userId === userId && a.completed)
      .map((a) => ({ attemptId: a.id, title: a.title, completedAt: a.completedAt!, correct: a.answers.filter((x) => x.isCorrect).length, total: a.questionIds.length }));
    if (userId === 'usr-asha') {
      quizzes.push(
        { attemptId: 'att-h1', title: 'Gradient descent', completedAt: iso(now() - 6 * DAY), correct: 7, total: 8 },
        { attemptId: 'att-h2', title: 'Backpropagation', completedAt: iso(now() - 4 * DAY), correct: 4, total: 8 },
        { attemptId: 'att-h3', title: 'Lesson check: Embeddings', completedAt: iso(now() - 2 * DAY), correct: 5, total: 6 },
      );
    }
    quizzes.sort((a, b) => b.completedAt.localeCompare(a.completedAt));
    const u = this.s.users.find((x) => x.id === userId)!;
    return { mastery: all, masteryTrend: trend, quizzes, lessonsCompleted: lessons.filter((l) => this.lessonProgress(userId, l.id).status === 'completed').length, lessonCount: lessons.length, streakDays: u.streakDays, questionsAsked: this.s.questionsAsked[userId] ?? 0 };
  }

  // ----- quizzes
  toAttemptQuestion(q: InstructorQuestion, position: number): AttemptQuestion {
    return { id: q.id, position, type: q.type, stem: q.stem, conceptId: q.conceptId, conceptName: q.conceptName, options: q.options.map((o) => ({ id: o.id!, label: o.label, text: o.text })) };
  }
  toAttempt(a: MockAttempt): Attempt {
    const qs = a.questionIds.map((id, i) => this.toAttemptQuestion(this.s.questions.find((q) => q.id === id)!, i + 1));
    return { attemptId: a.id, quizId: a.quizId, title: a.title, kind: a.kind, conceptName: a.conceptName, questions: qs, answers: a.answers.map((x) => this.publicAnswer(x)), completed: a.completed };
  }
  publicAnswer(a: AnswerResult & { freeText?: string; polls?: number }): AnswerResult {
    const { freeText: _f, polls: _p, ...rest } = a;
    return rest;
  }
  createAttempt(userId: string, courseId: string, kind: QuizKind, questionIds: string[], title: string, conceptName: string | null): MockAttempt {
    const a: MockAttempt = { id: uid(), quizId: uid(), userId, title, kind, conceptName, questionIds, answers: [], completed: false, startedAt: iso(now()), completedAt: null, courseId };
    this.s.attempts.push(a);
    return a;
  }
  diagnostic(userId: string, courseId: string): MockAttempt {
    const ids = this.s.questions.filter((q) => q.courseId === courseId && q.isDiagnostic && q.status === 'published').slice(0, 10).map((q) => q.id);
    return this.createAttempt(userId, courseId, 'diagnostic', ids.slice(0, 6), 'Diagnostic', null);
  }
  practice(userId: string, courseId: string, conceptId?: string, lessonId?: string, count = 8): MockAttempt {
    const pub = this.s.questions.filter((q) => q.courseId === courseId && q.status === 'published');
    let pool: InstructorQuestion[];
    let title: string;
    let kind: QuizKind = 'practice';
    let conceptName: string | null = null;
    if (conceptId) {
      pool = pub.filter((q) => q.conceptId === conceptId);
      title = conceptName = this.conceptName(conceptId);
    } else if (lessonId) {
      const l = this.s.lessons.find((x) => x.id === lessonId);
      pool = pub.filter((q) => q.lessonId === lessonId || l?.conceptIds.includes(q.conceptId));
      title = `Lesson check: ${l?.title ?? 'Lesson'}`;
      kind = 'lesson_check';
    } else {
      const order = this.s.mastery.filter((m) => m.userId === userId).sort((a, b) => a.mastery - b.mastery).map((m) => m.conceptId);
      pool = [...pub].sort((a, b) => (order.indexOf(a.conceptId) + 99) % 100 - (order.indexOf(b.conceptId) + 99) % 100);
      title = 'Mixed practice';
    }
    const mcq = pool.filter((q) => q.type === 'mcq');
    const short = pool.filter((q) => q.type === 'short');
    const ids = [...mcq.slice(0, Math.max(1, count - (short.length ? 1 : 0))), ...short.slice(0, 1)].slice(0, count).map((q) => q.id);
    return this.createAttempt(userId, courseId, kind, ids, title, conceptName);
  }
  answer(a: MockAttempt, questionId: string, selectedOptionId?: string, freeText?: string): AnswerResult {
    const existing = a.answers.find((x) => x.questionId === questionId);
    if (existing) return this.publicAnswer(existing);
    const q = this.s.questions.find((x) => x.id === questionId)!;
    const diagnostic = a.kind === 'diagnostic';
    let result: AnswerResult & { freeText?: string; polls?: number };
    if (q.type === 'mcq') {
      const correctOpt = q.options.find((o) => o.isCorrect)!;
      const isCorrect = selectedOptionId === correctOpt.id;
      const ch = this.updateMastery(a.userId, q.conceptId, isCorrect ? 1 : 0, q.difficulty, diagnostic);
      this.touchCard(a.userId, q, isCorrect ? 4 : 1);
      result = { answerId: uid(), questionId, isCorrect, selectedOptionId: selectedOptionId ?? null, correctOptionId: correctOpt.id!, explanation: q.explanation, mastery: { conceptId: q.conceptId, name: q.conceptName, before: ch.before, after: ch.after }, grading: null };
    } else {
      result = { answerId: uid(), questionId, isCorrect: null, selectedOptionId: null, correctOptionId: null, explanation: q.explanation, mastery: null, grading: { status: 'pending', score: null, maxScore: null, feedback: null }, freeText, polls: 0 };
    }
    a.answers.push(result);
    return this.publicAnswer(result);
  }
  /** Advances fake grading on each poll: pending → auto_accepted / needs_review. */
  pollAnswer(a: MockAttempt, answerId: string): AnswerResult | null {
    const r = a.answers.find((x) => x.answerId === answerId);
    if (!r) return null;
    if (r.grading?.status === 'pending') {
      r.polls = (r.polls ?? 0) + 1;
      if (r.polls >= 2) {
        const q = this.s.questions.find((x) => x.id === r.questionId)!;
        const max = q.rubric?.criteria.reduce((s, c) => s + c.points, 0) ?? 4;
        const text = r.freeText ?? '';
        if (text.length < 40) {
          r.grading = { status: 'needs_review', score: null, maxScore: max, feedback: null };
          const u = this.s.users.find((x) => x.id === a.userId);
          this.s.gradings.unshift({ id: uid(), attemptId: a.id, answerId: r.answerId, userId: a.userId, studentDisplayName: u?.displayName ?? 'Student', questionId: q.id, answerText: text, aiScore: 1, maxScore: max, confidence: 0.44, aiFeedback: 'Very short answer; key ideas from the rubric are missing or only implied.', status: 'needs_review', submittedAt: iso(now()) });
        } else {
          const score = Math.min(max, 3);
          const ch = this.updateMastery(a.userId, q.conceptId, score / max, q.difficulty);
          r.isCorrect = score / max >= 0.5;
          r.mastery = { conceptId: q.conceptId, name: q.conceptName, before: ch.before, after: ch.after };
          r.grading = { status: 'auto_accepted', score, maxScore: max, feedback: 'Good explanation: you connected the chain rule to the order of computation. To get full marks, mention that each layer reuses the gradient already computed above it.' };
          this.touchCard(a.userId, q, r.isCorrect ? 4 : 1);
        }
      }
    }
    return this.publicAnswer(r);
  }
  complete(a: MockAttempt): AttemptCompletion {
    a.completed = true;
    a.completedAt = iso(now());
    const changes = new Map<string, { conceptId: string; name: string; before: number; after: number }>();
    for (const ans of a.answers) {
      if (!ans.mastery) continue;
      const prev = changes.get(ans.mastery.conceptId);
      changes.set(ans.mastery.conceptId, { ...ans.mastery, before: prev ? prev.before : ans.mastery.before });
    }
    if (a.kind === 'diagnostic') {
      const enr = this.s.enrollments.find((e) => e.userId === a.userId && e.courseId === a.courseId);
      if (enr) enr.diagnosticCompletedAt = iso(now());
      const u = this.s.users.find((x) => x.id === a.userId);
      if (u) {
        u.onboardingCompletedAt = iso(now());
        u.streakDays = Math.max(1, u.streakDays);
      }
    }
    return { attemptId: a.id, correct: a.answers.filter((x) => x.isCorrect).length, total: a.questionIds.length, masteryChanges: [...changes.values()], studyNext: this.studyNext(a.userId, a.courseId) };
  }

  // ----- revision (SM-2, contracts.md §7)
  dueCards(userId: string): MockCard[] {
    const t = now();
    return this.s.cards.filter((c) => c.userId === userId && Date.parse(c.dueAt) <= t).sort((a, b) => a.dueAt.localeCompare(b.dueAt));
  }
  touchCard(userId: string, q: InstructorQuestion, quality: number): void {
    let card = this.s.cards.find((c) => c.userId === userId && c.questionId === q.id);
    if (!card) {
      card = { id: uid(), userId, questionId: q.id, conceptId: q.conceptId, ef: 2.5, interval: 0, reps: 0, dueAt: iso(now()) };
      this.s.cards.push(card);
    }
    this.sm2(card, quality);
  }
  sm2(card: MockCard, q: number): void {
    if (q < 3) {
      card.reps = 0;
      card.interval = 1;
    } else {
      card.reps += 1;
      card.interval = card.reps === 1 ? 1 : card.reps === 2 ? 3 : Math.round(card.interval * card.ef);
    }
    card.ef = Math.max(1.3, card.ef + 0.1 - (5 - q) * (0.08 + (5 - q) * 0.02));
    card.dueAt = iso(now() + card.interval * DAY);
  }

  // ----- documents
  advanceDoc(d: MockDoc): void {
    if (d.status === 'ready' || d.status === 'failed') return;
    d.polls++;
    const t = iso(now());
    if (d.stage === 'queued' && d.polls >= 1) Object.assign(d, { status: 'processing', stage: 'parsing', progressPercent: 30, updatedAt: t });
    else if (d.stage === 'parsing' && d.polls >= 3) {
      if (d.failAt === 'parsing') {
        const trace = hex(16);
        const ref = trace.slice(0, 8).toUpperCase();
        Object.assign(d, { status: 'failed', stage: 'failed', errorCode: 'INGEST_NO_TEXT', errorMessage: 'No selectable text found.', referenceId: `${ref.slice(0, 4)}-${ref.slice(4)}`, updatedAt: t });
        this.s.runs.unshift(makeIngestionFailureRun(trace, d.id, now() - 4000));
      } else Object.assign(d, { stage: 'indexing', progressPercent: 70, updatedAt: t });
    } else if (d.stage === 'indexing' && d.polls >= 5) {
      Object.assign(d, { status: 'ready', stage: 'ready', progressPercent: 100, passageCount: d.fileName.endsWith('.md') ? 18 : 12 + Math.round(d.sizeBytes / 60_000) % 50, updatedAt: t });
    }
  }
  publicDoc(d: MockDoc): DocumentItem {
    const { ownerId: _o, polls: _p, failAt: _f, ...rest } = d;
    return rest;
  }

  // ----- instructor
  gradingQueue(courseId?: string | null, classId?: string | null): GradingQueueItem[] {
    const inClass = classId ? new Set(this.s.members.filter((m) => m.classId === classId && !m.removedAt).map((m) => m.userId)) : null;
    return this.s.gradings
      .filter((g) => g.status === 'needs_review')
      .filter((g) => !courseId || this.s.questions.find((q) => q.id === g.questionId)?.courseId === courseId)
      .filter((g) => !inClass || inClass.has(g.userId))
      .map((g) => {
        const q = this.s.questions.find((x) => x.id === g.questionId);
        return { gradingId: g.id, studentDisplayName: g.studentDisplayName, questionStem: q?.stem ?? '', answerText: g.answerText, aiScore: g.aiScore, maxScore: g.maxScore, confidence: g.confidence, aiFeedback: g.aiFeedback, rubric: q?.rubric ?? { criteria: [], modelAnswer: '' }, submittedAt: g.submittedAt };
      });
  }

  // ----- classes (contracts.md §11.1)
  newJoinCode(): string {
    for (;;) {
      const bytes = globalThis.crypto.getRandomValues(new Uint8Array(8));
      const code = Array.from(bytes, (b) => JOIN_ALPHABET[b % JOIN_ALPHABET.length]).join('');
      if (!this.s.classes.some((c) => c.joinCode === code)) return code;
    }
  }
  inviteStatus(i: MockInvite): 'pending' | 'accepted' | 'expired' | 'revoked' {
    if (i.revokedAt) return 'revoked';
    if (i.acceptedAt) return 'accepted';
    return Date.parse(i.expiresAt) < now() ? 'expired' : 'pending';
  }
  classSummary(c: MockClass): ClassSummary {
    return {
      id: c.id, courseId: c.courseId, name: c.name, description: c.description, joinCode: c.joinCode, joinEnabled: c.joinEnabled,
      memberCount: this.s.members.filter((m) => m.classId === c.id && !m.removedAt).length,
      pendingInvites: this.s.invites.filter((i) => i.classId === c.id && this.inviteStatus(i) === 'pending').length,
      createdAt: c.createdAt, archivedAt: c.archivedAt,
    };
  }
  /** Idempotent: (re)activates membership, enrols in the course, sets activeCourseId when empty. */
  joinClass(userId: string, cls: MockClass, via: 'code' | 'invite' | 'added'): void {
    const m = this.s.members.find((x) => x.classId === cls.id && x.userId === userId);
    if (m) {
      if (m.removedAt) Object.assign(m, { removedAt: null, joinedAt: iso(now()), joinedVia: via });
    } else this.s.members.push({ classId: cls.id, userId, joinedAt: iso(now()), joinedVia: via, removedAt: null });
    const u = this.user(userId);
    const hadActive = !!u?.prefs.activeCourseId;
    if (!this.s.enrollments.some((e) => e.userId === userId && e.courseId === cls.courseId)) {
      this.s.enrollments.push({ userId, courseId: cls.courseId, enrolledAt: iso(now()), diagnosticCompletedAt: null, currentLessonId: this.lessonsOf(cls.courseId)[0]?.id ?? null });
    }
    if (u && !hadActive) u.prefs.activeCourseId = cls.courseId;
  }
  instructorCourse(c: MockCourse, userId: string) {
    const lessons = this.lessonsOf(c.id);
    const classes = this.s.classes.filter((x) => x.courseId === c.id && !x.archivedAt);
    return {
      id: c.id, slug: c.slug, title: c.title, description: c.description, isPublished: c.isPublished, visibility: c.visibility,
      moduleCount: this.s.modules.filter((m) => m.courseId === c.id).length, lessonCount: lessons.length,
      conceptCount: this.s.concepts.filter((x) => x.courseId === c.id).length, questionCount: this.s.questions.filter((q) => q.courseId === c.id).length,
      studentCount: this.studentsOf(c.id).length, classCount: classes.length, myRole: this.courseRole(userId, c.id) ?? 'admin',
    };
  }
  /** Enrolled learners who are not staff of the course. */
  studentsOf(courseId: string): string[] {
    return this.s.enrollments.filter((e) => e.courseId === courseId && !this.s.courseInstructors.some((ci) => ci.courseId === courseId && ci.userId === e.userId) && !this.isAdmin(e.userId)).map((e) => e.userId);
  }

  // ----- users (contracts.md §11.2)
  isLocked(u: MockUser): boolean {
    return !!u.lockedUntil && Date.parse(u.lockedUntil) > now();
  }
  accountStatus(u: MockUser): 'active' | 'pending_guardian' | 'deleted' {
    if (u.deleted) return 'deleted';
    return u.consentStatus === 'pending' ? 'pending_guardian' : 'active';
  }
  adminUser(u: MockUser) {
    return {
      id: u.id, email: u.email, displayName: u.displayName, roles: [...u.roles], emailConfirmed: u.emailConfirmed, lockedOut: this.isLocked(u),
      accountStatus: this.accountStatus(u), isMinor: !!u.isMinor, createdAt: u.createdAt ?? iso(now()), lastActiveAt: u.lastActiveAt ?? null,
    };
  }
}
