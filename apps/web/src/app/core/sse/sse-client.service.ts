import { HttpXsrfTokenExtractor } from '@angular/common/http';
import { inject, Injectable, InjectionToken } from '@angular/core';
import { Observable } from 'rxjs';
import { ApiError, apiErrorFromProblem } from '../http/api-error';
import { TraceContext } from '../http/trace-context.service';
import { ClientErrorReporter } from '../errors/client-error-reporter.service';
import { SseParser } from './sse-parser';

export type FetchFn = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

/** `fetch` used by the SSE client. The mock build swaps in a fake implementation. */
export const FETCH = new InjectionToken<FetchFn>('FETCH', {
  providedIn: 'root',
  factory: () => (input, init) => globalThis.fetch(input, init),
});

/** Event names that end the stream. */
const TERMINAL = new Set(['done', 'error']);

export interface SseOptions {
  idempotencyKey?: string;
}

/**
 * POSTs JSON and reads a `text/event-stream` response with fetch + ReadableStream
 * (EventSource can't POST or send the CSRF header). Emits `{event, data}` with parsed JSON data.
 * Unsubscribing aborts the request ("Stop generating").
 */
@Injectable({ providedIn: 'root' })
export class SseClient {
  private readonly fetchFn = inject(FETCH);
  private readonly xsrf = inject(HttpXsrfTokenExtractor);
  private readonly trace = inject(TraceContext);
  private readonly reporter = inject(ClientErrorReporter);

  post<E extends { event: string; data: unknown }>(url: string, body: unknown, options: SseOptions = {}): Observable<E> {
    return new Observable<E>((subscriber) => {
      const controller = new AbortController();
      const tp = this.trace.next();
      let finished = false;

      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        Accept: 'text/event-stream',
        traceparent: tp.header,
      };
      const token = this.xsrf.getToken();
      if (token) headers['X-XSRF-TOKEN'] = token;
      if (options.idempotencyKey) headers['Idempotency-Key'] = options.idempotencyKey;

      const drop = (reason: string) => {
        if (finished || controller.signal.aborted) return;
        finished = true;
        this.reporter.report({ kind: 'sse_drop', message: `SSE dropped: ${reason}`, traceId: tp.traceId, url });
        subscriber.error(
          new ApiError({
            status: 0,
            code: 'SSE_DROPPED',
            detail: 'The connection dropped before the answer finished.',
            traceId: tp.traceId,
          }),
        );
      };

      const run = async () => {
        let response: Response;
        try {
          response = await this.fetchFn(url, {
            method: 'POST',
            credentials: 'same-origin',
            headers,
            body: JSON.stringify(body),
            signal: controller.signal,
          });
        } catch {
          if (controller.signal.aborted) return;
          finished = true;
          subscriber.error(new ApiError({ status: 0, code: 'NETWORK', traceId: tp.traceId }));
          return;
        }

        if (!response.ok) {
          const text = await response.text().catch(() => '');
          finished = true;
          const headerTrace = response.headers.get('X-Trace-Id');
          const err = apiErrorFromProblem(response.status, text, headerTrace ?? tp.traceId);
          if (response.status >= 500) {
            this.reporter.report({ kind: 'http', message: `HTTP ${response.status} POST ${err.code}`, traceId: err.traceId ?? tp.traceId, status: response.status, url });
          }
          subscriber.error(err);
          return;
        }
        if (!response.body) {
          drop('empty body');
          return;
        }

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        const parser = new SseParser();
        try {
          while (!finished) {
            const { value, done } = await reader.read();
            if (done) break;
            const frames = parser.push(decoder.decode(value, { stream: true }));
            for (const frame of frames) {
              let data: unknown;
              try {
                data = JSON.parse(frame.data);
              } catch {
                continue; // malformed frame: skip it, the stream may still recover
              }
              subscriber.next({ event: frame.event, data } as E);
              if (TERMINAL.has(frame.event)) {
                finished = true;
                subscriber.complete();
                void reader.cancel().catch(() => undefined);
                return;
              }
            }
          }
          parser.push(decoder.decode());
          parser.end();
          if (!finished) drop('stream ended without done');
        } catch {
          drop('read failed');
        }
      };

      void run();
      return () => {
        finished = true;
        controller.abort();
      };
    });
  }
}
