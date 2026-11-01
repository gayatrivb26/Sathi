import { HttpInterceptorFn } from '@angular/common/http';
import { Provider } from '@angular/core';

/**
 * Normal builds: no mock API. The `mock` build configuration swaps this file for
 * `mock.providers.mock.ts` (angular.json fileReplacements), so mock code is never bundled
 * into development or production builds.
 */
export const MOCK_INTERCEPTORS: HttpInterceptorFn[] = [];
export const MOCK_PROVIDERS: Provider[] = [];
