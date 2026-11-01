import { Injectable } from '@angular/core';
import { newTraceParent, TraceParent } from './trace';

/** Creates W3C traceparents and remembers the most recent one for error reports. */
@Injectable({ providedIn: 'root' })
export class TraceContext {
  private last: TraceParent | null = null;

  next(): TraceParent {
    this.last = newTraceParent();
    return this.last;
  }

  get lastTraceId(): string | null {
    return this.last?.traceId ?? null;
  }
}
