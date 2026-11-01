import { ChangeDetectionStrategy, Component, computed, DestroyRef, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { MatButtonModule } from '@angular/material/button';
import { MatMenuModule } from '@angular/material/menu';
import { NavigationEnd, Router, RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';
import { filter } from 'rxjs';
import { AuthStore } from '../core/auth/auth.store';
import { IconComponent } from '../shared/ui/icon/icon.component';
import { IconName } from '../shared/ui/icon/icons';
import { LogoComponent } from '../shared/ui/logo/logo.component';
import { OfflineBannerComponent } from './offline-banner.component';

export interface NavItem {
  path: string;
  label: string;
  icon: IconName;
  mobile?: boolean; // shown in the phone bottom bar
  /** Opens outside the Angular app in a new tab (e.g. the Hangfire dashboard). */
  external?: boolean;
}

/** Staff navigation by role. The API enforces access; this only decides what to show. */
export function staffNavFor(roles: readonly string[]): NavItem[] {
  const admin = roles.includes('Admin');
  const items: NavItem[] = [];
  if (admin || roles.includes('Instructor')) items.push({ path: '/teach', label: 'Teach', icon: 'teach' });
  if (admin) {
    items.push({ path: '/admin', label: 'Admin', icon: 'shield' });
    items.push({ path: '/hangfire', label: 'Hangfire jobs', icon: 'jobs', external: true });
  }
  return items;
}

@Component({
  selector: 'app-shell',
  imports: [RouterOutlet, RouterLink, RouterLinkActive, MatMenuModule, MatButtonModule, IconComponent, LogoComponent, OfflineBannerComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './shell.component.html',
  styleUrl: './shell.component.scss',
})
export class ShellComponent {
  readonly auth = inject(AuthStore);
  private readonly router = inject(Router);

  readonly studentNav: NavItem[] = [
    { path: '/home', label: 'Home', icon: 'compass', mobile: true },
    { path: '/tutor', label: 'Tutor', icon: 'tutor', mobile: true },
    { path: '/practice', label: 'Practice', icon: 'target', mobile: true },
    { path: '/revision', label: 'Revision', icon: 'repeat' },
    { path: '/notes', label: 'Notes', icon: 'notes', mobile: true },
    { path: '/progress', label: 'Progress', icon: 'chart' },
  ];
  readonly staffNav = computed<NavItem[]>(() => staffNavFor(this.auth.roles()));
  readonly mobileNav = this.studentNav.filter((n) => n.mobile);
  readonly moreNav = computed<NavItem[]>(() => [
    ...this.studentNav.filter((n) => !n.mobile),
    ...this.staffNav(),
    { path: '/settings', label: 'Settings', icon: 'settings' },
  ]);
  readonly moreActive = signal(false);
  readonly initials = computed(() =>
    (this.auth.me()?.displayName ?? '?')
      .split(/\s+/)
      .map((p) => p[0])
      .slice(0, 2)
      .join('')
      .toUpperCase(),
  );

  constructor() {
    let first = true;
    this.router.events
      .pipe(
        filter((e): e is NavigationEnd => e instanceof NavigationEnd),
        takeUntilDestroyed(inject(DestroyRef)),
      )
      .subscribe((e) => {
        const url = e.urlAfterRedirects;
        this.moreActive.set(this.moreNav().some((n) => !n.external && url.startsWith(n.path)));
        if (first) {
          first = false;
          return;
        }
        // Move focus to the new page so keyboard and screen-reader users start at the content.
        setTimeout(() => document.getElementById('main-content')?.focus({ preventScroll: true }));
        window.scrollTo({ top: 0 });
      });
  }

  async signOut(): Promise<void> {
    await this.auth.logout();
    await this.router.navigate(['/auth/sign-in']);
  }
}
