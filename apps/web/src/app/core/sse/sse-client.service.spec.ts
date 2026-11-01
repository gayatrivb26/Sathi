import { HttpXsrfTokenExtractor } from '@angular/common/http';
import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { lastValueFrom, toArray } from 'rxjs';
import { ClientErrorReporter } from '../errors/client-error-reporter.service';
import { ApiError } from '../http/api-error';
import { TutorEvent } from '../models/api.models';
import { FETCH, FetchFn, SseClient } from './sse-client.service';

function streamOf(chunks: string[], opts: { failAfter?: number } = {}): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  let i = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (opts.failAfter !== undefined && i >= opts.failAfter) {
        controller.error(new TypeError('network'));
        return;
      }
      if (i < chunks.length) controller.enqueue(enc.encode(chunks[i++]));
      else controller.close();
    },
  });
}

describe('SseClient', () => {
  let fetchImpl: ReturnType<typeof vi.fn>;
  const reports: unknown[] = [];

  function setup(response: () => Response) {
    fetchImpl = vi.fn((_input: RequestInfo | URL, _init?: RequestInit) => Promise.resolve(response()));
    reports.length = 0;
    TestBed.configureTestingModule({
      providers: [
        provideZonelessChangeDetection(),
        provideRouter([]),
        { provide: FETCH, useValue: fetchImpl as unknown as FetchFn },
        { provide: HttpXsrfTokenExtractor, useValue: { getToken: () => 'xsrf-123' } },
        { provide: ClientErrorReporter, useValue: { report: (r: unknown) => reports.push(r) } },
      ],
    });
    return TestBed.inject(SseClient);
  }

  it('POSTs with CSRF, traceparent and Idempotency-Key headers and emits typed events', async () => {
    const body = [
      'event: start\ndata: {"conversationId":"c","userMessageId":"u","assistantMessageId":"a","runId":"r","referenceId":"7F3A-91C2"}\n\n',
      ': ping\n\nevent: status\ndata: {"stage":"retrieving","mess',
      'age":"Searching…"}\n\nevent: token\ndata: {"text":"Hello [1]"}\n\n',
      'event: citation\ndata: {"index":1,"sourceType":"course","title":"Attention basics","documentId":null,"lessonId":"l","page":null,"url":null,"snippet":"s"}\n\n',
      'event: done\ndata: {"messageId":"a","content":"Hello [1]","answerBasis":["course"],"citationsValid":1,"citationsDropped":0,"warnings":[]}\n\n',
      'event: token\ndata: {"text":"ignored after done"}\n\n',
    ];
    const client = setup(() => new Response(streamOf(body), { status: 200, headers: { 'Content-Type': 'text/event-stream' } }));
    const events = await lastValueFrom(client.post<TutorEvent>('/api/v1/conversations/c/messages/stream', { content: 'hi' }, { idempotencyKey: 'idem-1' }).pipe(toArray()));

    expect(events.map((e) => e.event)).toEqual(['start', 'status', 'token', 'citation', 'done']);
    expect(events[1].data).toEqual({ stage: 'retrieving', message: 'Searching…' });

    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(url).toBe('/api/v1/conversations/c/messages/stream');
    expect(init.method).toBe('POST');
    expect(init.credentials).toBe('same-origin');
    expect(headers['X-XSRF-TOKEN']).toBe('xsrf-123');
    expect(headers['Idempotency-Key']).toBe('idem-1');
    expect(headers['traceparent']).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/);
    expect(JSON.parse(init.body as string)).toEqual({ content: 'hi' });
  });

  it('turns a ProblemDetails response into an ApiError with its reference ID', async () => {
    const client = setup(
      () =>
        new Response(JSON.stringify({ status: 429, code: 'WEB_SEARCH_QUOTA_EXCEEDED', detail: 'Daily limit', traceId: 'abcdef0123456789abcdef0123456789', referenceId: 'ABCD-EF01' }), {
          status: 429,
          headers: { 'Content-Type': 'application/problem+json' },
        }),
    );
    const err = await lastValueFrom(client.post('/api/v1/x', {})).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).code).toBe('WEB_SEARCH_QUOTA_EXCEEDED');
    expect((err as ApiError).referenceId).toBe('ABCD-EF01');
  });

  it('reports an sse_drop when the stream ends without a terminal event', async () => {
    const client = setup(() => new Response(streamOf(['event: token\ndata: {"text":"a"}\n\n']), { status: 200 }));
    const err = await lastValueFrom(client.post('/api/v1/x', {})).catch((e: unknown) => e);
    expect((err as ApiError).code).toBe('SSE_DROPPED');
    expect((err as ApiError).referenceId).toMatch(/^[0-9A-F]{4}-[0-9A-F]{4}$/);
    expect(reports).toHaveLength(1);
    expect((reports[0] as { kind: string }).kind).toBe('sse_drop');
  });

  it('reports an sse_drop when reading fails mid-stream', async () => {
    const client = setup(() => new Response(streamOf(['event: token\ndata: {"text":"a"}\n\n', 'x'], { failAfter: 1 }), { status: 200 }));
    const err = await lastValueFrom(client.post('/api/v1/x', {})).catch((e: unknown) => e);
    expect((err as ApiError).code).toBe('SSE_DROPPED');
    expect(reports).toHaveLength(1);
  });

  it('aborts the request when unsubscribed (stop generating)', async () => {
    let signal: AbortSignal | undefined;
    const client = setup(() => new Response(new ReadableStream(), { status: 200 }));
    fetchImpl.mockImplementation((_u: unknown, init: RequestInit) => {
      signal = init.signal ?? undefined;
      return Promise.resolve(new Response(new ReadableStream(), { status: 200 }));
    });
    const sub = client.post('/api/v1/x', {}).subscribe({ error: () => undefined });
    await Promise.resolve();
    sub.unsubscribe();
    expect(signal?.aborted).toBe(true);
    expect(reports).toHaveLength(0);
  });
});
