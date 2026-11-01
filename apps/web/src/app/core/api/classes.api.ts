import { HttpClient, HttpContext } from '@angular/common/http';
import { inject, Injectable } from '@angular/core';
import { Observable } from 'rxjs';
import { silent, SKIP_AUTH_REDIRECT } from '../http/http-context';
import { ClassInvitePreview, JoinClassResult, MyClass } from '../models/api.models';

/** contracts.md §11.1 — student side of classes (join codes, invites, my classes). */
@Injectable({ providedIn: 'root' })
export class ClassesApi {
  private readonly http = inject(HttpClient);

  /** `code` is dash- and case-insensitive on the server. Errors render inline. */
  join(code: string): Observable<JoinClassResult> {
    return this.http.post<JoinClassResult>('/api/v1/classes/join', { code }, { context: silent() });
  }
  /** Anonymous preview of an email invite. */
  invite(token: string): Observable<ClassInvitePreview> {
    return this.http.get<ClassInvitePreview>(`/api/v1/classes/invites/${encodeURIComponent(token)}`, {
      context: silent(new HttpContext().set(SKIP_AUTH_REDIRECT, true)),
    });
  }
  acceptInvite(token: string): Observable<JoinClassResult> {
    return this.http.post<JoinClassResult>(`/api/v1/classes/invites/${encodeURIComponent(token)}/accept`, {}, { context: silent() });
  }
  myClasses(): Observable<MyClass[]> {
    return this.http.get<MyClass[]>('/api/v1/me/classes', { context: silent() });
  }
  leave(classId: string): Observable<void> {
    return this.http.delete<void>(`/api/v1/me/classes/${classId}`);
  }
}
