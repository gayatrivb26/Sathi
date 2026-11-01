import { Routes } from '@angular/router';
import { guestGuard } from '../../core/auth/guards';
import { AuthLayoutComponent } from './auth-layout.component';

export default [
  {
    path: '',
    component: AuthLayoutComponent,
    children: [
      { path: '', pathMatch: 'full', redirectTo: 'sign-in' },
      { path: 'sign-in', title: 'Sign in', canActivate: [guestGuard], loadComponent: () => import('./sign-in.component') },
      { path: 'register', title: 'Create account', canActivate: [guestGuard], loadComponent: () => import('./register.component') },
      { path: 'check-email', title: 'Check your email', loadComponent: () => import('./check-email.component') },
      { path: 'verify-email', title: 'Verify email', loadComponent: () => import('./verify-email.component') },
      { path: 'forgot-password', title: 'Forgot password', loadComponent: () => import('./forgot-password.component') },
      { path: 'reset-password', title: 'Reset password', loadComponent: () => import('./reset-password.component') },
    ],
  },
] satisfies Routes;
