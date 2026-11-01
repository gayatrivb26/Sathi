import { provideHttpClient, withInterceptors, withXsrfConfiguration } from '@angular/common/http';
import {
  ApplicationConfig,
  ErrorHandler,
  inject,
  provideAppInitializer,
  provideBrowserGlobalErrorListeners,
  provideZonelessChangeDetection,
} from '@angular/core';
import { MAT_FORM_FIELD_DEFAULT_OPTIONS } from '@angular/material/form-field';
import { provideRouter, TitleStrategy, withComponentInputBinding, withInMemoryScrolling } from '@angular/router';
import { routes } from './app.routes';
import { AuthStore } from './core/auth/auth.store';
import { GlobalErrorHandler } from './core/errors/global-error-handler';
import { errorInterceptor } from './core/http/error.interceptor';
import { traceInterceptor } from './core/http/trace.interceptor';
import { MOCK_INTERCEPTORS, MOCK_PROVIDERS } from './core/mock/mock.providers';
import { SathiTitleStrategy } from './core/platform/title-strategy';

export const appConfig: ApplicationConfig = {
  providers: [
    provideBrowserGlobalErrorListeners(),
    provideZonelessChangeDetection(),
    provideRouter(routes, withComponentInputBinding(), withInMemoryScrolling({ scrollPositionRestoration: 'top' })),
    provideHttpClient(
      // Order matters: trace → error handling → (mock backend, only in the mock build).
      withInterceptors([traceInterceptor, errorInterceptor, ...MOCK_INTERCEPTORS]),
      withXsrfConfiguration({ cookieName: 'XSRF-TOKEN', headerName: 'X-XSRF-TOKEN' }),
    ),
    { provide: ErrorHandler, useClass: GlobalErrorHandler },
    { provide: TitleStrategy, useClass: SathiTitleStrategy },
    { provide: MAT_FORM_FIELD_DEFAULT_OPTIONS, useValue: { appearance: 'outline', subscriptSizing: 'dynamic' } },
    ...MOCK_PROVIDERS,
    // Issue the CSRF cookie and load the signed-in user before the first route resolves.
    provideAppInitializer(() => inject(AuthStore).init()),
  ],
};
