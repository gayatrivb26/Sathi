import { HttpClient, HttpEvent } from '@angular/common/http';
import { inject, Injectable } from '@angular/core';
import { Observable } from 'rxjs';
import { silent } from '../http/http-context';
import { DocumentItem } from '../models/api.models';

/** contracts.md §5.5 */
@Injectable({ providedIn: 'root' })
export class NotesApi {
  private readonly http = inject(HttpClient);

  list(): Observable<DocumentItem[]> {
    return this.http.get<DocumentItem[]>('/api/v1/documents', { context: silent() });
  }
  get(id: string): Observable<DocumentItem> {
    return this.http.get<DocumentItem>(`/api/v1/documents/${id}`, { context: silent() });
  }
  /** Multipart upload with progress events. Upload errors render on the file row, so no toast. */
  upload(file: File, idempotencyKey: string): Observable<HttpEvent<DocumentItem>> {
    const form = new FormData();
    form.append('file', file, file.name);
    return this.http.post<DocumentItem>('/api/v1/documents', form, {
      headers: { 'Idempotency-Key': idempotencyKey },
      reportProgress: true,
      observe: 'events',
      context: silent(),
    });
  }
  retry(id: string): Observable<DocumentItem> {
    return this.http.post<DocumentItem>(`/api/v1/documents/${id}/retry`, {});
  }
  delete(id: string): Observable<void> {
    return this.http.delete<void>(`/api/v1/documents/${id}`);
  }
}
