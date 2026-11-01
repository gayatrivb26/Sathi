import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { ActivatedRouteSnapshot, convertToParamMap, provideRouter, Router, RouterStateSnapshot, UrlTree } from '@angular/router';
import { Me } from '../models/api.models';
import { AuthStore } from './auth.store';
import { authGuard, guestGuard, onboardingGuard, roleGuard } from './guards';

const ME: Me = {
  id: 'u1',
  email: 'asha@example.com',
  displayName: 'Asha',
  roles: ['Student'],
  emailConfirmed: true,
  preferences: { level: 'beginner', timezone: 'Asia/Kolkata', reminderHour: 18, remindersEnabled: true, activeCourseId: 'c1' },
  onboardingCompleted: true,
  isMinor: false,
};

class FakeAuthStore {
  current: Me | null = null;
  ensureLoaded = () => Promise.resolve(this.current);
  hasAnyRole = (roles: string[]) => roles.some((r) => this.current?.roles.includes(r as never));
  needsOnboarding = () => !!this.current && !this.current.onboardingCompleted && !this.current.roles.some((r) => r !== 'Student');
}

function run(guard: typeof authGuard, url = '/tutor', data: Record<string, unknown> = {}, query: Record<string, string> = {}) {
  const route = { data, queryParamMap: convertToParamMap(query) } as unknown as ActivatedRouteSnapshot;
  const state = { url } as RouterStateSnapshot;
  return TestBed.runInInjectionContext(() => guard(route, state)) as Promise<boolean | UrlTree>;
}

describe('route guards', () => {
  let auth: FakeAuthStore;
  let router: Router;

  beforeEach(() => {
    auth = new FakeAuthStore();
    TestBed.configureTestingModule({
      providers: [provideZonelessChangeDetection(), provideRouter([]), { provide: AuthStore, useValue: auth }],
    });
    router = TestBed.inject(Router);
  });

  it('authGuard redirects signed-out users to sign-in with returnUrl', async () => {
    const result = await run(authGuard, '/tutor?conversation=abc');
    expect(result).toBeInstanceOf(UrlTree);
    expect(router.serializeUrl(result as UrlTree)).toBe('/auth/sign-in?returnUrl=%2Ftutor%3Fconversation%3Dabc');
  });

  it('authGuard lets signed-in users through', async () => {
    auth.current = ME;
    expect(await run(authGuard)).toBe(true);
  });

  it('guestGuard sends signed-in users home', async () => {
    auth.current = ME;
    expect(router.serializeUrl((await run(guestGuard)) as UrlTree)).toBe('/home');
  });

  it('guestGuard sends signed-in users with a staff invite link to the accept page', async () => {
    auth.current = ME;
    const result = await run(guestGuard, '/auth/register?staffInvite=tok123', {}, { staffInvite: 'tok123' });
    expect(router.serializeUrl(result as UrlTree)).toBe('/staff-invite/tok123');
  });

  it('guestGuard lets signed-out users open a staff invite registration', async () => {
    expect(await run(guestGuard, '/auth/register?staffInvite=tok123', {}, { staffInvite: 'tok123' })).toBe(true);
  });

  it('roleGuard blocks students from staff areas', async () => {
    auth.current = ME;
    const result = await run(roleGuard, '/admin', { roles: ['Admin'] });
    expect(router.serializeUrl(result as UrlTree)).toBe('/home');
  });

  it('roleGuard allows instructors into Teach', async () => {
    auth.current = { ...ME, roles: ['Student', 'Instructor'] };
    expect(await run(roleGuard, '/teach', { roles: ['Instructor', 'Admin'] })).toBe(true);
  });

  it('onboardingGuard sends new students to onboarding', async () => {
    auth.current = { ...ME, onboardingCompleted: false };
    expect(router.serializeUrl((await run(onboardingGuard)) as UrlTree)).toBe('/onboarding');
  });

  it('onboardingGuard lets onboarded students through', async () => {
    auth.current = ME;
    expect(await run(onboardingGuard)).toBe(true);
  });
});
