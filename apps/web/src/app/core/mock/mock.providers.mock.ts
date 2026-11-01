import { HttpInterceptorFn } from '@angular/common/http';
import { Provider } from '@angular/core';
import { FETCH } from '../sse/sse-client.service';
import { getMockDb, mockApiInterceptor } from './mock-api.interceptor';
import { createMockFetch } from './mock-tutor';

/** Mock build only (angular.json `mock` configuration replaces mock.providers.ts with this file). */
export const MOCK_INTERCEPTORS: HttpInterceptorFn[] = [mockApiInterceptor];
export const MOCK_PROVIDERS: Provider[] = [
  { provide: FETCH, useFactory: () => createMockFetch(getMockDb, (input, init) => globalThis.fetch(input, init)) },
];
