/** W3C trace-context helpers and reference-ID formatting (contracts.md §4). */

const HEX = '0123456789abcdef';

function randomHex(bytes: number): string {
  const buf = new Uint8Array(bytes);
  globalThis.crypto.getRandomValues(buf);
  let out = '';
  for (const b of buf) out += HEX[b >> 4] + HEX[b & 15];
  return out;
}

function randomNonZeroHex(bytes: number): string {
  // All-zero trace/span IDs are invalid per the W3C spec.
  let id = randomHex(bytes);
  while (/^0+$/.test(id)) id = randomHex(bytes);
  return id;
}

export interface TraceParent {
  traceId: string; // 32 lower-case hex
  spanId: string; // 16 lower-case hex
  header: string; // 00-<traceId>-<spanId>-01
}

export function newTraceParent(): TraceParent {
  const traceId = randomNonZeroHex(16);
  const spanId = randomNonZeroHex(8);
  return { traceId, spanId, header: `00-${traceId}-${spanId}-01` };
}

const TRACEPARENT_RE = /^00-([0-9a-f]{32})-([0-9a-f]{16})-[0-9a-f]{2}$/;

export function parseTraceParent(header: string | null | undefined): TraceParent | null {
  if (!header) return null;
  const m = TRACEPARENT_RE.exec(header.trim());
  if (!m) return null;
  return { traceId: m[1], spanId: m[2], header: header.trim() };
}

/** `7f3a91c2…` → `7F3A-91C2`. Returns null when the input has fewer than 8 hex chars. */
export function referenceIdFromTraceId(traceId: string | null | undefined): string | null {
  if (!traceId) return null;
  const hex = traceId.replace(/[^0-9a-fA-F]/g, '');
  if (hex.length < 8) return null;
  const head = hex.slice(0, 8).toUpperCase();
  return `${head.slice(0, 4)}-${head.slice(4)}`;
}

/** Normalises user input such as `7f3a91c2` or ` 7F3A-91C2 ` to `7F3A-91C2`; other strings are returned trimmed. */
export function normaliseReferenceId(input: string): string {
  const t = input.trim();
  if (/^[0-9a-fA-F]{4}-?[0-9a-fA-F]{4}$/.test(t)) {
    const hex = t.replace('-', '').toUpperCase();
    return `${hex.slice(0, 4)}-${hex.slice(4)}`;
  }
  return t;
}

export function newIdempotencyKey(): string {
  return globalThis.crypto.randomUUID();
}
