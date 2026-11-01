import { computed, DestroyRef, inject, signal, Signal } from '@angular/core';
import { Observable, Subscription } from 'rxjs';
import { ApiError, toApiError } from '../http/api-error';

export type LoadStatus = 'idle' | 'loading' | 'ready' | 'error';

export interface Loader<T> {
  readonly status: Signal<LoadStatus>;
  readonly data: Signal<T | undefined>;
  readonly error: Signal<ApiError | null>;
  readonly loading: Signal<boolean>;
  /** True when loading has taken longer than `slowAfterMs`. */
  readonly slow: Signal<boolean>;
  load(): void;
  set(value: T): void;
  update(fn: (value: T) => T): void;
}

/**
 * Tiny signal-based async state for a screen: loading / ready / error / slow, with retry.
 * Must be created in an injection context (component field initialiser).
 */
export function createLoader<T>(source: () => Observable<T>, opts: { immediate?: boolean; slowAfterMs?: number } = {}): Loader<T> {
  const status = signal<LoadStatus>('idle');
  const data = signal<T | undefined>(undefined);
  const error = signal<ApiError | null>(null);
  const slow = signal(false);
  let sub: Subscription | null = null;
  let slowTimer: ReturnType<typeof setTimeout> | null = null;

  const clearSlow = () => {
    if (slowTimer) clearTimeout(slowTimer);
    slowTimer = null;
    slow.set(false);
  };

  const load = () => {
    sub?.unsubscribe();
    clearSlow();
    status.set('loading');
    error.set(null);
    slowTimer = setTimeout(() => slow.set(true), opts.slowAfterMs ?? 6000);
    sub = source().subscribe({
      next: (v) => {
        data.set(v);
        status.set('ready');
        clearSlow();
      },
      error: (e: unknown) => {
        error.set(toApiError(e));
        status.set('error');
        clearSlow();
      },
    });
  };

  inject(DestroyRef).onDestroy(() => {
    sub?.unsubscribe();
    clearSlow();
  });

  if (opts.immediate !== false) load();

  return {
    status: status.asReadonly(),
    data: data.asReadonly(),
    error: error.asReadonly(),
    loading: computed(() => status() === 'loading'),
    slow: slow.asReadonly(),
    load,
    set: (v: T) => {
      data.set(v);
      status.set('ready');
    },
    update: (fn: (v: T) => T) => {
      const v = data();
      if (v !== undefined) data.set(fn(v));
    },
  };
}
