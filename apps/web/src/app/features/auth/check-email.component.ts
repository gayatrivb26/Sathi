import { ChangeDetectionStrategy, Component, DestroyRef, inject, input, signal } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { RouterLink } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import { environment } from '../../../environments/environment';
import { AuthApi } from '../../core/api/auth.api';
import { IconComponent } from '../../shared/ui/icon/icon.component';

@Component({
  selector: 'app-check-email',
  imports: [RouterLink, MatButtonModule, IconComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  styleUrl: './auth-shared.scss',
  template: `
    <div class="big-icon"><app-icon name="mail" [size]="30" /></div>
    @if (guardian()) {
      <h1>Check your email — and ask your parent or guardian</h1>
      <p class="lede">Two quick steps before you can sign in:</p>
      <ol class="steps-list">
        <li>
          <span class="n" aria-hidden="true">1</span>
          <span><strong>You:</strong> open the verification link we sent to <strong>{{ email() || 'your inbox' }}</strong>.</span>
        </li>
        <li>
          <span class="n" aria-hidden="true">2</span>
          <span><strong>Your parent or guardian:</strong> we emailed them a link to approve your account. Ask them to look for an email from Sathi (it may be in spam). It works for 7 days.</span>
        </li>
      </ol>
      <p class="muted small">You can sign in as soon as both are done. If they didn’t get the email, you can send it again from the sign-in page.</p>
    } @else {
      <h1>Check your email</h1>
      <p class="lede">
        We sent a verification link to <strong>{{ email() || 'your inbox' }}</strong>. Open it to activate your account — it can take a minute to arrive.
      </p>
    }
    <p class="muted small">Can’t find it? Check spam or promotions, or send it again.</p>
    <div class="links">
      <button matButton="outlined" type="button" (click)="resend()" [disabled]="cooldown() > 0 || !email()">
        {{ cooldown() > 0 ? 'Sent · resend in ' + cooldown() + 's' : 'Resend email' }}
      </button>
      <a routerLink="/auth/sign-in">Back to sign in</a>
    </div>
    @if (demoLink) {
      <div class="demo">
        <p>Demo mode — no email is sent</p>
        <div class="accounts">
          <a matButton="outlined" [href]="demoLink">Open the verification link</a>
          @if (guardian() && demoConsentLink) {
            <a matButton="outlined" [href]="demoConsentLink">Open the guardian’s link</a>
          }
        </div>
      </div>
    }
    <p class="sr-only" role="status">{{ cooldown() > 0 ? 'Verification email sent again.' : '' }}</p>
  `,
})
export default class CheckEmailComponent {
  private readonly api = inject(AuthApi);
  readonly email = input<string>('');
  /** `?guardian=1` after registering a learner under 18 (contracts.md §11.4). */
  readonly guardian = input(false, { transform: (v: unknown) => v === true || v === '1' || v === 'true' });
  readonly demoConsentLink = environment.mockApi ? readDemo('sathi.mock.lastConsentLink') : null;
  readonly cooldown = signal(0);
  /** Mock build only: the mock API stores the link it would have emailed. */
  readonly demoLink = environment.mockApi ? readDemoLink() : null;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor() {
    inject(DestroyRef).onDestroy(() => this.timer && clearInterval(this.timer));
  }

  async resend(): Promise<void> {
    await firstValueFrom(this.api.resendVerification(this.email())).catch(() => undefined);
    this.cooldown.set(60);
    this.timer = setInterval(() => {
      this.cooldown.update((c) => c - 1);
      if (this.cooldown() <= 0 && this.timer) clearInterval(this.timer);
    }, 1000);
  }
}

function readDemoLink(): string | null {
  return readDemo('sathi.mock.lastVerifyLink');
}

function readDemo(key: string): string | null {
  try {
    return sessionStorage.getItem(key);
  } catch {
    return null;
  }
}
