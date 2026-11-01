import { HttpClient, HttpParams } from '@angular/common/http';
import { inject, Injectable } from '@angular/core';
import { Observable } from 'rxjs';
import { silent } from '../http/http-context';
import { newIdempotencyKey } from '../http/trace';
import {
  AnswerRequest,
  AnswerResult,
  Attempt,
  AttemptCompletion,
  CourseDetail,
  CourseSummary,
  Home,
  Lesson,
  PracticeSessionRequest,
  ProgressOverview,
  RevisionDue,
  RevisionReviewRequest,
  RevisionReviewResult,
  RevisionSchedule,
} from '../models/api.models';

function courseParams(courseId: string | null | undefined): HttpParams {
  return courseId ? new HttpParams().set('courseId', courseId) : new HttpParams();
}

/** contracts.md §5.2 and §5.4. GETs are "silent": screens render their own error state. */
@Injectable({ providedIn: 'root' })
export class LearningApi {
  private readonly http = inject(HttpClient);

  courses(): Observable<CourseSummary[]> {
    return this.http.get<CourseSummary[]>('/api/v1/courses', { context: silent() });
  }
  course(courseId: string): Observable<CourseDetail> {
    return this.http.get<CourseDetail>(`/api/v1/courses/${courseId}`, { context: silent() });
  }
  enroll(courseId: string): Observable<CourseSummary> {
    return this.http.post<CourseSummary>(`/api/v1/courses/${courseId}/enroll`, {});
  }
  lesson(lessonId: string): Observable<Lesson> {
    return this.http.get<Lesson>(`/api/v1/lessons/${lessonId}`, { context: silent() });
  }
  lessonProgress(lessonId: string, percent: number, completed: boolean): Observable<void> {
    return this.http.post<void>(`/api/v1/lessons/${lessonId}/progress`, { percent, completed }, { context: silent() });
  }
  home(courseId?: string | null): Observable<Home> {
    return this.http.get<Home>('/api/v1/home', { params: courseParams(courseId), context: silent() });
  }
  progress(courseId?: string | null): Observable<ProgressOverview> {
    return this.http.get<ProgressOverview>('/api/v1/progress', { params: courseParams(courseId), context: silent() });
  }

  // §5.4
  startDiagnostic(courseId: string): Observable<Attempt> {
    return this.http.post<Attempt>(`/api/v1/courses/${courseId}/diagnostic`, {}, { context: silent() });
  }
  startPractice(body: PracticeSessionRequest): Observable<Attempt> {
    return this.http.post<Attempt>('/api/v1/practice/sessions', body);
  }
  attempt(attemptId: string): Observable<Attempt> {
    return this.http.get<Attempt>(`/api/v1/attempts/${attemptId}`, { context: silent() });
  }
  answer(attemptId: string, body: AnswerRequest, idempotencyKey = newIdempotencyKey()): Observable<AnswerResult> {
    return this.http.post<AnswerResult>(`/api/v1/attempts/${attemptId}/answers`, body, {
      headers: { 'Idempotency-Key': idempotencyKey },
    });
  }
  answerResult(attemptId: string, answerId: string): Observable<AnswerResult> {
    return this.http.get<AnswerResult>(`/api/v1/attempts/${attemptId}/answers/${answerId}`, { context: silent() });
  }
  complete(attemptId: string): Observable<AttemptCompletion> {
    return this.http.post<AttemptCompletion>(`/api/v1/attempts/${attemptId}/complete`, {});
  }
  revisionDue(courseId?: string | null): Observable<RevisionDue> {
    return this.http.get<RevisionDue>('/api/v1/revision/due', { params: courseParams(courseId), context: silent() });
  }
  reviewCard(cardId: string, body: RevisionReviewRequest): Observable<RevisionReviewResult> {
    return this.http.post<RevisionReviewResult>(`/api/v1/revision/cards/${cardId}/review`, body);
  }
  revisionSchedule(courseId?: string | null): Observable<RevisionSchedule> {
    return this.http.get<RevisionSchedule>('/api/v1/revision/schedule', { params: courseParams(courseId), context: silent() });
  }
}
