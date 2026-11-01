import { effect, Injectable, signal } from '@angular/core';

export type ThemePreference = 'system' | 'light' | 'dark';
const KEY = 'sathi.theme';

function readStored(): ThemePreference {
  try {
    const v = localStorage.getItem(KEY);
    return v === 'light' || v === 'dark' || v === 'system' ? v : 'system';
  } catch {
    return 'system';
  }
}

/** Light / dark / follow-system theme. Stored per browser (a convenience, not account data). */
@Injectable({ providedIn: 'root' })
export class ThemeService {
  readonly preference = signal<ThemePreference>(readStored());

  constructor() {
    effect(() => {
      const pref = this.preference();
      const root = document.documentElement;
      if (pref === 'system') root.removeAttribute('data-theme');
      else root.setAttribute('data-theme', pref);
      try {
        localStorage.setItem(KEY, pref);
      } catch {
        /* storage unavailable */
      }
    });
  }

  set(pref: ThemePreference): void {
    this.preference.set(pref);
  }
}
