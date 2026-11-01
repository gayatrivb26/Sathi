import { HttpClient, HttpParams } from '@angular/common/http';
import { inject, Injectable } from '@angular/core';
import { Observable } from 'rxjs';
import { silent } from '../http/http-context';
import {
  AdminUser,
  AdminUserDetail,
  AiRunDetail,
  ClassCreate,
  ClassInvite,
  ClassInviteResult,
  ClassMember,
  ClassSummary,
  ClassUpdate,
  CourseInstructor,
  Role,
  StaffInvite,
  StaffInviteCreate,
  StaffInviteCreated,
  AiRunSummary,
  ClassInsights,
  Concept,
  ConceptUpsert,
  CourseModule,
  CourseUpsert,
  GenerateQuestionsAccepted,
  GenerateQuestionsRequest,
  GradingQueueItem,
  GradingReview,
  InstructorCourse,
  InstructorQuestion,
  LessonUpsert,
  ModuleUpsert,
  Page,
  QuestionStatus,
  QuestionUpsert,
  UsageSummary,
} from '../models/api.models';

function classParams(courseId: string, classId?: string | null): HttpParams {
  let params = new HttpParams().set('courseId', courseId);
  if (classId) params = params.set('classId', classId);
  return params;
}

/** contracts.md §5.6 + §11.1 (role Instructor or Admin). */
@Injectable({ providedIn: 'root' })
export class InstructorApi {
  private readonly http = inject(HttpClient);
  private readonly base = '/api/v1/instructor';

  courses(): Observable<InstructorCourse[]> {
    return this.http.get<InstructorCourse[]>(`${this.base}/courses`, { context: silent() });
  }
  /** Field errors (e.g. slug taken) render inline, so these are silent. */
  createCourse(body: CourseUpsert): Observable<InstructorCourse> {
    return this.http.post<InstructorCourse>(`${this.base}/courses`, body, { context: silent() });
  }
  updateCourse(id: string, body: CourseUpsert): Observable<InstructorCourse> {
    return this.http.put<InstructorCourse>(`${this.base}/courses/${id}`, body, { context: silent() });
  }
  /** 409 `COURSE_HAS_STUDENTS` when anyone is enrolled — rendered inline by the caller. */
  deleteCourse(id: string): Observable<void> {
    return this.http.delete<void>(`${this.base}/courses/${id}`, { context: silent() });
  }

  // §11.1 co-instructors
  instructors(courseId: string): Observable<CourseInstructor[]> {
    return this.http.get<CourseInstructor[]>(`${this.base}/courses/${courseId}/instructors`, { context: silent() });
  }
  addInstructor(courseId: string, email: string): Observable<void> {
    return this.http.post<void>(`${this.base}/courses/${courseId}/instructors`, { email }, { context: silent() });
  }
  removeInstructor(courseId: string, userId: string): Observable<void> {
    return this.http.delete<void>(`${this.base}/courses/${courseId}/instructors/${userId}`, { context: silent() });
  }

  // §11.1 classes
  classes(courseId: string): Observable<ClassSummary[]> {
    return this.http.get<ClassSummary[]>(`${this.base}/courses/${courseId}/classes`, { context: silent() });
  }
  createClass(courseId: string, body: ClassCreate): Observable<ClassSummary> {
    return this.http.post<ClassSummary>(`${this.base}/courses/${courseId}/classes`, body, { context: silent() });
  }
  updateClass(id: string, body: ClassUpdate): Observable<ClassSummary> {
    return this.http.put<ClassSummary>(`${this.base}/classes/${id}`, body);
  }
  regenerateCode(id: string): Observable<ClassSummary> {
    return this.http.post<ClassSummary>(`${this.base}/classes/${id}/regenerate-code`, {});
  }
  archiveClass(id: string): Observable<ClassSummary> {
    return this.http.post<ClassSummary>(`${this.base}/classes/${id}/archive`, {});
  }
  unarchiveClass(id: string): Observable<ClassSummary> {
    return this.http.post<ClassSummary>(`${this.base}/classes/${id}/unarchive`, {});
  }
  members(classId: string): Observable<ClassMember[]> {
    return this.http.get<ClassMember[]>(`${this.base}/classes/${classId}/members`, { context: silent() });
  }
  removeMember(classId: string, userId: string): Observable<void> {
    return this.http.delete<void>(`${this.base}/classes/${classId}/members/${userId}`);
  }
  inviteToClass(classId: string, emails: string[]): Observable<ClassInviteResult> {
    return this.http.post<ClassInviteResult>(`${this.base}/classes/${classId}/invites`, { emails });
  }
  classInvites(classId: string): Observable<ClassInvite[]> {
    return this.http.get<ClassInvite[]>(`${this.base}/classes/${classId}/invites`, { context: silent() });
  }
  revokeInvite(inviteId: string): Observable<void> {
    return this.http.delete<void>(`${this.base}/invites/${inviteId}`);
  }
  resendInvite(inviteId: string): Observable<void> {
    return this.http.post<void>(`${this.base}/invites/${inviteId}/resend`, {});
  }
  createModule(courseId: string, body: ModuleUpsert): Observable<CourseModule> {
    return this.http.post<CourseModule>(`${this.base}/courses/${courseId}/modules`, body);
  }
  updateModule(id: string, body: ModuleUpsert): Observable<CourseModule> {
    return this.http.put<CourseModule>(`${this.base}/modules/${id}`, body);
  }
  deleteModule(id: string): Observable<void> {
    return this.http.delete<void>(`${this.base}/modules/${id}`);
  }
  createLesson(moduleId: string, body: LessonUpsert): Observable<{ id: string }> {
    return this.http.post<{ id: string }>(`${this.base}/modules/${moduleId}/lessons`, body);
  }
  updateLesson(id: string, body: LessonUpsert): Observable<{ id: string }> {
    return this.http.put<{ id: string }>(`${this.base}/lessons/${id}`, body);
  }
  deleteLesson(id: string): Observable<void> {
    return this.http.delete<void>(`${this.base}/lessons/${id}`);
  }
  createConcept(courseId: string, body: ConceptUpsert): Observable<Concept> {
    return this.http.post<Concept>(`${this.base}/courses/${courseId}/concepts`, body);
  }
  updateConcept(id: string, body: ConceptUpsert): Observable<Concept> {
    return this.http.put<Concept>(`${this.base}/concepts/${id}`, body);
  }
  questions(courseId: string, status?: QuestionStatus | '', conceptId?: string | ''): Observable<InstructorQuestion[]> {
    let params = new HttpParams().set('courseId', courseId);
    if (status) params = params.set('status', status);
    if (conceptId) params = params.set('conceptId', conceptId);
    return this.http.get<InstructorQuestion[]>(`${this.base}/questions`, { params, context: silent() });
  }
  createQuestion(body: QuestionUpsert): Observable<InstructorQuestion> {
    return this.http.post<InstructorQuestion>(`${this.base}/questions`, body);
  }
  updateQuestion(id: string, body: QuestionUpsert): Observable<InstructorQuestion> {
    return this.http.put<InstructorQuestion>(`${this.base}/questions/${id}`, body);
  }
  generateQuestions(body: GenerateQuestionsRequest): Observable<GenerateQuestionsAccepted> {
    return this.http.post<GenerateQuestionsAccepted>(`${this.base}/questions/generate`, body);
  }
  gradingQueue(courseId: string, classId?: string | null): Observable<GradingQueueItem[]> {
    return this.http.get<GradingQueueItem[]>(`${this.base}/grading-queue`, { params: classParams(courseId, classId), context: silent() });
  }
  review(gradingId: string, body: GradingReview): Observable<void> {
    return this.http.post<void>(`${this.base}/grading/${gradingId}/review`, body);
  }
  insights(courseId: string, classId?: string | null): Observable<ClassInsights> {
    return this.http.get<ClassInsights>(`${this.base}/insights`, { params: classParams(courseId, classId), context: silent() });
  }
}

export interface AdminUserQuery {
  query?: string;
  role?: Role | '';
  status?: string;
  cursor?: string | null;
  limit?: number;
}

/** contracts.md §5.7 + §11.2 (role Admin). */
@Injectable({ providedIn: 'root' })
export class AdminApi {
  private readonly http = inject(HttpClient);

  runs(status?: string, type?: string, cursor?: string | null): Observable<Page<AiRunSummary>> {
    let params = new HttpParams();
    if (status) params = params.set('status', status);
    if (type) params = params.set('type', type);
    if (cursor) params = params.set('cursor', cursor);
    return this.http.get<Page<AiRunSummary>>('/api/v1/admin/runs', { params, context: silent() });
  }
  lookup(id: string): Observable<AiRunDetail> {
    return this.http.get<AiRunDetail>(`/api/v1/admin/runs/lookup/${encodeURIComponent(id)}`, { context: silent() });
  }
  usage(days = 7): Observable<UsageSummary> {
    return this.http.get<UsageSummary>('/api/v1/admin/usage', { params: { days }, context: silent() });
  }
  debugCapture(conversationId: string, enabled: boolean, hours: number): Observable<void> {
    return this.http.put<void>(`/api/v1/admin/debug-capture/${conversationId}`, { enabled, hours });
  }

  // §11.2 user administration
  users(q: AdminUserQuery = {}): Observable<Page<AdminUser>> {
    let params = new HttpParams().set('limit', q.limit ?? 20);
    if (q.query) params = params.set('query', q.query);
    if (q.role) params = params.set('role', q.role);
    if (q.status) params = params.set('status', q.status);
    if (q.cursor) params = params.set('cursor', q.cursor);
    return this.http.get<Page<AdminUser>>('/api/v1/admin/users', { params, context: silent() });
  }
  user(id: string): Observable<AdminUserDetail> {
    return this.http.get<AdminUserDetail>(`/api/v1/admin/users/${id}`, { context: silent() });
  }
  /** 409 `ROLE_SELF_DEMOTION` / `ROLE_LAST_ADMIN` are rendered inline. */
  setRoles(id: string, roles: Role[]): Observable<AdminUser> {
    return this.http.put<AdminUser>(`/api/v1/admin/users/${id}/roles`, { roles }, { context: silent() });
  }
  lock(id: string, minutes: number | null): Observable<void> {
    return this.http.post<void>(`/api/v1/admin/users/${id}/lock`, { minutes }, { context: silent() });
  }
  unlock(id: string): Observable<void> {
    return this.http.post<void>(`/api/v1/admin/users/${id}/unlock`, {}, { context: silent() });
  }
  resendVerification(id: string): Observable<void> {
    return this.http.post<void>(`/api/v1/admin/users/${id}/resend-verification`, {});
  }
  createStaffInvite(body: StaffInviteCreate): Observable<StaffInviteCreated> {
    return this.http.post<StaffInviteCreated>('/api/v1/admin/staff-invites', body, { context: silent() });
  }
  staffInvites(): Observable<StaffInvite[]> {
    return this.http.get<StaffInvite[]>('/api/v1/admin/staff-invites', { context: silent() });
  }
  revokeStaffInvite(id: string): Observable<void> {
    return this.http.delete<void>(`/api/v1/admin/staff-invites/${id}`);
  }
}
