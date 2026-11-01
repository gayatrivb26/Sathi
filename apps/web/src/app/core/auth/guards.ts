import { inject } from '@angular/core';
import { CanActivateFn, Router } from '@angular/router';
import { Role } from '../models/api.models';
import { AuthStore } from './auth.store';

/** Signed-in users only; otherwise → /auth/sign-in?returnUrl=… */
export const authGuard: CanActivateFn = async (_route, state) => {
  const auth = inject(AuthStore);
  const router = inject(Router);
  const me = await auth.ensureLoaded();
  if (me) return true;
  return router.createUrlTree(['/auth/sign-in'], { queryParams: { returnUrl: state.url } });
};

/**
 * Signed-out users only (sign-in, register…). Signed-in users go home — except a staff-invite
 * registration link (§11.2), which signed-in users accept on /staff-invite/:token instead.
 */
export const guestGuard: CanActivateFn = async (route) => {
  const auth = inject(AuthStore);
  const router = inject(Router);
  const me = await auth.ensureLoaded();
  if (!me) return true;
  const staffInvite = route.queryParamMap?.get('staffInvite');
  return staffInvite ? router.createUrlTree(['/staff-invite', staffInvite]) : router.createUrlTree(['/home']);
};

/** Requires at least one of `route.data.roles`. */
export const roleGuard: CanActivateFn = async (route) => {
  const auth = inject(AuthStore);
  const router = inject(Router);
  await auth.ensureLoaded();
  const roles = (route.data?.['roles'] as Role[] | undefined) ?? [];
  if (roles.length === 0 || auth.hasAnyRole(roles)) return true;
  return router.createUrlTree(['/home']);
};

/** Students who haven't finished onboarding are sent to /onboarding. */
export const onboardingGuard: CanActivateFn = async () => {
  const auth = inject(AuthStore);
  const router = inject(Router);
  await auth.ensureLoaded();
  return auth.needsOnboarding() ? router.createUrlTree(['/onboarding']) : true;
};
