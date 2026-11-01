import { Routes } from '@angular/router';
import { AdminLayoutComponent } from './admin-layout.component';

export default [
  {
    path: '',
    component: AdminLayoutComponent,
    children: [
      { path: '', pathMatch: 'full', redirectTo: 'lookup' },
      { path: 'lookup', title: 'Admin · Look up a reference', loadComponent: () => import('./run-lookup.component') },
      { path: 'lookup/:ref', title: 'Admin · Run detail', loadComponent: () => import('./run-lookup.component') },
      { path: 'runs', title: 'Admin · Failed runs', loadComponent: () => import('./runs-list.component') },
      { path: 'usage', title: 'Admin · Usage', loadComponent: () => import('./usage.component') },
      { path: 'users', title: 'Admin · Users', loadComponent: () => import('./users.component') },
      { path: 'staff-invites', title: 'Admin · Staff invites', loadComponent: () => import('./staff-invites.component') },
    ],
  },
] satisfies Routes;
