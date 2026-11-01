import { ChangeDetectionStrategy, Component, inject, input, signal } from '@angular/core';
import { NonNullableFormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatCheckboxModule } from '@angular/material/checkbox';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { Router, RouterLink } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import { environment } from '../../../environments/environment';
import { AuthApi } from '../../core/api/auth.api';
import { AuthStore } from '../../core/auth/auth.store';
import { ApiError, toApiError } from '../../core/http/api-error';
import { IconComponent } from '../../shared/ui/icon/icon.component';
import { ReferenceIdComponent } from '../../shared/ui/reference-id/reference-id.component';
import { safeReturnUrl, takeReturnUrl } from './return-url';

@Component({
  selector: 'app-sign-in',
  imports: [ReactiveFormsModule, RouterLink, MatFormFieldModule, MatInputModule, MatButtonModule, MatCheckboxModule, IconComponent, ReferenceIdComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  styleUrl: './auth-shared.scss',
  template: `
    <h1>Welcome back</h1>
    <p class="lede">Sign in to pick up where you left off.</p>

    @if (error(); as e) {
      <div class="form-error" role="alert">
        <app-icon name="alert" [size]="18" />
        <div>
          <p>{{ e.userMessage }}</p>
          @if (e.code === 'AUTH_EMAIL_NOT_CONFIRMED') {
            <button type="button" class="inline-btn" (click)="resend()">Resend the verification email</button>
          }
          @if (e.code === 'AUTH_GUARDIAN_CONSENT_PENDING') {
            <p class="small">Ask them to check their inbox (and spam) for an email from Sathi. The link works for 7 days.</p>
            <button type="button" class="inline-btn" (click)="resendGuardian()">Send the email to my parent or guardian again</button>
          }
          @if (e.code === 'AUTH_GUARDIAN_CONSENT_DECLINED') {
            <p class="small">If this was a mistake, your parent or guardian can help you create a new account.</p>
          }
          @if (e.status >= 500 || e.status === 0) {
            <app-reference-id [referenceId]="e.referenceId" />
          }
        </div>
      </div>
    }
    @if (resent()) {
      <div class="form-ok" role="status"><app-icon name="mail" [size]="18" /> If that account exists, a new link is on its way.</div>
    }
    @if (guardianResent()) {
      <div class="form-ok" role="status"><app-icon name="mail" [size]="18" /> We sent the approval email to your parent or guardian again.</div>
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
      <mat-form-field>
        <mat-label>Password</mat-label>
        <input matInput [type]="showPw() ? 'text' : 'password'" formControlName="password" autocomplete="current-password" required />
        <button
          matIconButton
          matSuffix
          type="button"
          (click)="showPw.set(!showPw())"
          [attr.aria-label]="showPw() ? 'Hide password' : 'Show password'"
          [attr.aria-pressed]="showPw()"
        >
          <app-icon [name]="showPw() ? 'eye' : 'lock'" [size]="18" />
        </button>
        @if (form.controls.password.hasError('required')) {
          <mat-error>Enter your password.</mat-error>
        }
      </mat-form-field>
      <mat-checkbox formControlName="rememberMe">Keep me signed in for 14 days</mat-checkbox>
      <button matButton="filled" class="submit" type="submit" [disabled]="busy()">
        {{ busy() ? 'Signing in…' : 'Sign in' }}
      </button>
    </form>

    <div class="links">
      <a routerLink="/auth/forgot-password">Forgot password?</a>
      <a routerLink="/auth/register" [queryParams]="returnUrl() ? { returnUrl: returnUrl() } : {}">Create an account</a>
    </div>

    @if (mock) {
      <div class="demo">
        <p>Demo mode — any password works</p>
        <div class="accounts">
          <button matButton="outlined" type="button" (click)="demo('asha@sathi.dev')">Student</button>
          <button matButton="outlined" type="button" (click)="demo('new@sathi.dev')">New student</button>
          <button matButton="outlined" type="button" (click)="demo('instructor@sathi.dev')">Instructor</button>
          <button matButton="outlined" type="button" (click)="demo('admin@sathi.dev')">Admin</button>
        </div>
      </div>
    }
  `,
})
export default class SignInComponent {
  private readonly fb = inject(NonNullableFormBuilder);
  private readonly auth = inject(AuthStore);
  private readonly api = inject(AuthApi);
  private readonly router = inject(Router);

  readonly returnUrl = input<string>('');
  readonly mock = environment.mockApi;
  readonly busy = signal(false);
  readonly showPw = signal(false);
  readonly error = signal<ApiError | null>(null);
  readonly resent = signal(false);
  readonly guardianResent = signal(false);

  readonly form = this.fb.group({
    email: ['', [Validators.required, Validators.email]],
    password: ['', Validators.required],
    rememberMe: [true],
  });

  demo(email: string): void {
    this.form.setValue({ email, password: 'demo-password-1', rememberMe: true });
    void this.submit();
  }

  async submit(): Promise<void> {
    if (this.form.invalid) {
      this.form.markAllAsTouched();
      return;
    }
    this.busy.set(true);
    this.error.set(null);
    this.resent.set(false);
    this.guardianResent.set(false);
    try {
      const { email, password, rememberMe } = this.form.getRawValue();
      await this.auth.login(email.trim(), password, rememberMe);
      // Joining a class comes before onboarding: the join page sends new students on to onboarding.
      const back = this.safeReturnUrl();
      const target = back.startsWith('/join') || back.startsWith('/staff-invite') ? back : this.auth.needsOnboarding() ? '/onboarding' : back || '/home';
      await this.router.navigateByUrl(target);
    } catch (e) {
      this.error.set(toApiError(e));
    } finally {
      this.busy.set(false);
    }
  }

  async resendGuardian(): Promise<void> {
    await firstValueFrom(this.api.resendGuardianConsent(this.form.controls.email.value.trim())).catch(() => undefined);
    this.error.set(null);
    this.guardianResent.set(true);
  }

  async resend(): Promise<void> {
    await firstValueFrom(this.api.resendVerification(this.form.controls.email.value)).catch(() => undefined);
    this.error.set(null);
    this.resent.set(true);
  }

  /** `?returnUrl=`, else one remembered before email verification (e.g. a class invite). */
  private safeReturnUrl(): string {
    return safeReturnUrl(this.returnUrl()) || takeReturnUrl();
  }
}
