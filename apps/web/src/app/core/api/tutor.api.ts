import { HttpClient, HttpParams } from '@angular/common/http';
import { inject, Injectable } from '@angular/core';
import { Observable } from 'rxjs';
import { silent } from '../http/http-context';
import { newIdempotencyKey } from '../http/trace';
import { Conversation, ConversationCreated, ConversationSummary, Page, SendMessageRequest, TutorEvent } from '../models/api.models';
import { SseClient } from '../sse/sse-client.service';

/** contracts.md §5.3 + §11.5 */
@Injectable({ providedIn: 'root' })
export class TutorApi {
  private readonly http = inject(HttpClient);
  private readonly sse = inject(SseClient);

  conversations(courseId: string | null, cursor?: string | null, limit = 20): Observable<Page<ConversationSummary>> {
    let params = new HttpParams().set('limit', limit);
    if (courseId) params = params.set('courseId', courseId);
    if (cursor) params = params.set('cursor', cursor);
    return this.http.get<Page<ConversationSummary>>('/api/v1/conversations', { params, context: silent() });
  }
  create(courseId: string, lessonId?: string | null): Observable<ConversationCreated> {
    return this.http.post<ConversationCreated>('/api/v1/conversations', lessonId ? { courseId, lessonId } : { courseId });
  }
  conversation(id: string): Observable<Conversation> {
    return this.http.get<Conversation>(`/api/v1/conversations/${id}`, { context: silent() });
  }
  delete(id: string): Observable<void> {
    return this.http.delete<void>(`/api/v1/conversations/${id}`);
  }
  feedback(messageId: string, rating: 1 | -1, comment?: string): Observable<void> {
    return this.http.post<void>(`/api/v1/messages/${messageId}/feedback`, comment ? { rating, comment } : { rating });
  }
  /** §11.5 — asks the server to stop generating (idempotent, 202). Never toasts: Stop already updated the UI. */
  cancel(conversationId: string, messageId: string): Observable<void> {
    return this.http.post<void>(`/api/v1/conversations/${conversationId}/messages/${messageId}/cancel`, {}, { context: silent() });
  }
  /** Streams the answer as typed SSE events. Unsubscribing aborts the fetch (call `cancel` to stop the server too). */
  stream(conversationId: string, body: SendMessageRequest, idempotencyKey = newIdempotencyKey()): Observable<TutorEvent> {
    return this.sse.post<TutorEvent>(`/api/v1/conversations/${conversationId}/messages/stream`, body, { idempotencyKey });
  }
}
