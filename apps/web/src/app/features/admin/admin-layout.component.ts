import { ChangeDetectionStrategy, Component } from '@angular/core';
import { RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';
import { IconComponent } from '../../shared/ui/icon/icon.component';

@Component({
  selector: 'app-admin-layout',
  imports: [RouterOutlet, RouterLink, RouterLinkActive, IconComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="page">
      <header class="page-head">
        <div>
          <p class="eyebrow">Admin</p>
          <h1>Admin</h1>
          <p class="sub">Manage people and their roles, and trace any problem a student reports to the exact run, step and log line.</p>
        </div>
        <a class="ext" href="/hangfire" target="_blank" rel="noopener"><app-icon name="jobs" [size]="16" /> Hangfire jobs <app-icon name="external" [size]="14" /><span class="sr-only"> (opens in a new tab)</span></a>
      </header>
      <nav class="tabs-nav" aria-label="Admin sections">
        <a routerLink="users" routerLinkActive="active" ariaCurrentWhenActive="page"><app-icon name="users" [size]="18" /> Users</a>
        <a routerLink="staff-invites" routerLinkActive="active" ariaCurrentWhenActive="page"><app-icon name="mail-plus" [size]="18" /> Staff invites</a>
        <a routerLink="lookup" routerLinkActive="active" ariaCurrentWhenActive="page"><app-icon name="search" [size]="18" /> Look up a reference</a>
        <a routerLink="runs" routerLinkActive="active" ariaCurrentWhenActive="page"><app-icon name="alert" [size]="18" /> Recent runs</a>
        <a routerLink="usage" routerLinkActive="active" ariaCurrentWhenActive="page"><app-icon name="gauge" [size]="18" /> Usage</a>
      </nav>
      <router-outlet />
    </div>
  `,
  styles: `
    .ext {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      min-height: 44px;
      font-weight: 600;
      font-size: 0.9rem;
    }
  `,
})
export class AdminLayoutComponent {}
