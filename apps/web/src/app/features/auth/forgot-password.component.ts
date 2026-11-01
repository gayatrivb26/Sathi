import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
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

@Component({
  selector: 'app-forgot-password',
  imports: [ReactiveFormsModule, RouterLink, MatFormFieldModule, MatInputModule, MatButtonModule, IconComponent, ReferenceIdComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  styleUrl: './auth-shared.scss',
  template: `
    @if (sent()) {
      <div class="big-icon ok"><app-icon name="mail" [size]="30" /></div>
      <h1>Check your email</h1>
      <p class="lede">If an account exists for <strong>{{ form.controls.email.value }}</strong>, we’ve sent a link to reset your password. It expires in a few hours.</p>
      <div class="links"><a routerLink="/auth/sign-in">Back to sign in</a></div>
    } @else {
      <h1>Forgot your password?</h1>
      <p class="lede">Enter your email and we’ll send you a link to choose a new one.</p>
      @if (error(); as e) {
        <div class="form-error" role="alert">
          <app-icon name="alert" [size]="18" />
          <div><p>{{ e.userMessage }}</p><app-reference-id [referenceId]="e.referenceId" /></div>
        </div>
      }
      <form [formGroup]="form" (ngSubmit)="submit()" novalidate>
        <mat-form-field>
          <mat-label>Email</mat-label>
          <input matInput type="email" formControlName="email" autocomplete="email" required />
          @if (form.controls.email.hasError('required')) {
            <mat-error>Enter your email.</mat-error>
          } @else if (form.controls.email.hasError('email')) {
            <mat-error>That doesn’t look like an email address.</mat-error>
          }
        </mat-form-field>
        <button matButton="filled" class="submit" type="submit" [disabled]="busy()">{{ busy() ? 'Sending…' : 'Send reset link' }}</button>
      </form>
      <div class="links"><a routerLink="/auth/sign-in">Back to sign in</a></div>
    }
  `,
})
export default class ForgotPasswordComponent {
  private readonly api = inject(AuthApi);
  readonly form = inject(NonNullableFormBuilder).group({ email: ['', [Validators.required, Validators.email]] });
  readonly busy = signal(false);
  readonly sent = signal(false);
  readonly error = signal<ApiError | null>(null);

  async submit(): Promise<void> {
    if (this.form.invalid) {
      this.form.markAllAsTouched();
      return;
    }
    this.busy.set(true);
    this.error.set(null);
    try {
      await firstValueFrom(this.api.forgotPassword(this.form.controls.email.value.trim()));
      this.sent.set(true);
    } catch (e) {
      this.error.set(toApiError(e));
    } finally {
      this.busy.set(false);
    }
  }
}
