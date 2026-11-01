import { SseFrame, SseParser } from './sse-parser';

function parseAll(chunks: string[]): SseFrame[] {
  const p = new SseParser();
  const out: SseFrame[] = [];
  for (const c of chunks) out.push(...p.push(c));
  out.push(...p.end());
  return out;
}

/** Splits text into every possible pair of chunks, to prove boundaries never matter. */
function everySplit(text: string): string[][] {
  const splits: string[][] = [];
  for (let i = 0; i <= text.length; i++) splits.push([text.slice(0, i), text.slice(i)]);
  return splits;
}

describe('SseParser', () => {
  it('parses a simple named event', () => {
    expect(parseAll(['event: token\ndata: {"text":"Hi"}\n\n'])).toEqual([{ event: 'token', data: '{"text":"Hi"}' }]);
  });

  it('defaults the event name to "message"', () => {
    expect(parseAll(['data: hello\n\n'])).toEqual([{ event: 'message', data: 'hello' }]);
  });

  it('parses several events in one chunk', () => {
    const frames = parseAll(['event: start\ndata: {"a":1}\n\nevent: token\ndata: {"text":"x"}\n\nevent: done\ndata: {}\n\n']);
    expect(frames.map((f) => f.event)).toEqual(['start', 'token', 'done']);
  });

  it('handles every possible chunk boundary identically', () => {
    const text = 'event: status\ndata: {"stage":"retrieving","message":"Searching…"}\n\n: ping\n\nevent: token\ndata: {"text":"Dot [1]"}\n\n';
    const expected = parseAll([text]);
    expect(expected.length).toBe(2);
    for (const split of everySplit(text)) expect(parseAll(split)).toEqual(expected);
  });

  it('handles one character per chunk', () => {
    const text = 'event: token\r\ndata: {"text":"a"}\r\n\r\n';
    expect(parseAll(text.split(''))).toEqual([{ event: 'token', data: '{"text":"a"}' }]);
  });

  it('ignores comment lines (keep-alive pings) and counts them', () => {
    const p = new SseParser();
    const frames = p.push(': ping\n\n: ping\n\nevent: token\ndata: {"text":"x"}\n\n');
    expect(frames).toEqual([{ event: 'token', data: '{"text":"x"}' }]);
    expect(p.comments).toBe(2);
  });

  it('supports CRLF, LF and lone CR line endings', () => {
    expect(parseAll(['event: a\r\ndata: 1\r\n\r\n'])).toEqual([{ event: 'a', data: '1' }]);
    expect(parseAll(['event: b\rdata: 2\r\r'])).toEqual([{ event: 'b', data: '2' }]);
    expect(parseAll(['event: c\ndata: 3\n\n'])).toEqual([{ event: 'c', data: '3' }]);
  });

  it('treats a CR at the end of a chunk followed by LF in the next as one line break', () => {
    expect(parseAll(['event: a\r', '\ndata: 1\r', '\n\r', '\n'])).toEqual([{ event: 'a', data: '1' }]);
  });

  it('joins multi-line data with newlines', () => {
    expect(parseAll(['data: line one\ndata: line two\n\n'])).toEqual([{ event: 'message', data: 'line one\nline two' }]);
  });

  it('strips exactly one leading space after the colon', () => {
    expect(parseAll(['data:  two spaces\n\n'])).toEqual([{ event: 'message', data: ' two spaces' }]);
    expect(parseAll(['data:no-space\n\n'])).toEqual([{ event: 'message', data: 'no-space' }]);
  });

  it('keeps colons inside the value (JSON)', () => {
    expect(parseAll(['data: {"url":"https://a.b/c"}\n\n'])).toEqual([{ event: 'message', data: '{"url":"https://a.b/c"}' }]);
  });

  it('does not dispatch events without data and resets the event name', () => {
    expect(parseAll(['event: lonely\n\ndata: x\n\n'])).toEqual([{ event: 'message', data: 'x' }]);
  });

  it('handles a field name with no colon as an empty value', () => {
    expect(parseAll(['data\n\n'])).toEqual([{ event: 'message', data: '' }]);
  });

  it('ignores retry and unknown fields and records id', () => {
    expect(parseAll(['retry: 1000\nfoo: bar\nid: 7\ndata: x\n\n'])).toEqual([{ event: 'message', data: 'x', id: '7' }]);
  });

  it('strips a UTF-8 BOM at the start of the stream only', () => {
    expect(parseAll(['﻿data: x\n\n'])).toEqual([{ event: 'message', data: 'x' }]);
  });

  it('discards an unterminated event at end of stream', () => {
    expect(parseAll(['event: token\ndata: {"text":"partial"}'])).toEqual([]);
    expect(parseAll(['event: token\ndata: {"text":"partial"}\n'])).toEqual([]);
  });

  it('preserves unicode split across chunks after decoding', () => {
    const enc = new TextEncoder().encode('data: {"text":"√d — ok"}\n\n');
    const dec = new TextDecoder();
    const p = new SseParser();
    const frames: SseFrame[] = [];
    for (let i = 0; i < enc.length; i++) frames.push(...p.push(dec.decode(enc.slice(i, i + 1), { stream: true })));
    expect(frames).toEqual([{ event: 'message', data: '{"text":"√d — ok"}' }]);
  });
});
