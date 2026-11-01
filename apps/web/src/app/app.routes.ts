import { Routes } from '@angular/router';
import { authGuard, onboardingGuard, roleGuard } from './core/auth/guards';
import { PublicLayoutComponent } from './layout/public-layout.component';
import { ShellComponent } from './layout/shell.component';

export const routes: Routes = [
  { path: 'auth', loadChildren: () => import('./features/auth/auth.routes') },
  {
    path: 'onboarding',
    title: 'Get started',
    canActivate: [authGuard],
    loadComponent: () => import('./features/onboarding/onboarding.component'),
  },
  // Pages reached from links (class codes and invites, guardian consent, staff invites). Not behind onboarding.
  {
    path: '',
    component: PublicLayoutComponent,
    children: [
      { path: 'join', title: 'Join a class', loadComponent: () => import('./features/classes/join-class.component') },
      { path: 'join/:token', title: 'Class invite', loadComponent: () => import('./features/classes/class-invite.component') },
      { path: 'consent/:token', title: 'Approve a learner’s account', loadComponent: () => import('./features/consent/guardian-consent.component') },
      { path: 'staff-invite/:token', title: 'Staff invite', canActivate: [authGuard], loadComponent: () => import('./features/auth/staff-invite.component') },
    ],
  },
  {
    path: '',
    component: ShellComponent,
    canActivate: [authGuard],
    canActivateChild: [onboardingGuard],
    children: [
      { path: '', pathMatch: 'full', redirectTo: 'home' },
      { path: 'home', title: 'Home', loadComponent: () => import('./features/home/home.component') },
      { path: 'course', title: 'Course', loadComponent: () => import('./features/course/course.component') },
      { path: 'lessons/:lessonId', title: 'Lesson', loadComponent: () => import('./features/lesson/lesson.component') },
      { path: 'tutor', title: 'Tutor', loadComponent: () => import('./features/tutor/tutor.component') },
      { path: 'practice', title: 'Practice', loadComponent: () => import('./features/practice/practice-picker.component') },
      { path: 'practice/:attemptId', title: 'Practice quiz', loadComponent: () => import('./features/practice/practice-session.component') },
      { path: 'practice/:attemptId/summary', title: 'Quiz summary', loadComponent: () => import('./features/practice/practice-summary.component') },
      { path: 'revision', title: 'Revision', loadComponent: () => import('./features/revision/revision.component') },
      { path: 'notes', title: 'My notes', loadComponent: () => import('./features/notes/notes.component') },
      { path: 'progress', title: 'Progress', loadComponent: () => import('./features/progress/progress.component') },
      { path: 'settings', title: 'Settings', loadComponent: () => import('./features/settings/settings.component') },
      {
        path: 'teach',
        canActivate: [roleGuard],
        data: { roles: ['Instructor', 'Admin'] },
        loadChildren: () => import('./features/teach/teach.routes'),
      },
      {
        path: 'admin',
        canActivate: [roleGuard],
        data: { roles: ['Admin'] },
        loadChildren: () => import('./features/admin/admin.routes'),
      },
    ],
  },
  { path: '**', title: 'Page not found', loadComponent: () => import('./features/not-found/not-found.component') },
];
