import { HttpContext, HttpContextToken } from '@angular/common/http';

/** The caller renders the error inline (e.g. an error state with Retry) — no toast. */
export const SILENT_ERROR = new HttpContextToken<boolean>(() => false);
/** A 401 is an expected answer (e.g. GET /auth/me, POST /auth/login) — don't redirect to sign-in. */
export const SKIP_AUTH_REDIRECT = new HttpContextToken<boolean>(() => false);
/** Never report this request's failure to /client-errors (avoids report loops). */
export const SKIP_ERROR_REPORT = new HttpContextToken<boolean>(() => false);

export function silent(ctx = new HttpContext()): HttpContext {
  return ctx.set(SILENT_ERROR, true);
}
