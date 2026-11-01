import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { RouterLink } from '@angular/router';
import { AuthStore } from '../../core/auth/auth.store';
import { IconComponent } from '../../shared/ui/icon/icon.component';
import { LogoComponent } from '../../shared/ui/logo/logo.component';

@Component({
  selector: 'app-not-found',
  imports: [RouterLink, MatButtonModule, IconComponent, LogoComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <main id="main-content" class="nf" tabindex="-1">
      <app-logo />
      <div class="card box">
        <span class="badge" aria-hidden="true"><app-icon name="compass" [size]="34" /></span>
        <p class="code num" aria-hidden="true">404</p>
        <h1>We couldn’t find that page</h1>
        <p class="muted">The link may be old, or the page may have moved. Let’s get you back on track.</p>
        <div class="row">
          <a matButton="filled" [routerLink]="auth.signedIn() ? '/home' : '/auth/sign-in'">{{ auth.signedIn() ? 'Go to home' : 'Sign in' }}</a>
          @if (auth.signedIn()) { <a matButton="outlined" routerLink="/tutor">Ask the tutor</a> }
        </div>
      </div>
    </main>
  `,
  styles: `
    .nf {
      min-height: 100vh;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      gap: 24px;
      padding: 24px 16px;
      outline: none;
    }
    .box {
      max-width: 480px;
      text-align: center;
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 10px;
      padding: 36px 28px;
    }
    .badge {
      display: grid;
      place-items: center;
      width: 72px;
      height: 72px;
      border-radius: 24px;
      background: var(--amber-soft);
      color: var(--amber-ink);
    }
    .code {
      font-family: var(--font-head);
      font-size: 0.9rem;
      font-weight: 700;
      letter-spacing: 0.2em;
      color: var(--muted);
    }
    .row {
      justify-content: center;
      margin-top: 8px;
    }
  `,
})
export default class NotFoundComponent {
  readonly auth = inject(AuthStore);
}
