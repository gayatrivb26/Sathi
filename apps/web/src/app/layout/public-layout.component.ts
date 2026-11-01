import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { RouterLink, RouterOutlet } from '@angular/router';
import { AuthStore } from '../core/auth/auth.store';
import { LogoComponent } from '../shared/ui/logo/logo.component';
import { OfflineBannerComponent } from './offline-banner.component';

/** Minimal, calm frame for pages people reach from a link: join a class, guardian consent, staff invites. */
@Component({
  selector: 'app-public-layout',
  imports: [RouterOutlet, RouterLink, MatButtonModule, LogoComponent, OfflineBannerComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <a class="skip-link" href="#main-content">Skip to main content</a>
    <header class="top">
      <a [routerLink]="auth.signedIn() ? '/home' : '/auth/sign-in'" aria-label="Sathi home"><app-logo /></a>
      @if (auth.signedIn()) {
        <span class="who muted small">Signed in as {{ auth.me()?.email }}</span>
      }
    </header>
    <main id="main-content" tabindex="-1" class="wrap">
      <app-offline-banner />
      <router-outlet />
    </main>
    <footer class="foot muted small">Sathi has no advertising and no behavioural tracking. Learning data is used only for tutoring.</footer>
  `,
  styles: `
    :host {
      display: flex;
      flex-direction: column;
      min-height: 100vh;
      background: var(--bg);
    }
    .top {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      padding: 16px var(--gutter);
      border-bottom: 1px solid var(--border);
      background: var(--surface);
      @media (max-width: 719.98px) {
        padding: 12px 16px;
      }
    }
    .who {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      min-width: 0;
    }
    .wrap {
      flex: 1;
      width: 100%;
      max-width: 640px;
      margin: 0 auto;
      padding: 36px 16px 40px;
      outline: none;
      @media (max-width: 719.98px) {
        padding: 18px 12px 28px;
      }
    }
    .foot {
      text-align: center;
      padding: 18px 16px 24px;
    }
  `,
})
export class PublicLayoutComponent {
  readonly auth = inject(AuthStore);
}
