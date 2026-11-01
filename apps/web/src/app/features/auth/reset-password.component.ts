import { ChangeDetectionStrategy, Component, computed, inject, input, signal } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { NonNullableFormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { RouterLink } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import { AuthApi } from '../../core/api/auth.api';
import { ApiError, toApiError } from '../../core/http/api-error';
import { IconComponent } from '../../shared/ui/icon/icon.component';
import { ReferenceIdComponent } from '../../shared/ui/reference-id/reference-id.component';
import { passwordPolicyValidator, passwordRules } from './password-rules';

@Component({
  selector: 'app-reset-password',
  imports: [ReactiveFormsModule, RouterLink, MatFormFieldModule, MatInputModule, MatButtonModule, IconComponent, ReferenceIdComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  styleUrl: './auth-shared.scss',
  template: `
    @if (done()) {
      <div class="big-icon ok"><app-icon name="check-circle" [size]="30" /></div>
      <h1>Password updated</h1>
      <p class="lede">You can now sign in with your new password.</p>
      <a matButton="filled" class="submit" routerLink="/auth/sign-in">Sign in</a>
    } @else {
      <h1>Choose a new password</h1>
      <p class="lede">For <strong>{{ email() || 'your account' }}</strong>.</p>
      @if (error(); as e) {
        <div class="form-error" role="alert">
          <app-icon name="alert" [size]="18" />
          <div>
            <p>{{ e.userMessage }}</p>
            @if (e.code === 'AUTH_INVALID_TOKEN') {
              <a routerLink="/auth/forgot-password">Request a new link</a>
            } @else {
              <app-reference-id [referenceId]="e.referenceId" />
            }
          </div>
        </div>
      }
      <form [formGroup]="form" (ngSubmit)="submit()" novalidate>
        <mat-form-field>
          <mat-label>New password</mat-label>
          <input matInput [type]="showPw() ? 'text' : 'password'" formControlName="password" autocomplete="new-password" required aria-describedby="pw-rules" />
          <button matIconButton matSuffix type="button" (click)="showPw.set(!showPw())" [attr.aria-label]="showPw() ? 'Hide password' : 'Show password'" [attr.aria-pressed]="showPw()">
            <app-icon [name]="showPw() ? 'eye' : 'lock'" [size]="18" />
          </button>
          @if (form.controls.password.hasError('passwordPolicy') || form.controls.password.hasError('required')) {
            <mat-error>Your password doesn’t meet the rules below yet.</mat-error>
          }
        </mat-form-field>
        <ul class="rules" id="pw-rules" aria-label="Password rules">
          @for (r of rules(); track r.label) {
            <li [class.ok]="r.ok">
              <app-icon [name]="r.ok ? 'check-circle' : 'x-circle'" [size]="16" />
              {{ r.label }}<span class="sr-only">{{ r.ok ? ' — met' : ' — not met yet' }}</span>
            </li>
          }
        </ul>
        <button matButton="filled" class="submit" type="submit" [disabled]="busy() || !token()">{{ busy() ? 'Saving…' : 'Save new password' }}</button>
      </form>
      @if (!token()) {
        <p class="muted small">This page needs the link from your email. <a routerLink="/auth/forgot-password">Request a new link</a>.</p>
      }
    }
  `,
})
export default class ResetPasswordComponent {
  private readonly api = inject(AuthApi);
  readonly email = input<string>('');
  readonly token = input<string>('');
  readonly form = inject(NonNullableFormBuilder).group({ password: ['', [Validators.required, passwordPolicyValidator]] });
  private readonly pw = toSignal(this.form.controls.password.valueChanges, { initialValue: '' });
  readonly rules = computed(() => passwordRules(this.pw()));
  readonly showPw = signal(false);
  readonly busy = signal(false);
  readonly done = signal(false);
  readonly error = signal<ApiError | null>(null);

  async submit(): Promise<void> {
    if (this.form.invalid) {
      this.form.markAllAsTouched();
      return;
    }
    this.busy.set(true);
    this.error.set(null);
    try {
      await firstValueFrom(this.api.resetPassword(this.email(), this.token(), this.form.controls.password.value));
      this.done.set(true);
    } catch (e) {
      this.error.set(toApiError(e));
    } finally {
      this.busy.set(false);
    }
  }
}
