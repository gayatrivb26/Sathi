import { Routes } from '@angular/router';
import { TeachLayoutComponent } from './teach-layout.component';

export default [
  {
    path: '',
    component: TeachLayoutComponent,
    children: [
      { path: '', pathMatch: 'full', redirectTo: 'content' },
      { path: 'content', title: 'Teach · Content', loadComponent: () => import('./course-editor.component') },
      { path: 'classes', title: 'Teach · Classes', loadComponent: () => import('./classes.component') },
      { path: 'settings', title: 'Teach · Course settings', loadComponent: () => import('./course-settings.component') },
      { path: 'questions', title: 'Teach · Question bank', loadComponent: () => import('./question-bank.component') },
      { path: 'grading', title: 'Teach · Grading review', loadComponent: () => import('./grading-queue.component') },
      { path: 'insights', title: 'Teach · Class insights', loadComponent: () => import('./insights.component') },
    ],
  },
] satisfies Routes;
