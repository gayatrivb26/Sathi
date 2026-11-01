import { HttpErrorResponse, HttpInterceptorFn } from '@angular/common/http';
import { inject } from '@angular/core';
import { Router } from '@angular/router';
import { catchError, throwError } from 'rxjs';
import { apiErrorFromHttp } from './api-error';
import { SILENT_ERROR, SKIP_AUTH_REDIRECT, SKIP_ERROR_REPORT } from './http-context';
import { parseTraceParent } from './trace';
import { Notifier } from '../errors/notifier.service';
import { ClientErrorReporter } from '../errors/client-error-reporter.service';
import { AuthStore } from '../auth/auth.store';

/**
 * Normalises failures into ApiError (ProblemDetails + reference ID), shows a friendly toast,
 * redirects to sign-in on 401 and reports 5xx / network failures.
 */
export const errorInterceptor: HttpInterceptorFn = (req, next) => {
  const notifier = inject(Notifier);
  const reporter = inject(ClientErrorReporter);
  const router = inject(Router);
  const auth = inject(AuthStore);

  return next(req).pipe(
    catchError((err: unknown) => {
      if (!(err instanceof HttpErrorResponse)) return throwError(() => err);
      const requestTrace = parseTraceParent(req.headers.get('traceparent'))?.traceId ?? null;
      const apiError = apiErrorFromHttp(err, requestTrace);

      if ((err.status === 0 || err.status >= 500) && !req.context.get(SKIP_ERROR_REPORT)) {
        reporter.report({
          kind: 'http',
          message: `HTTP ${err.status} ${req.method} ${apiError.code}`,
          traceId: apiError.traceId ?? requestTrace ?? undefined,
          status: err.status,
          url: req.url,
        });
      }

      if (err.status === 401 && !req.context.get(SKIP_AUTH_REDIRECT)) {
        auth.clear();
        const current = router.url;
        if (!current.startsWith('/auth/')) {
          void router.navigate(['/auth/sign-in'], { queryParams: { returnUrl: current } });
        }
        return throwError(() => apiError);
      }

      if (!req.context.get(SILENT_ERROR)) notifier.error(apiError);
      return throwError(() => apiError);
    }),
  );
};
