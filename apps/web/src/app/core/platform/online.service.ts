import { DestroyRef, inject, Injectable, signal } from '@angular/core';

/** `navigator.onLine` as a signal. */
@Injectable({ providedIn: 'root' })
export class OnlineService {
  private readonly _online = signal(typeof navigator === 'undefined' ? true : navigator.onLine);
  readonly online = this._online.asReadonly();

  constructor() {
    const on = () => this._online.set(true);
    const off = () => this._online.set(false);
    window.addEventListener('online', on);
    window.addEventListener('offline', off);
    inject(DestroyRef).onDestroy(() => {
      window.removeEventListener('online', on);
      window.removeEventListener('offline', off);
    });
  }
}
