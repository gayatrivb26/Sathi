import { HttpInterceptorFn } from '@angular/common/http';
import { inject } from '@angular/core';
import { TraceContext } from './trace-context.service';

/** Adds a fresh W3C `traceparent` to every same-origin API request (contracts.md §4). */
export const traceInterceptor: HttpInterceptorFn = (req, next) => {
  if (!req.url.startsWith('/api/') || req.headers.has('traceparent')) return next(req);
  const tp = inject(TraceContext).next();
  return next(req.clone({ setHeaders: { traceparent: tp.header } }));
};
