/* Mock-only HttpInterceptor: serves contract-shaped responses for every /api/v1 endpoint. */
import { HttpErrorResponse, HttpEvent, HttpEventType, HttpHeaders, HttpInterceptorFn, HttpRequest, HttpResponse } from '@angular/common/http';
import { concat, delay, mergeMap, Observable, of, throwError, timer } from 'rxjs';
import { map } from 'rxjs/operators';
import {
  ConceptUpsert,
  CourseUpsert,
  GenerateQuestionsRequest,
  GradingReview,
  InstructorQuestion,
  LessonUpsert,
  ModuleUpsert,
  PreferencesUpdate,
  QuestionUpsert,
  RevisionReviewRequest,
} from '../models/api.models';
import { COURSE_ID } from './mock-content';
import {
  clamp,
  DAY_MS,
  hex,
  LAST_CLASS_INVITE_LINK_KEY,
  LAST_CONSENT_LINK_KEY,
  LAST_STAFF_INVITE_LINK_KEY,
  LAST_VERIFY_LINK_KEY,
  makeRun,
  MockClass,
  MockCourse,
  MockDb,
  MockDoc,
  MockUser,
  uid,
} from './mock-db';
import { cancelMockRun } from './mock-tutor';

let dbInstance: MockDb | null = null;
export function getMockDb(): MockDb {
  dbInstance ??= new MockDb();
  return dbInstance;
}

interface Ctx {
  req: HttpRequest<unknown>;
  p: string[];
  db: MockDb;
  user: MockUser;
  body: Record<string, unknown>;
  query: (k: string) => string | null;
}
type Reply = { status?: number; body?: unknown; delay?: number } | Observable<HttpEvent<unknown>>;
type Handler = (ctx: Ctx) => Reply;
interface Route {
  method: string;
  re: RegExp;
  handler: Handler;
  anonymous?: boolean;
  roles?: string[];
}

class MockProblem {
  constructor(
    public status: number,
    public code: string,
    public title: string,
    public detail: string,
    public errors?: Record<string, string[]>,
  ) {}
}
const fail = (status: number, code: string, title: string, detail: string, errors?: Record<string, string[]>): never => {
  throw new MockProblem(status, code, title, detail, errors);
};
const notFound = (what = 'that'): never => fail(404, 'NOT_FOUND', 'Not found', `We couldn’t find ${what}.`);

const routes: Route[] = [];
const on = (method: string, path: string, handler: Handler, opts: { anonymous?: boolean; roles?: string[] } = {}) =>
  routes.push({ method, re: new RegExp(`^/api/v1/${path.replace(/:\w+/g, '([^/]+)')}$`), handler, ...opts });

const activeCourse = (c: Ctx) => c.query('courseId') || c.user.prefs.activeCourseId || COURSE_ID;
/** Students only reach courses they may see (§11.1); others get 404 like the API. */
const visibleCourse = (c: Ctx, courseId: string) => (c.db.canSeeCourse(c.user.id, courseId) ? courseId : notFound('that course'));
/** Instructor endpoints: the user must teach the course (or be Admin). */
const taughtCourse = (c: Ctx, courseId: string): MockCourse => {
  const course = c.db.s.courses.find((x) => x.id === courseId);
  if (!course || !c.db.courseRole(c.user.id, courseId)) notFound('that course');
  return course!;
};
const taughtClass = (c: Ctx, classId: string): MockClass => {
  const cls = c.db.s.classes.find((x) => x.id === classId);
  if (!cls || !c.db.courseRole(c.user.id, cls.courseId)) notFound('that class');
  return cls!;
};
const lc = (s: unknown) => String(s ?? '').trim().toLowerCase();
const maskEmail = (email: string) => {
  const [name, domain] = email.split('@');
  return `${name.slice(0, 1)}${'•'.repeat(Math.max(2, Math.min(6, name.length - 1)))}@${domain ?? ''}`;
};
const store = (key: string, value: string) => {
  try {
    sessionStorage.setItem(key, value);
  } catch {
    /* ignore */
  }
};
const yearsOld = (dob: string) => {
  const [y, m, d] = dob.split('-').map(Number);
  const t = new Date();
  let age = t.getFullYear() - y;
  if (t.getMonth() + 1 < m || (t.getMonth() + 1 === m && t.getDate() < d)) age--;
  return age;
};
const attemptOf = (c: Ctx, id: string) => c.db.s.attempts.find((a) => a.id === id && a.userId === c.user.id) ?? notFound('that quiz');
const docOf = (c: Ctx, id: string): MockDoc => c.db.s.docs.find((d) => d.id === id && d.ownerId === c.user.id) ?? notFound('that file');

// ---------------- auth & me
on('GET', 'auth/csrf', () => {
  document.cookie = `XSRF-TOKEN=mock-${hex(8)}; path=/; SameSite=Lax`;
  return { status: 204 };
}, { anonymous: true });
on('GET', 'auth/me', (c) => ({ body: c.db.me(c.user) }));
on('POST', 'auth/login', (c) => {
  const email = String(c.body['email'] ?? '').toLowerCase();
  const u = c.db.s.users.find((x) => x.email.toLowerCase() === email && !x.deleted);
  const declined = c.db.s.users.find((x) => x.email.toLowerCase() === email && x.deleted && (x.consentStatus === 'declined' || x.consentStatus === 'withdrawn'));
  if (!u && declined) fail(403, 'AUTH_GUARDIAN_CONSENT_DECLINED', 'Guardian declined', 'Your parent or guardian didn’t approve this account, so it has been closed.');
  if (!u || c.body['password'] === 'wrong') fail(401, 'AUTH_INVALID_CREDENTIALS', 'Invalid credentials', 'That email and password don’t match.');
  if (c.db.isLocked(u!)) fail(423, 'AUTH_LOCKED_OUT', 'Locked', 'This account is locked. Try again later or contact your admin.');
  if (!u!.emailConfirmed) fail(403, 'AUTH_EMAIL_NOT_CONFIRMED', 'Email not verified', 'Please verify your email first — check your inbox.');
  if (u!.consentStatus === 'pending') fail(403, 'AUTH_GUARDIAN_CONSENT_PENDING', 'Waiting for a guardian', 'Your parent or guardian still needs to approve your account. We emailed them a link.');
  c.db.sessionUserId = u!.id;
  u!.lastActiveAt = new Date().toISOString();
  return { body: c.db.me(u!), delay: 500 };
}, { anonymous: true });
on('POST', 'auth/logout', (c) => {
  c.db.sessionUserId = null;
  return { status: 204 };
}, { anonymous: true });
on('POST', 'auth/register', (c) => {
  const email = String(c.body['email'] ?? '').trim();
  const password = String(c.body['password'] ?? '');
  const dob = String(c.body['dateOfBirth'] ?? '');
  const guardianEmail = String(c.body['guardianEmail'] ?? '').trim();
  const staffToken = c.body['staffInviteToken'] ? String(c.body['staffInviteToken']) : null;
  if (c.db.s.users.some((u) => u.email.toLowerCase() === email.toLowerCase())) fail(409, 'AUTH_EMAIL_TAKEN', 'Email taken', 'An account with this email already exists.');
  if (password.length < 10 || !/\d/.test(password) || !/[a-z]/i.test(password)) fail(400, 'VALIDATION_FAILED', 'Validation failed', 'Please check the highlighted fields.', { password: ['Use at least 10 characters with a letter and a number.'] });
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dob)) fail(400, 'VALIDATION_FAILED', 'Validation failed', 'Please check the highlighted fields.', { dateOfBirth: ['Enter your date of birth.'] });
  const age = yearsOld(dob);
  if (age < 8) fail(400, 'AUTH_TOO_YOUNG', 'Too young', 'Sathi is for learners aged 8 and over.');
  const minor = age < 18;
  if (minor && (!guardianEmail || lc(guardianEmail) === lc(email))) {
    fail(400, 'VALIDATION_FAILED', 'Validation failed', 'Please check the highlighted fields.', { guardianEmail: [guardianEmail ? 'Use your parent’s or guardian’s own email, not yours.' : 'Enter your parent’s or guardian’s email.'] });
  }
  let roles: MockUser['roles'] = ['Student'];
  const invite = staffToken ? c.db.s.staffInvites.find((x) => x.token === staffToken) : null;
  if (staffToken) {
    if (!invite || invite.revokedAt || invite.acceptedAt || Date.parse(invite.expiresAt) < Date.now()) fail(410, 'STAFF_INVITE_INVALID', 'Invite invalid', 'This invite link is no longer valid. Ask an admin for a new one.');
    if (lc(invite!.email) !== lc(email)) fail(400, 'VALIDATION_FAILED', 'Validation failed', 'Please check the highlighted fields.', { email: ['Use the email address this invite was sent to.'] });
    roles = invite!.role === 'Admin' ? ['Student', 'Instructor', 'Admin'] : ['Student', 'Instructor'];
  }
  const id = uid();
  const now = new Date().toISOString();
  c.db.s.users.push({ id, email, displayName: String(c.body['displayName'] ?? 'Student'), roles, emailConfirmed: false, onboardingCompletedAt: null, streakDays: 0, dateOfBirth: dob, isMinor: minor, guardianEmail: minor ? guardianEmail : null, consentStatus: minor ? 'pending' : 'not_required', createdAt: now, lastActiveAt: null, prefs: { level: 'beginner', timezone: 'Asia/Kolkata', reminderHour: 18, remindersEnabled: true, activeCourseId: null } });
  if (invite) {
    invite.acceptedAt = now;
    if (invite.courseId) c.db.s.courseInstructors.push({ courseId: invite.courseId, userId: id, role: 'instructor', addedAt: now });
  }
  store(LAST_VERIFY_LINK_KEY, `/auth/verify-email?userId=${id}&token=mock-token`);
  if (minor) {
    const token = `consent-${hex(6)}`;
    c.db.s.consents.push({ id: uid(), userId: id, guardianEmail, token, requestedAt: now, expiresAt: new Date(Date.now() + 7 * DAY_MS).toISOString(), decidedAt: null, decision: null });
    store(LAST_CONSENT_LINK_KEY, `/consent/${token}`);
  }
  return { status: 202, body: { message: 'Check your email' }, delay: 600 };
}, { anonymous: true });
on('POST', 'auth/verify-email', (c) => {
  const u = c.db.s.users.find((x) => x.id === c.body['userId']);
  if (!u || c.body['token'] !== 'mock-token') fail(400, 'AUTH_INVALID_TOKEN', 'Invalid token', 'This link has expired or was already used.');
  u!.emailConfirmed = true;
  return { status: 204, delay: 700 };
}, { anonymous: true });
on('POST', 'auth/resend-verification', () => ({ status: 202 }), { anonymous: true });
on('POST', 'auth/resend-guardian-consent', () => ({ status: 202, delay: 500 }), { anonymous: true });
on('POST', 'auth/forgot-password', () => ({ status: 202, delay: 500 }), { anonymous: true });
on('POST', 'auth/reset-password', (c) => {
  if (c.body['token'] === 'expired' || !c.body['token']) fail(400, 'AUTH_INVALID_TOKEN', 'Invalid token', 'This link has expired or was already used.');
  return { status: 204 };
}, { anonymous: true });
on('PUT', 'me/preferences', (c) => {
  const b = c.body as PreferencesUpdate;
  const p = c.user.prefs;
  if (b.level) p.level = b.level;
  if (b.timezone) p.timezone = b.timezone;
  if (typeof b.reminderHour === 'number') p.reminderHour = clamp(Math.round(b.reminderHour), 0, 23);
  if (typeof b.remindersEnabled === 'boolean') p.remindersEnabled = b.remindersEnabled;
  if (b.activeCourseId !== undefined) p.activeCourseId = b.activeCourseId;
  return { body: c.db.me(c.user) };
});
on('DELETE', 'me', (c) => {
  if (!c.body['password'] || c.body['password'] === 'wrong') fail(401, 'AUTH_INVALID_CREDENTIALS', 'Invalid credentials', 'That password isn’t right.');
  c.user.deleted = true;
  c.db.sessionUserId = null;
  return { status: 202, delay: 800 };
});

// ---------------- courses, lessons, home, progress
on('GET', 'courses', (c) => ({ body: c.db.courseSummaries(c.user.id) }));
on('GET', 'courses/:id', (c) => ({ body: c.db.courseDetail(visibleCourse(c, c.p[0]), c.user.id) ?? notFound('that course') }));
on('POST', 'courses/:id/enroll', (c) => {
  visibleCourse(c, c.p[0]);
  c.db.enroll(c.user.id, c.p[0]);
  return { body: c.db.courseSummary(c.p[0], c.user.id) };
});
on('GET', 'lessons/:id', (c) => {
  const courseId = c.db.courseOfLesson(c.p[0]);
  if (!courseId || !c.db.canSeeCourse(c.user.id, courseId)) notFound('that lesson');
  return { body: c.db.lesson(c.p[0], c.user.id) ?? notFound('that lesson'), delay: 450 };
});
on('POST', 'lessons/:id/progress', (c) => {
  c.db.setProgress(c.user.id, c.p[0], Number(c.body['percent'] ?? 0), !!c.body['completed']);
  return { status: 204 };
});
on('GET', 'home', (c) => {
  if (!c.query('courseId') && !c.user.prefs.activeCourseId) notFound('an active course');
  return { body: c.db.home(c.user.id, visibleCourse(c, activeCourse(c))) ?? notFound('that course'), delay: 650 };
});
on('GET', 'progress', (c) => ({ body: c.db.progressOverview(c.user.id, activeCourse(c)), delay: 550 }));

// ---------------- tutor
on('GET', 'conversations', (c) => {
  const courseId = c.query('courseId');
  const limit = clamp(Number(c.query('limit') ?? 20) || 20, 1, 50);
  const offset = Math.max(0, Number(c.query('cursor') ?? 0) || 0);
  const all = c.db.s.conversations
    .filter((x) => x.userId === c.user.id && (!courseId || x.courseId === courseId))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .map((x) => ({ id: x.id, title: x.title, courseId: x.courseId, lessonId: x.lessonId, updatedAt: x.updatedAt, lastMessagePreview: (x.messages[x.messages.length - 1]?.content ?? '').replace(/[$[\]\\]/g, '').slice(0, 90) }));
  const items = all.slice(offset, offset + limit);
  return { body: { items, nextCursor: offset + limit < all.length ? String(offset + limit) : null }, delay: offset ? 500 : undefined };
});
on('POST', 'conversations', (c) => {
  const lessonId = (c.body['lessonId'] as string) ?? null;
  const conv = { id: uid(), userId: c.user.id, courseId: String(c.body['courseId']), lessonId, title: 'New conversation', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), messages: [] };
  c.db.s.conversations.push(conv);
  return { status: 201, body: { id: conv.id, title: conv.title, courseId: conv.courseId, lessonId, createdAt: conv.createdAt } };
});
on('GET', 'conversations/:id', (c) => {
  const conv = c.db.s.conversations.find((x) => x.id === c.p[0] && x.userId === c.user.id) ?? notFound('that conversation');
  // §11.5 stale streams: still `streaming` 3+ minutes after creation → failed / STREAM_INTERRUPTED.
  for (const m of conv.messages) {
    if (m.status === 'streaming' && Date.now() - Date.parse(m.createdAt) > 3 * 60_000) Object.assign(m, { status: 'failed', errorCode: 'STREAM_INTERRUPTED' });
  }
  const lessonTitle = conv.lessonId ? (c.db.s.lessons.find((l) => l.id === conv.lessonId)?.title ?? null) : null;
  return { body: { id: conv.id, title: conv.title, courseId: conv.courseId, lessonId: conv.lessonId, lessonTitle, messages: conv.messages } };
});
on('POST', 'conversations/:id/messages/:mid/cancel', (c) => {
  const conv = c.db.s.conversations.find((x) => x.id === c.p[0] && x.userId === c.user.id) ?? notFound('that conversation');
  const m = conv.messages.find((x) => x.id === c.p[1]) ?? notFound('that message');
  // Active here → the stream's own handler saves the text so far as `cancelled`. Otherwise mark it directly.
  if (!cancelMockRun(m.id) && m.status === 'streaming') m.status = 'cancelled';
  return { status: 202, delay: 150 };
});
on('DELETE', 'conversations/:id', (c) => {
  c.db.s.conversations = c.db.s.conversations.filter((x) => !(x.id === c.p[0] && x.userId === c.user.id));
  return { status: 204 };
});
on('POST', 'messages/:id/feedback', (c) => {
  for (const conv of c.db.s.conversations.filter((x) => x.userId === c.user.id)) {
    const m = conv.messages.find((x) => x.id === c.p[0]);
    if (m) {
      m.feedback = c.body['rating'] === -1 ? -1 : 1;
      return { status: 204 };
    }
  }
  return notFound('that message');
});

// ---------------- practice, diagnostic, revision
on('POST', 'courses/:id/diagnostic', (c) => ({ body: c.db.toAttempt(c.db.diagnostic(c.user.id, visibleCourse(c, c.p[0]))), delay: 700 }));
on('POST', 'practice/sessions', (c) => {
  const a = c.db.practice(c.user.id, String(c.body['courseId'] ?? activeCourse(c)), c.body['conceptId'] as string | undefined, c.body['lessonId'] as string | undefined, Number(c.body['count'] ?? 8));
  if (!a.questionIds.length) fail(404, 'NOT_FOUND', 'No questions', 'There are no published questions for this yet.');
  return { body: c.db.toAttempt(a), delay: 600 };
});
on('GET', 'attempts/:id', (c) => ({ body: c.db.toAttempt(attemptOf(c, c.p[0])) }));
on('POST', 'attempts/:id/answers', (c) => {
  const a = attemptOf(c, c.p[0]);
  const qid = String(c.body['questionId']);
  if (!a.questionIds.includes(qid)) notFound('that question');
  return { body: c.db.answer(a, qid, c.body['selectedOptionId'] as string | undefined, c.body['freeText'] as string | undefined), delay: 500 };
});
on('GET', 'attempts/:id/answers/:aid', (c) => ({ body: c.db.pollAnswer(attemptOf(c, c.p[0]), c.p[1]) ?? notFound('that answer') }));
on('POST', 'attempts/:id/complete', (c) => ({ body: c.db.complete(attemptOf(c, c.p[0])), delay: 700 }));
on('GET', 'revision/due', (c) => {
  const cards = c.db.dueCards(c.user.id).map((card) => ({ cardId: card.id, dueAt: card.dueAt, question: c.db.toAttemptQuestion(c.db.s.questions.find((q) => q.id === card.questionId)!, 1) }));
  return { body: { dueCount: cards.length, cards } };
});
on('POST', 'revision/cards/:id/review', (c) => {
  const card = c.db.s.cards.find((x) => x.id === c.p[0] && x.userId === c.user.id) ?? notFound('that card');
  const q = c.db.s.questions.find((x) => x.id === card.questionId)!;
  const b = c.body as RevisionReviewRequest;
  const correct = q.options.find((o) => o.isCorrect)!;
  const isCorrect = b.selectedOptionId === correct.id;
  let quality = typeof b.quality === 'number' ? b.quality : isCorrect ? 4 : 1;
  if (!isCorrect) quality = Math.min(quality, 2);
  c.db.sm2(card, quality);
  c.db.updateMastery(c.user.id, q.conceptId, isCorrect ? 1 : 0, q.difficulty);
  return { body: { isCorrect, correctOptionId: correct.id!, explanation: q.explanation, nextDueAt: card.dueAt, intervalDays: card.interval }, delay: 400 };
});
on('GET', 'revision/schedule', (c) => {
  const days: { date: string; count: number }[] = [];
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  for (let i = 0; i < 14; i++) {
    const d0 = start.getTime() + i * 86_400_000;
    const count = c.db.s.cards.filter((x) => x.userId === c.user.id && (i === 0 ? Date.parse(x.dueAt) < d0 + 86_400_000 : Date.parse(x.dueAt) >= d0 && Date.parse(x.dueAt) < d0 + 86_400_000)).length;
    days.push({ date: new Date(d0).toISOString().slice(0, 10), count });
  }
  return { body: { days } };
});

// ---------------- documents
const ALLOWED = /\.(pdf|docx|md|txt)$/i;
on('GET', 'documents', (c) => ({ body: c.db.s.docs.filter((d) => d.ownerId === c.user.id).sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map((d) => c.db.publicDoc(d)) }));
on('GET', 'documents/:id', (c) => {
  const d = docOf(c, c.p[0]);
  c.db.advanceDoc(d);
  return { body: c.db.publicDoc(d) };
});
on('POST', 'documents', (c) => {
  const file = c.req.body instanceof FormData ? (c.req.body.get('file') as File | null) : null;
  if (!file) fail(400, 'VALIDATION_FAILED', 'Validation failed', 'Choose a file to upload.');
  if (!ALLOWED.test(file!.name)) fail(415, 'UPLOAD_INVALID_TYPE', 'Unsupported file type', 'That file type isn’t supported. Use PDF, Word, Markdown or text.');
  if (file!.size > 26_214_400) fail(413, 'UPLOAD_TOO_LARGE', 'File too large', 'That file is larger than 25 MB.');
  const t = new Date().toISOString();
  const doc: MockDoc = { id: uid(), ownerId: c.user.id, fileName: file!.name, sizeBytes: file!.size, contentType: file!.type || 'application/octet-stream', status: 'queued', stage: 'queued', progressPercent: 5, passageCount: null, errorCode: null, errorMessage: null, referenceId: null, createdAt: t, updatedAt: t, polls: 0, failAt: /scan/i.test(file!.name) ? 'parsing' : null };
  c.db.s.docs.push(doc);
  c.db.save();
  const total = Math.max(file!.size, 1);
  const steps = [0.15, 0.4, 0.7, 1];
  return concat(
    of<HttpEvent<unknown>>({ type: HttpEventType.Sent }),
    ...steps.map((f, i) => timer(i === 0 ? 150 : 280).pipe(map((): HttpEvent<unknown> => ({ type: HttpEventType.UploadProgress, loaded: Math.round(total * f), total })))),
    timer(250).pipe(map(() => new HttpResponse({ status: 202, body: c.db.publicDoc(doc), url: c.req.url }))),
  );
});
on('POST', 'documents/:id/retry', (c) => {
  const d = docOf(c, c.p[0]);
  Object.assign(d, { status: 'queued', stage: 'queued', progressPercent: 5, errorCode: null, errorMessage: null, referenceId: null, polls: 0, failAt: null, updatedAt: new Date().toISOString() });
  return { status: 202, body: c.db.publicDoc(d) };
});
on('DELETE', 'documents/:id', (c) => {
  docOf(c, c.p[0]);
  c.db.s.docs = c.db.s.docs.filter((d) => d.id !== c.p[0]);
  return { status: 204 };
});

// ---------------- instructor
const STAFF = ['Instructor', 'Admin'];
const validateCourse = (c: Ctx, b: CourseUpsert, id: string | null) => {
  const errors: Record<string, string[]> = {};
  if (!b.title?.trim()) errors['title'] = ['Give the course a title.'];
  if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(b.slug ?? '')) errors['slug'] = ['Use lower-case letters, numbers and dashes.'];
  else if (c.db.s.courses.some((x) => x.slug === b.slug && x.id !== id)) errors['slug'] = ['Another course already uses this URL slug.'];
  if (Object.keys(errors).length) fail(400, 'VALIDATION_FAILED', 'Validation failed', 'Please check the highlighted fields.', errors);
};
on('GET', 'instructor/courses', (c) => ({ body: c.db.s.courses.filter((x) => c.db.courseRole(c.user.id, x.id)).map((x) => c.db.instructorCourse(x, c.user.id)) }), { roles: STAFF });
on('POST', 'instructor/courses', (c) => {
  const b = c.body as unknown as CourseUpsert;
  validateCourse(c, b, null);
  const course: MockCourse = { id: uid(), slug: b.slug, title: b.title.trim(), description: b.description ?? '', isPublished: !!b.isPublished, visibility: b.visibility === 'private' ? 'private' : 'public' };
  c.db.s.courses.push(course);
  c.db.s.courseInstructors.push({ courseId: course.id, userId: c.user.id, role: 'owner', addedAt: new Date().toISOString() });
  return { status: 201, body: c.db.instructorCourse(course, c.user.id), delay: 600 };
}, { roles: STAFF });
on('PUT', 'instructor/courses/:id', (c) => {
  const course = taughtCourse(c, c.p[0]);
  const b = c.body as unknown as CourseUpsert;
  validateCourse(c, b, course.id);
  Object.assign(course, { slug: b.slug, title: b.title.trim(), description: b.description ?? '', isPublished: !!b.isPublished, visibility: b.visibility === 'private' ? 'private' : 'public' });
  return { body: c.db.instructorCourse(course, c.user.id) };
}, { roles: STAFF });
on('DELETE', 'instructor/courses/:id', (c) => {
  const course = taughtCourse(c, c.p[0]);
  if (c.db.studentsOf(course.id).length) fail(409, 'COURSE_HAS_STUDENTS', 'Course has students', 'Students are enrolled in this course, so it can’t be deleted. Unpublish it instead.');
  c.db.s.courses = c.db.s.courses.filter((x) => x.id !== course.id);
  c.db.s.courseInstructors = c.db.s.courseInstructors.filter((x) => x.courseId !== course.id);
  c.db.s.classes = c.db.s.classes.filter((x) => x.courseId !== course.id);
  return { status: 204, delay: 500 };
}, { roles: STAFF });

// §11.1 co-instructors
const instructorRow = (c: Ctx, courseId: string) =>
  c.db.s.courseInstructors
    .filter((x) => x.courseId === courseId)
    .map((x) => {
      const u = c.db.user(x.userId)!;
      return { userId: x.userId, displayName: u.displayName, email: u.email, role: x.role, addedAt: x.addedAt };
    })
    .sort((a, b) => (a.role === b.role ? a.displayName.localeCompare(b.displayName) : a.role === 'owner' ? -1 : 1));
on('GET', 'instructor/courses/:id/instructors', (c) => ({ body: instructorRow(c, taughtCourse(c, c.p[0]).id) }), { roles: STAFF });
on('POST', 'instructor/courses/:id/instructors', (c) => {
  const course = taughtCourse(c, c.p[0]);
  const role = c.db.courseRole(c.user.id, course.id);
  if (role !== 'owner' && role !== 'admin') fail(403, 'AUTH_FORBIDDEN', 'Forbidden', 'Only the course owner or an admin can add instructors.');
  const u = c.db.s.users.find((x) => lc(x.email) === lc(c.body['email']) && !x.deleted);
  if (!u) fail(404, 'USER_NOT_FOUND', 'User not found', 'There’s no Sathi account with that email.');
  if (!u!.roles.includes('Instructor')) fail(409, 'USER_NOT_INSTRUCTOR', 'Not an instructor', 'That person doesn’t have the Instructor role yet. Ask an admin to grant it first.');
  if (!c.db.s.courseInstructors.some((x) => x.courseId === course.id && x.userId === u!.id)) {
    c.db.s.courseInstructors.push({ courseId: course.id, userId: u!.id, role: 'instructor', addedAt: new Date().toISOString() });
  }
  return { status: 201 };
}, { roles: STAFF });
on('DELETE', 'instructor/courses/:id/instructors/:uid', (c) => {
  const course = taughtCourse(c, c.p[0]);
  const row = c.db.s.courseInstructors.find((x) => x.courseId === course.id && x.userId === c.p[1]) ?? notFound('that instructor');
  if (row.role === 'owner' && c.db.s.courseInstructors.filter((x) => x.courseId === course.id && x.role === 'owner').length <= 1) {
    fail(409, 'COURSE_LAST_OWNER', 'Last owner', 'Every course needs at least one owner. Make someone else an owner first.');
  }
  c.db.s.courseInstructors = c.db.s.courseInstructors.filter((x) => x !== row);
  return { status: 204 };
}, { roles: STAFF });

// §11.1 classes (instructor)
on('GET', 'instructor/courses/:id/classes', (c) => {
  const course = taughtCourse(c, c.p[0]);
  const list = c.db.s.classes.filter((x) => x.courseId === course.id).sort((a, b) => (!!a.archivedAt === !!b.archivedAt ? b.createdAt.localeCompare(a.createdAt) : a.archivedAt ? 1 : -1));
  return { body: list.map((x) => c.db.classSummary(x)) };
}, { roles: STAFF });
on('POST', 'instructor/courses/:id/classes', (c) => {
  const course = taughtCourse(c, c.p[0]);
  const name = String(c.body['name'] ?? '').trim();
  if (!name) fail(400, 'VALIDATION_FAILED', 'Validation failed', 'Please check the highlighted fields.', { name: ['Give the class a name.'] });
  const cls: MockClass = { id: uid(), courseId: course.id, name, description: String(c.body['description'] ?? '').trim() || null, joinCode: c.db.newJoinCode(), joinEnabled: true, createdBy: c.user.id, createdAt: new Date().toISOString(), archivedAt: null };
  c.db.s.classes.push(cls);
  return { status: 201, body: c.db.classSummary(cls), delay: 500 };
}, { roles: STAFF });
on('PUT', 'instructor/classes/:id', (c) => {
  const cls = taughtClass(c, c.p[0]);
  const name = String(c.body['name'] ?? '').trim();
  if (!name) fail(400, 'VALIDATION_FAILED', 'Validation failed', 'Please check the highlighted fields.', { name: ['Give the class a name.'] });
  Object.assign(cls, { name, description: (c.body['description'] as string | null) ?? null, joinEnabled: !!c.body['joinEnabled'] });
  return { body: c.db.classSummary(cls) };
}, { roles: STAFF });
on('POST', 'instructor/classes/:id/regenerate-code', (c) => {
  const cls = taughtClass(c, c.p[0]);
  cls.joinCode = c.db.newJoinCode();
  return { body: c.db.classSummary(cls), delay: 400 };
}, { roles: STAFF });
on('POST', 'instructor/classes/:id/archive', (c) => {
  const cls = taughtClass(c, c.p[0]);
  cls.archivedAt ??= new Date().toISOString();
  return { body: c.db.classSummary(cls) };
}, { roles: STAFF });
on('POST', 'instructor/classes/:id/unarchive', (c) => {
  const cls = taughtClass(c, c.p[0]);
  cls.archivedAt = null;
  return { body: c.db.classSummary(cls) };
}, { roles: STAFF });
on('GET', 'instructor/classes/:id/members', (c) => {
  const cls = taughtClass(c, c.p[0]);
  const body = c.db.s.members
    .filter((m) => m.classId === cls.id && !m.removedAt)
    .map((m) => {
      const u = c.db.user(m.userId)!;
      const rows = c.db.masteryList(u.id, cls.courseId).filter((x) => x.attempts > 0);
      return { userId: u.id, displayName: u.displayName, email: u.email, joinedAt: m.joinedAt, joinedVia: m.joinedVia, lastActiveAt: u.lastActiveAt ?? null, averageMastery: rows.length ? rows.reduce((s, x) => s + x.mastery, 0) / rows.length : null };
    })
    .sort((a, b) => a.displayName.localeCompare(b.displayName));
  return { body, delay: 450 };
}, { roles: STAFF });
on('DELETE', 'instructor/classes/:id/members/:uid', (c) => {
  const cls = taughtClass(c, c.p[0]);
  const m = c.db.s.members.find((x) => x.classId === cls.id && x.userId === c.p[1] && !x.removedAt) ?? notFound('that student');
  m.removedAt = new Date().toISOString();
  return { status: 204 };
}, { roles: STAFF });
on('POST', 'instructor/classes/:id/invites', (c) => {
  const cls = taughtClass(c, c.p[0]);
  const emails = (c.body['emails'] as string[] | undefined) ?? [];
  if (emails.length > 100) fail(400, 'VALIDATION_FAILED', 'Validation failed', 'Invite at most 100 people at a time.', { emails: ['Invite at most 100 people at a time.'] });
  const result = { invited: 0, alreadyMembers: [] as string[], invalid: [] as string[] };
  for (const raw of emails) {
    const email = String(raw).trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) {
      result.invalid.push(email);
      continue;
    }
    const u = c.db.s.users.find((x) => lc(x.email) === lc(email));
    if (u && c.db.s.members.some((m) => m.classId === cls.id && m.userId === u.id && !m.removedAt)) {
      result.alreadyMembers.push(email);
      continue;
    }
    // One live invite per (class, email): re-inviting refreshes it.
    const live = c.db.s.invites.find((i) => i.classId === cls.id && lc(i.email) === lc(email) && !i.acceptedAt && !i.revokedAt);
    const now = Date.now();
    if (live) Object.assign(live, { createdAt: new Date(now).toISOString(), expiresAt: new Date(now + 14 * DAY_MS).toISOString() });
    else {
      const token = `inv-${hex(8)}`;
      c.db.s.invites.push({ id: uid(), classId: cls.id, email, token, invitedBy: c.user.id, createdAt: new Date(now).toISOString(), expiresAt: new Date(now + 14 * DAY_MS).toISOString(), acceptedAt: null, revokedAt: null });
      store(LAST_CLASS_INVITE_LINK_KEY, `/join/${token}`);
    }
    result.invited++;
  }
  return { body: result, delay: 700 };
}, { roles: STAFF });
on('GET', 'instructor/classes/:id/invites', (c) => {
  const cls = taughtClass(c, c.p[0]);
  const body = c.db.s.invites
    .filter((i) => i.classId === cls.id && !i.acceptedAt)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .map((i) => ({ id: i.id, email: i.email, createdAt: i.createdAt, expiresAt: i.expiresAt, status: c.db.inviteStatus(i) }));
  return { body };
}, { roles: STAFF });
on('DELETE', 'instructor/invites/:id', (c) => {
  const inv = c.db.s.invites.find((i) => i.id === c.p[0]) ?? notFound('that invite');
  taughtClass(c, inv.classId);
  inv.revokedAt = new Date().toISOString();
  return { status: 204 };
}, { roles: STAFF });
on('POST', 'instructor/invites/:id/resend', (c) => {
  const inv = c.db.s.invites.find((i) => i.id === c.p[0]) ?? notFound('that invite');
  taughtClass(c, inv.classId);
  Object.assign(inv, { revokedAt: null, createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 14 * DAY_MS).toISOString() });
  store(LAST_CLASS_INVITE_LINK_KEY, `/join/${inv.token}`);
  return { status: 204, delay: 400 };
}, { roles: STAFF });
on('POST', 'instructor/courses/:id/modules', (c) => {
  const b = c.body as unknown as ModuleUpsert;
  const mod = { id: uid(), courseId: c.p[0], title: b.title, summary: b.summary, position: b.position };
  c.db.s.modules.push(mod);
  return { status: 201, body: { ...mod, lessons: [] } };
}, { roles: STAFF });
on('PUT', 'instructor/modules/:id', (c) => {
  const mod = c.db.s.modules.find((x) => x.id === c.p[0]) ?? notFound('that module');
  Object.assign(mod, c.body as unknown as ModuleUpsert);
  return { body: { ...mod, lessons: [] } };
}, { roles: STAFF });
on('DELETE', 'instructor/modules/:id', (c) => {
  c.db.s.modules = c.db.s.modules.filter((x) => x.id !== c.p[0]);
  c.db.s.lessons = c.db.s.lessons.filter((x) => x.moduleId !== c.p[0]);
  return { status: 204 };
}, { roles: STAFF });
on('POST', 'instructor/modules/:id/lessons', (c) => {
  const b = c.body as unknown as LessonUpsert;
  const id = uid();
  c.db.s.lessons.push({ id, moduleId: c.p[0], title: b.title, summary: b.summary, contentMarkdown: b.contentMarkdown, estimatedMinutes: b.estimatedMinutes, position: b.position, conceptIds: b.conceptIds, objectives: b.objectives });
  return { status: 201, body: { id } };
}, { roles: STAFF });
on('PUT', 'instructor/lessons/:id', (c) => {
  const l = c.db.s.lessons.find((x) => x.id === c.p[0]) ?? notFound('that lesson');
  const b = c.body as unknown as LessonUpsert;
  Object.assign(l, { title: b.title, summary: b.summary, contentMarkdown: b.contentMarkdown, estimatedMinutes: b.estimatedMinutes, position: b.position, conceptIds: b.conceptIds, objectives: b.objectives });
  return { body: { id: l.id }, delay: 600 };
}, { roles: STAFF });
on('DELETE', 'instructor/lessons/:id', (c) => {
  c.db.s.lessons = c.db.s.lessons.filter((x) => x.id !== c.p[0]);
  return { status: 204 };
}, { roles: STAFF });
on('POST', 'instructor/courses/:id/concepts', (c) => {
  const b = c.body as unknown as ConceptUpsert;
  const concept = { id: uid(), courseId: c.p[0], slug: b.slug, name: b.name, description: b.description, prerequisiteIds: b.prerequisiteIds ?? [] };
  c.db.s.concepts.push(concept);
  return { status: 201, body: { id: concept.id, slug: concept.slug, name: concept.name, description: concept.description } };
}, { roles: STAFF });
on('PUT', 'instructor/concepts/:id', (c) => {
  const concept = c.db.s.concepts.find((x) => x.id === c.p[0]) ?? notFound('that concept');
  Object.assign(concept, c.body as unknown as ConceptUpsert);
  return { body: { id: concept.id, slug: concept.slug, name: concept.name, description: concept.description } };
}, { roles: STAFF });
on('GET', 'instructor/questions', (c) => {
  const status = c.query('status');
  const conceptId = c.query('conceptId');
  const items = c.db.s.questions.filter((q) => q.courseId === (c.query('courseId') ?? COURSE_ID) && (!status || q.status === status) && (!conceptId || q.conceptId === conceptId));
  return { body: [...items].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)) };
}, { roles: STAFF });
const upsertQuestion = (c: Ctx, existing?: InstructorQuestion): InstructorQuestion => {
  const b = c.body as unknown as QuestionUpsert;
  const q: InstructorQuestion = {
    id: existing?.id ?? uid(), courseId: existing?.courseId ?? COURSE_ID, conceptId: b.conceptId, conceptName: c.db.conceptName(b.conceptId), lessonId: b.lessonId ?? null, type: b.type, stem: b.stem, explanation: b.explanation, difficulty: b.difficulty,
    source: existing?.source ?? 'instructor', status: b.status, isDiagnostic: b.isDiagnostic, options: b.options.map((o, i) => ({ id: existing?.options[i]?.id ?? uid(), ...o })), rubric: b.rubric ?? null, updatedAt: new Date().toISOString(),
  };
  return q;
};
on('POST', 'instructor/questions', (c) => {
  const q = upsertQuestion(c);
  c.db.s.questions.push(q);
  return { status: 201, body: q };
}, { roles: STAFF });
on('PUT', 'instructor/questions/:id', (c) => {
  const idx = c.db.s.questions.findIndex((x) => x.id === c.p[0]);
  if (idx < 0) notFound('that question');
  const q = upsertQuestion(c, c.db.s.questions[idx]);
  c.db.s.questions[idx] = q;
  return { body: q };
}, { roles: STAFF });
on('POST', 'instructor/questions/generate', (c) => {
  const b = c.body as unknown as GenerateQuestionsRequest;
  const run = makeRun('quiz_generation', null, Date.now());
  c.db.s.runs.unshift(run);
  const name = c.db.conceptName(b.conceptId);
  for (let i = 0; i < Math.min(b.count, 10); i++) {
    c.db.s.questions.push({
      id: uid(), courseId: b.courseId, conceptId: b.conceptId, conceptName: name, lessonId: null, type: 'mcq', stem: `[Draft ${i + 1}] Which statement about ${name.toLowerCase()} is most accurate?`, explanation: `Generated from the course passages on ${name.toLowerCase()}. Review before publishing.`, difficulty: b.difficulty, source: 'generated', status: 'draft', isDiagnostic: false,
      options: ['It is computed from the course material', 'It never changes during training', 'It only applies to images', 'It requires labelled data at inference'].map((text, j) => ({ id: uid(), label: 'ABCD'[j], text, isCorrect: j === 0 })), rubric: null, updatedAt: new Date(Date.now() + 1000).toISOString(),
    });
  }
  return { status: 202, body: { runId: run.run.id, referenceId: run.run.referenceId }, delay: 900 };
}, { roles: STAFF });
on('GET', 'instructor/grading-queue', (c) => {
  const courseId = taughtCourse(c, c.query('courseId') ?? COURSE_ID).id;
  return { body: c.db.gradingQueue(courseId, c.query('classId')), delay: 500 };
}, { roles: STAFF });
on('POST', 'instructor/grading/:id/review', (c) => {
  const g = c.db.s.gradings.find((x) => x.id === c.p[0]) ?? notFound('that answer');
  const b = c.body as unknown as GradingReview;
  g.status = 'reviewed';
  const attempt = c.db.s.attempts.find((a) => a.id === g.attemptId);
  const ans = attempt?.answers.find((x) => x.answerId === g.answerId);
  if (ans && attempt) {
    const q = c.db.s.questions.find((x) => x.id === ans.questionId)!;
    const ch = c.db.updateMastery(attempt.userId, q.conceptId, b.finalScore / g.maxScore, q.difficulty);
    ans.isCorrect = b.finalScore / g.maxScore >= 0.5;
    ans.mastery = { conceptId: q.conceptId, name: q.conceptName, before: ch.before, after: ch.after };
    ans.grading = { status: 'reviewed', score: b.finalScore, maxScore: g.maxScore, feedback: b.feedback };
  }
  return { status: 204 };
}, { roles: STAFF });
on('GET', 'instructor/insights', (c) => {
  const courseId = taughtCourse(c, c.query('courseId') ?? COURSE_ID).id;
  const classId = c.query('classId');
  const cls = classId ? taughtClass(c, classId) : null;
  // Whole course: the seeded headline numbers. One class: scaled to its members.
  const enrolled = cls ? c.db.classSummary(cls).memberCount : courseId === COURSE_ID ? 48 : c.db.studentsOf(courseId).length;
  const f = courseId === COURSE_ID && !cls ? 1 : enrolled / 48;
  return {
    body: {
      enrolled, activeLast7Days: Math.round(31 * f), questionsAsked7Days: Math.round(412 * f), helpfulRate: enrolled ? 0.86 : null,
      conceptMastery: c.db.s.concepts.filter((x) => x.courseId === courseId).map((x, i) => ({ conceptId: x.id, name: x.name, averageMastery: [0.79, 0.71, 0.66, 0.58, 0.44, 0.39, 0.33, 0.52][i % 8] - (cls ? 0.04 : 0), studentsBelowHalf: Math.round([3, 6, 9, 14, 24, 27, 31, 18][i % 8] * f) })).sort((a, b) => a.averageMastery - b.averageMastery),
      pendingReviews: c.db.gradingQueue(courseId, classId).length,
    },
    delay: 600,
  };
}, { roles: STAFF });

// ---------------- admin
on('GET', 'admin/runs', (c) => {
  const status = c.query('status');
  const type = c.query('type');
  const items = c.db.s.runs
    .filter((r) => (!status || r.run.status === status) && (!type || r.run.type === type))
    .map((r) => ({ id: r.run.id, traceId: r.run.traceId, referenceId: r.run.referenceId, type: r.run.type, status: r.run.status, startedAt: r.run.startedAt, finishedAt: r.run.finishedAt, model: r.run.model, latencyMs: r.run.latencyMs, errorCode: r.run.errorCode }));
  return { body: { items, nextCursor: null }, delay: 400 };
}, { roles: ['Admin'] });
on('GET', 'admin/runs/lookup/:id', (c) => {
  const raw = decodeURIComponent(c.p[0]).trim();
  const ref = raw.replace('-', '').toUpperCase();
  const r = c.db.s.runs.find((x) => x.run.id === raw || x.run.traceId === raw.toLowerCase() || x.run.referenceId.replace('-', '') === ref);
  return { body: r ?? notFound(`a run with reference ${raw}`), delay: 650 };
}, { roles: ['Admin'] });
on('GET', 'admin/usage', (c) => {
  const days = Number(c.query('days') ?? 7);
  const out = Array.from({ length: days }, (_, i) => {
    const d = new Date(Date.now() - (days - 1 - i) * 86_400_000);
    const chat = [182, 205, 160, 241, 263, 198, 230][i % 7];
    return { date: d.toISOString().slice(0, 10), chatMessages: chat, webSearches: Math.round(chat * 0.18), uploads: [6, 9, 4, 12, 7, 5, 8][i % 7], inputTokens: chat * 2100, outputTokens: chat * 310, costUsd: Math.round(chat * 0.031 * 100) / 100 };
  });
  return { body: { days: out, activeUsers: 37 } };
}, { roles: ['Admin'] });
on('PUT', 'admin/debug-capture/:id', () => ({ status: 204 }), { roles: ['Admin'] });

// ---------------- §11.3 profile
on('PUT', 'me/profile', (c) => {
  const name = String(c.body['displayName'] ?? '').trim();
  if (!name || name.length > 60) fail(400, 'VALIDATION_FAILED', 'Validation failed', 'Please check the highlighted fields.', { displayName: ['Use 1–60 characters.'] });
  c.user.displayName = name;
  return { body: c.db.me(c.user), delay: 400 };
});

// ---------------- §11.1 classes (student)
const joinResult = (c: Ctx, cls: MockClass) => ({ classId: cls.id, className: cls.name, course: c.db.courseSummary(cls.courseId, c.user.id) });
on('POST', 'classes/join', (c) => {
  const code = String(c.body['code'] ?? '').toUpperCase().replace(/[\s-]/g, '');
  const cls = c.db.s.classes.find((x) => x.joinCode === code && !x.archivedAt);
  if (!cls) fail(404, 'CLASS_CODE_INVALID', 'Unknown code', 'We couldn’t find a class with that code. Check it with your teacher.');
  if (!cls!.joinEnabled) fail(409, 'CLASS_JOIN_DISABLED', 'Joining is off', 'This class isn’t accepting new students right now. Ask your teacher to turn joining on.');
  c.db.joinClass(c.user.id, cls!, 'code');
  return { body: joinResult(c, cls!), delay: 600 };
});
on('GET', 'classes/invites/:token', (c) => {
  const inv = c.db.s.invites.find((i) => i.token === c.p[0]) ?? notFound('that invite');
  const cls = c.db.s.classes.find((x) => x.id === inv.classId)!;
  const course = c.db.s.courses.find((x) => x.id === cls.courseId)!;
  const st = c.db.inviteStatus(inv);
  return { body: { className: cls.name, courseTitle: course.title, instructorName: c.db.user(inv.invitedBy)?.displayName ?? 'Your instructor', emailMasked: maskEmail(inv.email), status: st === 'pending' ? 'valid' : st } };
}, { anonymous: true });
on('POST', 'classes/invites/:token/accept', (c) => {
  const inv = c.db.s.invites.find((i) => i.token === c.p[0]) ?? notFound('that invite');
  const cls = c.db.s.classes.find((x) => x.id === inv.classId)!;
  const st = c.db.inviteStatus(inv);
  if (st === 'accepted' && inv.email && lc(inv.email) === lc(c.user.email)) return { body: joinResult(c, cls) };
  if (st === 'revoked' || st === 'accepted') notFound('that invite');
  if (st === 'expired') fail(410, 'CLASS_INVITE_EXPIRED', 'Invite expired', 'This invite has expired. Ask your teacher to send a new one.');
  if (lc(inv.email) !== lc(c.user.email)) fail(403, 'CLASS_INVITE_EMAIL_MISMATCH', 'Different email', 'This invite was sent to a different email address. Sign in with that address to accept it.');
  inv.acceptedAt = new Date().toISOString();
  c.db.joinClass(c.user.id, cls, 'invite');
  return { body: joinResult(c, cls), delay: 600 };
});
on('GET', 'me/classes', (c) => ({
  body: c.db.activeClassesOf(c.user.id).map((cls) => ({
    classId: cls.id, name: cls.name, course: { id: cls.courseId, title: c.db.s.courses.find((x) => x.id === cls.courseId)?.title ?? '' },
    joinedAt: c.db.s.members.find((m) => m.classId === cls.id && m.userId === c.user.id)!.joinedAt,
  })),
}));
on('DELETE', 'me/classes/:id', (c) => {
  const m = c.db.s.members.find((x) => x.classId === c.p[0] && x.userId === c.user.id && !x.removedAt) ?? notFound('that class');
  m.removedAt = new Date().toISOString();
  return { status: 204, delay: 400 };
});

// ---------------- §11.2 users, roles, staff invites
const ROLE_ORDER = ['Student', 'Instructor', 'Admin'] as const;
on('GET', 'admin/users', (c) => {
  const q = lc(c.query('query'));
  const role = c.query('role');
  const status = c.query('status');
  const limit = clamp(Number(c.query('limit') ?? 20) || 20, 1, 100);
  const offset = Math.max(0, Number(c.query('cursor') ?? 0) || 0);
  const all = c.db.s.users
    .map((u) => c.db.adminUser(u))
    .filter((u) => (!q || lc(u.email).includes(q) || lc(u.displayName).includes(q)) && (!role || u.roles.includes(role as never)))
    .filter((u) => !status || (status === 'locked' ? u.lockedOut : status === 'unverified' ? !u.emailConfirmed : u.accountStatus === status))
    .sort((a, b) => a.displayName.localeCompare(b.displayName));
  return { body: { items: all.slice(offset, offset + limit), nextCursor: offset + limit < all.length ? String(offset + limit) : null }, delay: 350 };
}, { roles: ['Admin'] });
on('GET', 'admin/users/:id', (c) => {
  const u = c.db.user(c.p[0]) ?? notFound('that user');
  const courses = c.db.s.courseInstructors.filter((x) => x.userId === u.id).map((x) => ({ id: x.courseId, title: c.db.s.courses.find((k) => k.id === x.courseId)?.title ?? '', role: x.role }));
  const classes = c.db.activeClassesOf(u.id).map((cls) => ({ id: cls.id, name: cls.name, courseTitle: c.db.s.courses.find((k) => k.id === cls.courseId)?.title ?? '' }));
  return { body: { ...c.db.adminUser(u), courses, classes }, delay: 350 };
}, { roles: ['Admin'] });
on('PUT', 'admin/users/:id/roles', (c) => {
  const u = c.db.user(c.p[0]) ?? notFound('that user');
  const roles = ROLE_ORDER.filter((r) => ((c.body['roles'] as string[] | undefined) ?? []).includes(r));
  if (!roles.length) fail(400, 'VALIDATION_FAILED', 'Validation failed', 'Choose at least one role.', { roles: ['Choose at least one role.'] });
  const losingAdmin = u.roles.includes('Admin') && !roles.includes('Admin');
  if (losingAdmin && u.id === c.user.id) fail(409, 'ROLE_SELF_DEMOTION', 'Self-demotion', 'You can’t remove your own Admin role. Ask another admin to do it.');
  if (losingAdmin && c.db.s.users.filter((x) => !x.deleted && x.roles.includes('Admin')).length <= 1) fail(409, 'ROLE_LAST_ADMIN', 'Last admin', 'Sathi needs at least one admin. Make someone else an admin first.');
  u.roles = [...roles];
  return { body: c.db.adminUser(u), delay: 450 };
}, { roles: ['Admin'] });
on('POST', 'admin/users/:id/lock', (c) => {
  const u = c.db.user(c.p[0]) ?? notFound('that user');
  if (u.id === c.user.id) fail(409, 'ROLE_SELF_DEMOTION', 'Self-lock', 'You can’t lock your own account.');
  const minutes = c.body['minutes'] as number | null | undefined;
  u.lockedUntil = new Date(minutes ? Date.now() + minutes * 60_000 : Date.parse('9999-12-31T00:00:00Z')).toISOString();
  return { status: 204, delay: 350 };
}, { roles: ['Admin'] });
on('POST', 'admin/users/:id/unlock', (c) => {
  const u = c.db.user(c.p[0]) ?? notFound('that user');
  u.lockedUntil = null;
  return { status: 204, delay: 350 };
}, { roles: ['Admin'] });
on('POST', 'admin/users/:id/resend-verification', (c) => {
  c.db.user(c.p[0]) ?? notFound('that user');
  return { status: 202, delay: 350 };
}, { roles: ['Admin'] });
const staffStatus = (i: { acceptedAt: string | null; revokedAt: string | null; expiresAt: string }) =>
  i.revokedAt ? 'revoked' : i.acceptedAt ? 'accepted' : Date.parse(i.expiresAt) < Date.now() ? 'expired' : 'pending';
on('POST', 'admin/staff-invites', (c) => {
  const email = String(c.body['email'] ?? '').trim();
  const role = c.body['role'] === 'Admin' ? 'Admin' : 'Instructor';
  const courseId = (c.body['courseId'] as string | undefined) || null;
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) fail(400, 'VALIDATION_FAILED', 'Validation failed', 'Please check the highlighted fields.', { email: ['Enter a valid email address.'] });
  if (courseId && !c.db.s.courses.some((x) => x.id === courseId)) notFound('that course');
  const token = `staff-${hex(8)}`;
  const inv = { id: uid(), email, role: role as 'Admin' | 'Instructor', courseId, token, invitedBy: c.user.id, createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 7 * DAY_MS).toISOString(), acceptedAt: null, revokedAt: null };
  c.db.s.staffInvites.unshift(inv);
  store(LAST_STAFF_INVITE_LINK_KEY, `/auth/register?staffInvite=${token}`);
  return { status: 201, body: { id: inv.id, email, role, courseId, expiresAt: inv.expiresAt }, delay: 500 };
}, { roles: ['Admin'] });
on('GET', 'admin/staff-invites', (c) => ({
  body: c.db.s.staffInvites.map((i) => ({ id: i.id, email: i.email, role: i.role, courseTitle: i.courseId ? (c.db.s.courses.find((k) => k.id === i.courseId)?.title ?? null) : null, createdAt: i.createdAt, expiresAt: i.expiresAt, status: staffStatus(i) })),
}), { roles: ['Admin'] });
on('DELETE', 'admin/staff-invites/:id', (c) => {
  const inv = c.db.s.staffInvites.find((i) => i.id === c.p[0]) ?? notFound('that invite');
  inv.revokedAt = new Date().toISOString();
  return { status: 204 };
}, { roles: ['Admin'] });
on('GET', 'auth/staff-invites/:token', (c) => {
  const inv = c.db.s.staffInvites.find((i) => i.token === c.p[0]);
  if (!inv) fail(410, 'STAFF_INVITE_INVALID', 'Invite invalid', 'This invite link is no longer valid. Ask an admin for a new one.');
  return { body: { emailMasked: maskEmail(inv!.email), role: inv!.role, courseTitle: inv!.courseId ? (c.db.s.courses.find((k) => k.id === inv!.courseId)?.title ?? null) : null, status: staffStatus(inv!) } };
}, { anonymous: true });
on('POST', 'auth/staff-invites/:token/accept', (c) => {
  const inv = c.db.s.staffInvites.find((i) => i.token === c.p[0]);
  if (!inv || staffStatus(inv) !== 'pending') fail(410, 'STAFF_INVITE_INVALID', 'Invite invalid', 'This invite link is no longer valid. Ask an admin for a new one.');
  if (lc(inv!.email) !== lc(c.user.email)) fail(403, 'AUTH_FORBIDDEN', 'Different email', 'This invite was sent to a different email address. Sign in with that address to accept it.');
  const add: MockUser['roles'] = inv!.role === 'Admin' ? ['Instructor', 'Admin'] : ['Instructor'];
  c.user.roles = ROLE_ORDER.filter((r) => c.user.roles.includes(r) || add.includes(r));
  inv!.acceptedAt = new Date().toISOString();
  if (inv!.courseId && !c.db.s.courseInstructors.some((x) => x.courseId === inv!.courseId && x.userId === c.user.id)) {
    c.db.s.courseInstructors.push({ courseId: inv!.courseId, userId: c.user.id, role: 'instructor', addedAt: inv!.acceptedAt });
  }
  return { body: c.db.me(c.user), delay: 500 };
});

// ---------------- §11.4 guardian consent
const DATA_WE_PROCESS = [
  'Name, email address and date of birth — to run the account and check age.',
  'Questions asked to the tutor and the answers — to explain topics and keep a history your child can revisit.',
  'Practice answers, quiz scores and topic mastery — to choose what to practise next.',
  'Notes your child uploads — only to answer their own questions; never shared with other learners.',
  'Basic usage logs (sign-ins, errors) — to keep Sathi secure and working.',
];
on('GET', 'guardian-consent/:token', (c) => {
  const gc = c.db.s.consents.find((x) => x.token === c.p[0]) ?? notFound('that consent request');
  const u = c.db.user(gc.userId)!;
  const status = gc.decision ?? (Date.parse(gc.expiresAt) < Date.now() ? 'expired' : 'pending');
  return { body: { learnerDisplayName: u.displayName, learnerEmailMasked: maskEmail(u.email), policyVersion: '2026-10', dataWeProcess: DATA_WE_PROCESS, status }, delay: 400 };
}, { anonymous: true });
on('POST', 'guardian-consent/:token', (c) => {
  const gc = c.db.s.consents.find((x) => x.token === c.p[0]) ?? notFound('that consent request');
  const decision = c.body['decision'] as 'granted' | 'declined' | 'withdrawn';
  const u = c.db.user(gc.userId)!;
  if (decision === 'withdrawn' && gc.decision !== 'granted') fail(409, 'CONFLICT', 'Nothing to withdraw', 'Consent hasn’t been given, so there is nothing to withdraw.');
  if (decision !== 'withdrawn' && gc.decision) fail(409, 'CONFLICT', 'Already decided', 'This request has already been answered.');
  if (decision !== 'withdrawn' && Date.parse(gc.expiresAt) < Date.now()) fail(410, 'AUTH_INVALID_TOKEN', 'Expired', 'This link has expired. Ask your child to send a new one from the sign-in page.');
  gc.decision = decision;
  gc.decidedAt = new Date().toISOString();
  u.consentStatus = decision;
  if (decision !== 'granted') {
    u.deleted = true;
    if (c.db.sessionUserId === u.id) c.db.sessionUserId = null;
  }
  return { status: 204, delay: 600 };
}, { anonymous: true });

// ---------------- client errors
on('POST', 'client-errors', (c) => {
  console.info('[mock] client error report', c.body);
  return { status: 204 };
}, { anonymous: true });

// ----------------------------------------------------------------- interceptor
function traceIdOf(req: HttpRequest<unknown>): string {
  return /^00-([0-9a-f]{32})-/.exec(req.headers.get('traceparent') ?? '')?.[1] ?? hex(16);
}
function problemError(req: HttpRequest<unknown>, p: MockProblem): HttpErrorResponse {
  const traceId = traceIdOf(req);
  const ref = traceId.slice(0, 8).toUpperCase();
  return new HttpErrorResponse({
    status: p.status,
    statusText: p.title,
    url: req.url,
    headers: new HttpHeaders({ 'Content-Type': 'application/problem+json', 'X-Trace-Id': traceId }),
    error: { type: `https://sathi.app/errors/${p.code.toLowerCase().replace(/_/g, '-')}`, title: p.title, status: p.status, detail: p.detail, code: p.code, traceId, referenceId: `${ref.slice(0, 4)}-${ref.slice(4)}`, ...(p.errors ? { errors: p.errors } : {}) },
  });
}
function readList(key: string): string[] {
  try {
    return (sessionStorage.getItem(key) ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  } catch {
    return [];
  }
}

export const mockApiInterceptor: HttpInterceptorFn = (req, next) => {
  if (!req.url.startsWith('/api/v1/')) return next(req);
  const db = getMockDb();
  const path = req.url.split('?')[0];
  const latency = () => 220 + Math.random() * 280;

  // Test hooks: sessionStorage "sathi.mock.fail" = comma-separated URL fragments that answer 503.
  if (readList('sathi.mock.fail').some((f) => path.includes(f))) {
    return timer(latency()).pipe(mergeMap(() => throwError(() => problemError(req, new MockProblem(503, 'AI_SERVICE_UNAVAILABLE', 'Service unavailable', 'Sathi is having trouble right now. Please try again in a moment.')))));
  }

  for (const route of routes) {
    if (route.method !== req.method) continue;
    const match = route.re.exec(path);
    if (!match) continue;
    try {
      const user = db.currentUser();
      if (!route.anonymous && !user) fail(401, 'AUTH_UNAUTHENTICATED', 'Not signed in', 'Please sign in to continue.');
      if (route.roles && !route.roles.some((r) => user!.roles.includes(r as never))) fail(403, 'AUTH_FORBIDDEN', 'Forbidden', 'You don’t have access to this.');
      const ctx: Ctx = { req, p: match.slice(1), db, user: user!, body: (req.body && !(req.body instanceof FormData) ? req.body : {}) as Record<string, unknown>, query: (k) => req.params.get(k) };
      const reply = route.handler(ctx);
      db.save();
      if (reply instanceof Observable) return reply;
      const res = new HttpResponse({ status: reply.status ?? 200, body: reply.body ?? null, url: req.url, headers: new HttpHeaders({ 'X-Trace-Id': traceIdOf(req) }) });
      return of(res).pipe(delay(reply.delay ?? latency()));
    } catch (e) {
      if (e instanceof MockProblem) return timer(latency()).pipe(mergeMap(() => throwError(() => problemError(req, e))));
      console.error('[mock] handler crashed', e);
      return timer(100).pipe(mergeMap(() => throwError(() => problemError(req, new MockProblem(500, 'INTERNAL_ERROR', 'Internal error', 'Something went wrong on our side.')))));
    }
  }
  return timer(100).pipe(mergeMap(() => throwError(() => problemError(req, new MockProblem(404, 'NOT_FOUND', 'Not found', `Mock API has no route for ${req.method} ${path}.`)))));
};
