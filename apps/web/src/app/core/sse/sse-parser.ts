/**
 * Incremental `text/event-stream` parser (WHATWG HTML §9.2.6), used with fetch + ReadableStream.
 *
 * - Accepts arbitrary chunk boundaries (inside a field name, value, or between `\r` and `\n`).
 * - Line endings: `\n`, `\r\n` or `\r`.
 * - Lines starting with `:` are comments (e.g. `: ping` keep-alives) and are counted, not emitted.
 * - `data:` lines are joined with `\n`; one leading space after the colon is stripped.
 * - An event is dispatched on a blank line; events with no `data` are dropped.
 * - At end of stream an unterminated event is discarded, as the spec requires.
 */
export interface SseFrame {
  event: string;
  data: string;
  id?: string;
}

export class SseParser {
  private buffer = '';
  private skipLeadingLf = false;
  private bomChecked = false;
  private eventName = '';
  private dataLines: string[] = [];
  private hasData = false;
  private lastEventId: string | undefined;
  /** Number of comment lines seen (keep-alive pings). */
  comments = 0;

  /** Feeds a decoded text chunk; returns the events completed by it. */
  push(chunk: string): SseFrame[] {
    if (!chunk) return [];
    let text = chunk;
    if (!this.bomChecked) {
      if (this.buffer.length === 0 && text.charCodeAt(0) === 0xfeff) text = text.slice(1);
      if (text.length > 0 || this.buffer.length > 0) this.bomChecked = true;
    }
    if (this.skipLeadingLf && text.startsWith('\n')) text = text.slice(1);
    this.skipLeadingLf = false;

    this.buffer += text;
    const frames: SseFrame[] = [];
    let start = 0;
    for (let i = 0; i < this.buffer.length; i++) {
      const ch = this.buffer[i];
      if (ch !== '\n' && ch !== '\r') continue;
      const line = this.buffer.slice(start, i);
      if (ch === '\r') {
        if (i + 1 < this.buffer.length) {
          if (this.buffer[i + 1] === '\n') i++;
        } else {
          // `\r` is the last char of this chunk: a following `\n` belongs to the same line ending.
          this.skipLeadingLf = true;
        }
      }
      start = i + 1;
      const frame = this.processLine(line);
      if (frame) frames.push(frame);
    }
    this.buffer = this.buffer.slice(start);
    return frames;
  }

  /** Call when the stream ends. Unterminated data is discarded (spec behaviour). */
  end(): SseFrame[] {
    this.buffer = '';
    this.reset();
    return [];
  }

  private reset(): void {
    this.eventName = '';
    this.dataLines = [];
    this.hasData = false;
  }

  private processLine(line: string): SseFrame | null {
    if (line === '') {
      if (!this.hasData) {
        this.reset();
        return null;
      }
      const frame: SseFrame = { event: this.eventName || 'message', data: this.dataLines.join('\n') };
      if (this.lastEventId !== undefined) frame.id = this.lastEventId;
      this.reset();
      return frame;
    }
    if (line.startsWith(':')) {
      this.comments++;
      return null;
    }
    const colon = line.indexOf(':');
    let field: string;
    let value: string;
    if (colon === -1) {
      field = line;
      value = '';
    } else {
      field = line.slice(0, colon);
      value = line.slice(colon + 1);
      if (value.startsWith(' ')) value = value.slice(1);
    }
    switch (field) {
      case 'event':
        this.eventName = value;
        break;
      case 'data':
        this.dataLines.push(value);
        this.hasData = true;
        break;
      case 'id':
        if (!value.includes('\0')) this.lastEventId = value;
        break;
      default:
        // `retry` and unknown fields are ignored.
        break;
    }
    return null;
  }
}
