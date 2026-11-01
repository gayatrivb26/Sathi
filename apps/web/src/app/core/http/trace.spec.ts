import { apiErrorFromProblem, ApiError, friendlyMessage } from './api-error';
import { newTraceParent, normaliseReferenceId, parseTraceParent, referenceIdFromTraceId } from './trace';

describe('traceparent', () => {
  it('generates W3C traceparent 00-<32hex>-<16hex>-01', () => {
    const tp = newTraceParent();
    expect(tp.header).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/);
    expect(tp.header).toBe(`00-${tp.traceId}-${tp.spanId}-01`);
  });

  it('never produces an all-zero trace or span id and is unique', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 200; i++) {
      const tp = newTraceParent();
      expect(tp.traceId).not.toMatch(/^0+$/);
      expect(tp.spanId).not.toMatch(/^0+$/);
      seen.add(tp.traceId);
    }
    expect(seen.size).toBe(200);
  });

  it('parses valid headers and rejects invalid ones', () => {
    const tp = newTraceParent();
    expect(parseTraceParent(tp.header)?.traceId).toBe(tp.traceId);
    expect(parseTraceParent('garbage')).toBeNull();
    expect(parseTraceParent('00-XYZ-123-01')).toBeNull();
    expect(parseTraceParent(null)).toBeNull();
  });
});

describe('reference IDs', () => {
  it('formats the first 8 hex chars of the trace id upper-case as XXXX-XXXX', () => {
    expect(referenceIdFromTraceId('7f3a91c2e4b5d6f708192a3b4c5d6e7f')).toBe('7F3A-91C2');
  });

  it('returns null for missing or too-short trace ids', () => {
    expect(referenceIdFromTraceId(undefined)).toBeNull();
    expect(referenceIdFromTraceId('abc')).toBeNull();
  });

  it('normalises user input', () => {
    expect(normaliseReferenceId(' 7f3a91c2 ')).toBe('7F3A-91C2');
    expect(normaliseReferenceId('7f3a-91c2')).toBe('7F3A-91C2');
    const trace = '7f3a91c2e4b5d6f708192a3b4c5d6e7f';
    expect(normaliseReferenceId(trace)).toBe(trace);
  });
});

describe('ApiError from ProblemDetails', () => {
  it('uses the server referenceId and detail', () => {
    const e = apiErrorFromProblem(429, { code: 'WEB_SEARCH_QUOTA_EXCEEDED', detail: 'You have used today’s 20 web searches.', traceId: 'aaaabbbbccccdddd', referenceId: '1234-ABCD' });
    expect(e).toBeInstanceOf(ApiError);
    expect(e.code).toBe('WEB_SEARCH_QUOTA_EXCEEDED');
    expect(e.referenceId).toBe('1234-ABCD');
    expect(e.userMessage).toContain('20 web searches');
  });

  it('derives the reference ID from traceId when referenceId is missing', () => {
    const e = apiErrorFromProblem(500, { code: 'INTERNAL_ERROR', traceId: '7f3a91c2e4b5d6f708192a3b4c5d6e7f' });
    expect(e.referenceId).toBe('7F3A-91C2');
  });

  it('falls back to the browser trace id and a friendly message on network errors', () => {
    const e = apiErrorFromProblem(0, null, 'deadbeef00000000deadbeef00000000');
    expect(e.code).toBe('NETWORK');
    expect(e.isNetwork).toBe(true);
    expect(e.referenceId).toBe('DEAD-BEEF');
    expect(e.userMessage).toMatch(/couldn’t reach Sathi/);
  });

  it('parses JSON string bodies and exposes field errors', () => {
    const e = apiErrorFromProblem(400, JSON.stringify({ code: 'VALIDATION_FAILED', errors: { email: ['Email is required.'] } }));
    expect(e.fieldErrors['email']).toEqual(['Email is required.']);
  });

  it('maps unknown codes to a generic friendly message', () => {
    expect(friendlyMessage('SOMETHING_NEW')).toBe('Something went wrong on our side.');
  });
});
