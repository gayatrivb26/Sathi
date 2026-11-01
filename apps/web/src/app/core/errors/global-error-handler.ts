import { ErrorHandler, inject, Injectable, Injector } from '@angular/core';
import { ApiError } from '../http/api-error';
import { ClientErrorReporter } from './client-error-reporter.service';

/** Logs unhandled errors to the console and reports them (without user content). */
@Injectable()
export class GlobalErrorHandler implements ErrorHandler {
  private readonly injector = inject(Injector);

  handleError(error: unknown): void {
    console.error(error);
    // API errors are already reported by the HTTP layer.
    if (error instanceof ApiError) return;
    try {
      const e = error as { name?: string; message?: string } | null;
      const message = `${e?.name ?? 'Error'}: ${e?.message ?? String(error)}`;
      this.injector.get(ClientErrorReporter).report({ kind: 'unhandled', message });
    } catch {
      /* never throw from the error handler */
    }
  }
}
