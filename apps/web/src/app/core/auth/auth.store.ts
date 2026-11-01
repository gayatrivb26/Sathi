import { computed, inject, Injectable, signal } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { AuthApi } from '../api/auth.api';
import { Me, PreferencesUpdate, Role } from '../models/api.models';

/** Signed-in user state. `me()` is `undefined` until the first /auth/me answer, then `Me | null`. */
@Injectable({ providedIn: 'root' })
export class AuthStore {
  private readonly api = inject(AuthApi);
  private readonly _me = signal<Me | null | undefined>(undefined);
  private loading: Promise<Me | null> | null = null;

  readonly me = this._me.asReadonly();
  readonly signedIn = computed(() => !!this._me());
  readonly roles = computed<Role[]>(() => this._me()?.roles ?? []);
  readonly isInstructor = computed(() => this.roles().includes('Instructor') || this.roles().includes('Admin'));
  readonly isAdmin = computed(() => this.roles().includes('Admin'));
  readonly firstName = computed(() => (this._me()?.displayName ?? '').split(' ')[0] || 'there');
  readonly activeCourseId = computed(() => this._me()?.preferences.activeCourseId ?? null);

  /** Startup: (re)issue the CSRF cookie, then load the current user. Never throws. */
  async init(): Promise<void> {
    await firstValueFrom(this.api.csrf()).catch(() => undefined);
    await this.ensureLoaded();
  }

  /** Resolves the current user once; later calls reuse the result. */
  ensureLoaded(): Promise<Me | null> {
    const current = this._me();
    if (current !== undefined) return Promise.resolve(current);
    if (!this.loading) {
      this.loading = firstValueFrom(this.api.me())
        .then((me) => me)
        .catch(() => null)
        .then((me) => {
          this._me.set(me);
          this.loading = null;
          return me;
        });
    }
    return this.loading;
  }

  async refresh(): Promise<Me | null> {
    const me = await firstValueFrom(this.api.me()).catch(() => null);
    this._me.set(me);
    return me;
  }

  async login(email: string, password: string, rememberMe: boolean): Promise<Me> {
    const me = await firstValueFrom(this.api.login({ email, password, rememberMe }));
    this._me.set(me);
    await firstValueFrom(this.api.csrf()).catch(() => undefined);
    return me;
  }

  async logout(): Promise<void> {
    await firstValueFrom(this.api.logout()).catch(() => undefined);
    this._me.set(null);
    await firstValueFrom(this.api.csrf()).catch(() => undefined);
  }

  async updatePreferences(update: PreferencesUpdate): Promise<Me> {
    const me = await firstValueFrom(this.api.updatePreferences(update));
    this._me.set(me);
    return me;
  }

  set(me: Me | null): void {
    this._me.set(me);
  }

  /** Called on 401: the session is gone. */
  clear(): void {
    if (this._me() !== undefined) this._me.set(null);
  }

  hasAnyRole(roles: Role[]): boolean {
    return roles.some((r) => this.roles().includes(r));
  }

  /** Students must finish onboarding (course + level + diagnostic); staff may skip it. */
  needsOnboarding(): boolean {
    const me = this._me();
    if (!me) return false;
    if (me.roles.includes('Instructor') || me.roles.includes('Admin')) return false;
    return !me.onboardingCompleted;
  }
}
