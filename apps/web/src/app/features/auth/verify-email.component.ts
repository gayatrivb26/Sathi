import { ChangeDetectionStrategy, Component, inject, input, OnInit, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { RouterLink } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import { AuthApi } from '../../core/api/auth.api';
import { ApiError, toApiError } from '../../core/http/api-error';
import { IconComponent } from '../../shared/ui/icon/icon.component';
import { ReferenceIdComponent } from '../../shared/ui/reference-id/reference-id.component';

@Component({
  selector: 'app-verify-email',
  imports: [RouterLink, FormsModule, MatButtonModule, MatFormFieldModule, MatInputModule, IconComponent, ReferenceIdComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  styleUrl: './auth-shared.scss',
  template: `
    @switch (state()) {
      @case ('verifying') {
        <div class="big-icon" role="status" aria-label="Verifying"><app-icon name="loader" [size]="30" class="spin" /></div>
        <h1>Verifying your email…</h1>
        <p class="lede">This only takes a moment.</p>
      }
      @case ('done') {
        <div class="big-icon ok"><app-icon name="check-circle" [size]="30" /></div>
        <h1>You’re verified</h1>
        <p class="lede">Your email is confirmed. Sign in to choose your course.</p>
        <a matButton="filled" class="submit" routerLink="/auth/sign-in">Sign in</a>
      }
      @case ('failed') {
        <div class="big-icon bad"><app-icon name="alert" [size]="30" /></div>
        <h1>This link didn’t work</h1>
        <p class="lede">{{ error()?.userMessage }}</p>
        @if (error()?.status === 0 || (error()?.status ?? 0) >= 500) {
          <app-reference-id [referenceId]="error()?.referenceId" />
        }
        @if (sent()) {
          <div class="form-ok" role="status"><app-icon name="mail" [size]="18" /> If that account exists, a new link is on its way.</div>
        } @else {
          <form (ngSubmit)="resend()">
            <mat-form-field>
              <mat-label>Email</mat-label>
              <input matInput type="email" name="email" [(ngModel)]="email" autocomplete="email" required />
            </mat-form-field>
            <button matButton="filled" class="submit" type="submit" [disabled]="!email">Send a new link</button>
          </form>
        }
        <div class="links"><a routerLink="/auth/sign-in">Back to sign in</a></div>
      }
    }
  `,
})
export default class VerifyEmailComponent implements OnInit {
  private readonly api = inject(AuthApi);
  readonly userId = input<string>('');
  readonly token = input<string>('');
  readonly state = signal<'verifying' | 'done' | 'failed'>('verifying');
  readonly error = signal<ApiError | null>(null);
  readonly sent = signal(false);
  email = '';

  async ngOnInit(): Promise<void> {
    if (!this.userId() || !this.token()) {
      this.error.set(new ApiError({ status: 400, code: 'AUTH_INVALID_TOKEN' }));
      this.state.set('failed');
      return;
    }
    try {
      await firstValueFrom(this.api.verifyEmail(this.userId(), this.token()));
      this.state.set('done');
    } catch (e) {
      this.error.set(toApiError(e));
      this.state.set('failed');
    }
  }

  async resend(): Promise<void> {
    await firstValueFrom(this.api.resendVerification(this.email)).catch(() => undefined);
    this.sent.set(true);
  }
}
