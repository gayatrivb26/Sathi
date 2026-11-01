import { HttpErrorResponse } from '@angular/common/http';
import { ProblemDetails } from '../models/api.models';
import { referenceIdFromTraceId } from './trace';

/** Friendly copy for codes whose server `detail` may be missing (status 0, proxies, etc.). */
const FRIENDLY: Record<string, string> = {
  AUTH_UNAUTHENTICATED: 'Please sign in to continue.',
  AUTH_FORBIDDEN: "You don't have access to this.",
  AUTH_INVALID_CREDENTIALS: 'That email and password don’t match.',
  AUTH_EMAIL_NOT_CONFIRMED: 'Please verify your email first — check your inbox.',
  AUTH_LOCKED_OUT: 'Too many attempts. Try again in 15 minutes.',
  AUTH_EMAIL_TAKEN: 'An account with this email already exists.',
  AUTH_INVALID_TOKEN: 'This link has expired or was already used.',
  CSRF_INVALID: 'Your session expired. Refresh the page and try again.',
  NOT_FOUND: 'We couldn’t find that.',
  CONFLICT: 'That changed while you were working. Refresh and try again.',
  RATE_LIMITED: 'You’re going a bit fast. Wait a moment and try again.',
  QUOTA_EXCEEDED: 'You’ve reached today’s limit. It resets at midnight.',
  WEB_SEARCH_QUOTA_EXCEEDED: 'You’ve used today’s web searches. Turn off Search the web to keep going.',
  UPLOAD_INVALID_TYPE: 'That file type isn’t supported. Use PDF, Word, Markdown or text.',
  UPLOAD_TOO_LARGE: 'That file is too large (25 MB max) or your storage is full.',
  LLM_TIMEOUT: 'The tutor took too long to answer. Please try again.',
  LLM_RATE_LIMITED: 'The tutor is very busy right now. Try again in a minute.',
  LLM_UNAVAILABLE: 'The tutor is unavailable right now. Try again shortly.',
  LLM_REFUSED: 'The tutor couldn’t answer that. Try rephrasing your question.',
  LLM_DISABLED: 'The tutor is paused for maintenance. Practice and notes still work.',
  SPEND_CAP_REACHED: 'The tutor has reached today’s usage limit. Practice and notes still work.',
  AI_SERVICE_UNAVAILABLE: 'The tutor is unavailable right now. Try again shortly.',
  VALIDATION_FAILED: 'Please check the highlighted fields.',
  INTERNAL_ERROR: 'Something went wrong on our side.',
  NETWORK: 'We couldn’t reach Sathi. Check your connection and try again.',
  // §11.11 Release 2
  CLASS_CODE_INVALID: 'We couldn’t find a class with that code. Check it with your teacher.',
  CLASS_JOIN_DISABLED: 'This class isn’t accepting new students right now. Ask your teacher to turn joining on.',
  CLASS_INVITE_EMAIL_MISMATCH: 'This invite was sent to a different email address. Sign in with that address to accept it.',
  CLASS_INVITE_EXPIRED: 'This invite has expired. Ask your teacher to send a new one.',
  COURSE_HAS_STUDENTS: 'Students are enrolled in this course, so it can’t be deleted. Unpublish it instead.',
  COURSE_LAST_OWNER: 'Every course needs at least one owner. Make someone else an owner first.',
  USER_NOT_FOUND: 'There’s no Sathi account with that email.',
  USER_NOT_INSTRUCTOR: 'That person doesn’t have the Instructor role yet. Ask an admin to grant it first.',
  ROLE_SELF_DEMOTION: 'You can’t remove your own Admin role or lock your own account.',
  ROLE_LAST_ADMIN: 'Sathi needs at least one admin. Make someone else an admin first.',
  STAFF_INVITE_INVALID: 'This invite link is no longer valid. Ask an admin for a new one.',
  AUTH_TOO_YOUNG: 'Sathi is for learners aged 8 and over.',
  AUTH_GUARDIAN_CONSENT_PENDING: 'Your parent or guardian still needs to approve your account. We emailed them a link.',
  AUTH_GUARDIAN_CONSENT_DECLINED: 'Your parent or guardian didn’t approve this account, so it has been closed.',
  STREAM_INTERRUPTED: 'This answer was interrupted. Try again.',
};

export function friendlyMessage(code: string | null | undefined, fallback?: string | null): string {
  if (code && FRIENDLY[code]) return FRIENDLY[code];
  return fallback || 'Something went wrong on our side.';
}

/** Normalised error thrown by every API call (HTTP and SSE). */
export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly title: string;
  readonly detail: string;
  readonly referenceId: string | null;
  readonly traceId: string | null;
  readonly fieldErrors: Record<string, string[]>;

  constructor(init: {
    status: number;
    code: string;
    title?: string;
    detail?: string;
    referenceId?: string | null;
    traceId?: string | null;
    fieldErrors?: Record<string, string[]>;
  }) {
    super(init.detail || init.title || init.code);
    this.name = 'ApiError';
    this.status = init.status;
    this.code = init.code;
    this.title = init.title ?? '';
    this.detail = init.detail || friendlyMessage(init.code);
    this.traceId = init.traceId ?? null;
    this.referenceId = init.referenceId ?? referenceIdFromTraceId(init.traceId);
    this.fieldErrors = init.fieldErrors ?? {};
  }

  get isNetwork(): boolean {
    return this.status === 0;
  }

  /** Text safe to show to a student. */
  get userMessage(): string {
    if (this.isNetwork) return FRIENDLY['NETWORK'];
    return this.detail || friendlyMessage(this.code);
  }
}

function codeForStatus(status: number): string {
  switch (status) {
    case 0:
      return 'NETWORK';
    case 400:
      return 'VALIDATION_FAILED';
    case 401:
      return 'AUTH_UNAUTHENTICATED';
    case 403:
      return 'AUTH_FORBIDDEN';
    case 404:
      return 'NOT_FOUND';
    case 409:
      return 'CONFLICT';
    case 413:
      return 'UPLOAD_TOO_LARGE';
    case 415:
      return 'UPLOAD_INVALID_TYPE';
    case 429:
      return 'RATE_LIMITED';
    default:
      return 'INTERNAL_ERROR';
  }
}

function asProblem(body: unknown): ProblemDetails | null {
  if (!body) return null;
  if (typeof body === 'string') {
    try {
      return asProblem(JSON.parse(body));
    } catch {
      return null;
    }
  }
  if (typeof body === 'object') return body as ProblemDetails;
  return null;
}

/**
 * Builds an ApiError from a ProblemDetails body (or anything else).
 * `requestTraceId` is the trace ID the browser sent, used when the server didn't answer.
 */
export function apiErrorFromProblem(status: number, body: unknown, requestTraceId?: string | null): ApiError {
  const p = asProblem(body);
  const traceId = p?.traceId ?? requestTraceId ?? null;
  const code = p?.code ?? codeForStatus(status);
  return new ApiError({
    status,
    code,
    title: p?.title,
    detail: p?.detail ?? friendlyMessage(code),
    referenceId: p?.referenceId ?? referenceIdFromTraceId(traceId),
    traceId,
    fieldErrors: p?.errors,
  });
}

export function apiErrorFromHttp(err: HttpErrorResponse, requestTraceId?: string | null): ApiError {
  const headerTrace = err.headers?.get('X-Trace-Id');
  return apiErrorFromProblem(err.status, err.error, headerTrace ?? requestTraceId);
}

export function toApiError(err: unknown): ApiError {
  if (err instanceof ApiError) return err;
  if (err instanceof HttpErrorResponse) return apiErrorFromHttp(err);
  return new ApiError({ status: -1, code: 'INTERNAL_ERROR', detail: friendlyMessage('INTERNAL_ERROR') });
}
