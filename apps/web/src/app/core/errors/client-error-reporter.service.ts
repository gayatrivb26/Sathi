import { HttpClient, HttpContext } from '@angular/common/http';
import { inject, Injectable } from '@angular/core';
import { Router } from '@angular/router';
import { ClientErrorReport } from '../models/api.models';
import { SILENT_ERROR, SKIP_AUTH_REDIRECT, SKIP_ERROR_REPORT } from '../http/http-context';
import { APP_VERSION } from '../platform/app-info';
import { TraceContext } from '../http/trace-context.service';

const MAX_PER_MINUTE = 10;
const DEDUPE_MS = 60_000;

/** Strips anything that could be learner content: emails, quoted strings, long numbers, query strings. */
export function scrubMessage(message: string): string {
  return message
    .replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, '<email>')
    .replace(/"[^"]{0,500}"|'[^']{0,500}'|`[^`]{0,500}`/g, '<text>')
    .replace(/\?[^\s]*/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 300);
}

/** Path only, without query string or fragment (query strings can carry emails/tokens). */
export function scrubUrl(url: string): string {
  return url.split(/[?#]/)[0];
}

/**
 * Reports unhandled errors, failed HTTP calls and SSE drops to POST /api/v1/client-errors
 * (contracts.md §5.8). Rate-limited client-side; never sends user content.
 */
@Injectable({ providedIn: 'root' })
export class ClientErrorReporter {
  private readonly http = inject(HttpClient);
  private readonly router = inject(Router);
  private readonly trace = inject(TraceContext);
  private sentAt: number[] = [];
  private readonly recent = new Map<string, number>();

  report(report: Omit<ClientErrorReport, 'route' | 'appVersion' | 'userAgent'> & { route?: string }): void {
    const now = Date.now();
    this.sentAt = this.sentAt.filter((t) => now - t < 60_000);
    if (this.sentAt.length >= MAX_PER_MINUTE) return;

    const body: ClientErrorReport = {
      kind: report.kind,
      message: scrubMessage(report.message),
      traceId: report.traceId ?? this.trace.lastTraceId ?? undefined,
      route: scrubUrl(report.route ?? this.router.url ?? '/'),
      appVersion: APP_VERSION,
      userAgent: navigator.userAgent.slice(0, 300),
      status: report.status,
      url: report.url ? scrubUrl(report.url) : undefined,
    };
    const key = `${body.kind}|${body.message}|${body.status ?? ''}|${body.url ?? ''}`;
    const last = this.recent.get(key);
    if (last && now - last < DEDUPE_MS) return;
    this.recent.set(key, now);
    this.sentAt.push(now);

    const context = new HttpContext()
      .set(SKIP_ERROR_REPORT, true)
      .set(SILENT_ERROR, true)
      .set(SKIP_AUTH_REDIRECT, true);
    this.http.post('/api/v1/client-errors', body, { context }).subscribe({ error: () => undefined });
  }
}
