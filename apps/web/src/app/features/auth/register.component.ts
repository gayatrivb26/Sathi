import { ChangeDetectionStrategy, Component, computed, inject, input, OnInit, signal } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { AbstractControl, NonNullableFormBuilder, ReactiveFormsModule, ValidationErrors, Validators } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { Router, RouterLink } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import { AuthApi } from '../../core/api/auth.api';
import { ApiError, toApiError } from '../../core/http/api-error';
import { RegisterRequest, StaffInvitePreview } from '../../core/models/api.models';
import { IconComponent } from '../../shared/ui/icon/icon.component';
import { ReferenceIdComponent } from '../../shared/ui/reference-id/reference-id.component';
import { AGE_OF_MAJORITY, ageBand, isoDate, MINIMUM_AGE } from './age';
import { rememberReturnUrl } from './return-url';
import { passwordPolicyValidator, passwordRules } from './password-rules';

function dobValidator(control: AbstractControl<string>): ValidationErrors | null {
  if (!control.value) return null; // `required` reports the empty case
  switch (ageBand(control.value)) {
    case 'invalid':
      return { dob: 'Enter a real date, like 14/03/2008.' };
    case 'future':
      return { dob: 'That date is in the future.' };
    case 'too-young':
      return { tooYoung: true };
    default:
      return null;
  }
}

@Component({
  selector: 'app-register',
  imports: [ReactiveFormsModule, RouterLink, MatFormFieldModule, MatInputModule, MatButtonModule, IconComponent, ReferenceIdComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  styleUrl: './auth-shared.scss',
  template: `
    @if (invite(); as inv) {
      @if (inv.status === 'pending') {
        <div class="invite-banner" role="note">
          <app-icon name="teach" [size]="22" />
          <div>
            <p class="strong">You’re invited to teach on Sathi</p>
            <p>
              Creating your account with this link makes you an <strong>{{ inv.role }}</strong>{{ inv.courseTitle ? ' for “' + inv.courseTitle + '”' : '' }}, as well as a student.
              Use the email address the invite was sent to: <strong>{{ inv.emailMasked }}</strong>.
            </p>
          </div>
        </div>
      } @else {
        <div class="form-error" role="alert">
          <app-icon name="alert" [size]="18" />
          <div><p>This staff invite has {{ inv.status === 'accepted' ? 'already been used' : inv.status === 'revoked' ? 'been withdrawn' : 'expired' }}. You can still create a student account, or ask your admin for a new invite.</p></div>
        </div>
      }
    } @else if (inviteError(); as ie) {
      <div class="form-error" role="alert"><app-icon name="alert" [size]="18" /><div><p>{{ ie.userMessage }} You can still create a student account.</p></div></div>
    }

    <h1>Create your account</h1>
    <p class="lede">It takes a minute. Then we’ll find the right starting point for you.</p>

    @if (error(); as e) {
      <div class="form-error" role="alert">
        <app-icon name="alert" [size]="18" />
        <div>
          <p>{{ e.userMessage }}</p>
          @if (e.code === 'AUTH_EMAIL_TAKEN') {
            <a routerLink="/auth/sign-in">Sign in instead</a>
          }
          @if (e.status >= 500 || e.status === 0) {
            <app-reference-id [referenceId]="e.referenceId" />
          }
        </div>
      </div>
    }

    <form [formGroup]="form" (ngSubmit)="submit()" novalidate>
      <mat-form-field>
        <mat-label>Your name</mat-label>
        <input matInput formControlName="displayName" autocomplete="name" required maxlength="60" />
        <mat-hint>How Sathi will greet you.</mat-hint>
        @if (form.controls.displayName.hasError('required')) {
          <mat-error>Tell us what to call you.</mat-error>
        } @else if (form.controls.displayName.hasError('server')) {
          <mat-error>{{ form.controls.displayName.getError('server') }}</mat-error>
        }
      </mat-form-field>
      <mat-form-field>
        <mat-label>Email</mat-label>
        <input matInput type="email" formControlName="email" autocomplete="email" required />
        @if (invite()?.status === 'pending') { <mat-hint>The address the invite was sent to ({{ invite()!.emailMasked }}).</mat-hint> }
        @if (form.controls.email.hasError('required')) {
          <mat-error>Enter your email.</mat-error>
        } @else if (form.controls.email.hasError('email')) {
          <mat-error>That doesn’t look like an email address.</mat-error>
        } @else if (form.controls.email.hasError('server')) {
          <mat-error>{{ form.controls.email.getError('server') }}</mat-error>
        }
      </mat-form-field>
      <mat-form-field>
        <mat-label>Date of birth</mat-label>
        <input matInput type="date" formControlName="dateOfBirth" autocomplete="bday" required [max]="today" min="1900-01-01" aria-describedby="dob-why" />
        <mat-hint id="dob-why">We ask so we can keep younger learners safe.</mat-hint>
        @if (form.controls.dateOfBirth.hasError('required')) {
          <mat-error>Enter your date of birth.</mat-error>
        } @else if (form.controls.dateOfBirth.hasError('tooYoung')) {
          <mat-error>Sathi is for learners aged {{ minimumAge }} and over.</mat-error>
        } @else if (form.controls.dateOfBirth.hasError('dob')) {
          <mat-error>{{ form.controls.dateOfBirth.getError('dob') }}</mat-error>
        } @else if (form.controls.dateOfBirth.hasError('server')) {
          <mat-error>{{ form.controls.dateOfBirth.getError('server') }}</mat-error>
        }
      </mat-form-field>

      @if (minor()) {
        <div class="guardian" role="group" aria-labelledby="guardian-h">
          <p id="guardian-h" class="strong"><app-icon name="consent" [size]="18" /> A parent or guardian needs to approve</p>
          <p class="small">
            Because you’re under {{ ageOfMajority }}, the law asks us to get permission from a parent or guardian before you start.
            We’ll email them a short page explaining what Sathi does with your data, and you can sign in as soon as they approve.
          </p>
          <mat-form-field>
            <mat-label>Parent or guardian’s email</mat-label>
            <input matInput type="email" formControlName="guardianEmail" autocomplete="off" required />
            @if (form.controls.guardianEmail.hasError('required')) {
              <mat-error>Enter your parent’s or guardian’s email.</mat-error>
            } @else if (form.controls.guardianEmail.hasError('email')) {
              <mat-error>That doesn’t look like an email address.</mat-error>
            } @else if (form.controls.guardianEmail.hasError('same')) {
              <mat-error>Use their own email address, not yours.</mat-error>
            } @else if (form.controls.guardianEmail.hasError('server')) {
              <mat-error>{{ form.controls.guardianEmail.getError('server') }}</mat-error>
            }
          </mat-form-field>
        </div>
      }

      <mat-form-field>
        <mat-label>Password</mat-label>
        <input
          matInput
          [type]="showPw() ? 'text' : 'password'"
          formControlName="password"
          autocomplete="new-password"
          required
          aria-describedby="pw-rules"
        />
        <button matIconButton matSuffix type="button" (click)="showPw.set(!showPw())" [attr.aria-label]="showPw() ? 'Hide password' : 'Show password'" [attr.aria-pressed]="showPw()">
          <app-icon [name]="showPw() ? 'eye-off' : 'eye'" [size]="18" />
        </button>
        @if (form.controls.password.hasError('required')) {
          <mat-error>Choose a password.</mat-error>
        } @else if (form.controls.password.hasError('passwordPolicy')) {
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
      <p class="muted small">Everyone starts as a student. Teachers and admins get their access from an admin.</p>
      <button matButton="filled" class="submit" type="submit" [disabled]="busy()">
        {{ busy() ? 'Creating your account…' : 'Create account' }}
      </button>
    </form>
    <div class="links center">
      <span class="muted">Already have an account?</span> <a routerLink="/auth/sign-in" [queryParams]="returnUrl() ? { returnUrl: returnUrl() } : {}">Sign in</a>
    </div>
  `,
})
export default class RegisterComponent implements OnInit {
  private readonly fb = inject(NonNullableFormBuilder);
  private readonly api = inject(AuthApi);
  private readonly router = inject(Router);

  /** `?staffInvite=` (contracts.md §11.2) and `?returnUrl=` (e.g. from a class invite). */
  readonly staffInvite = input<string>('');
  readonly returnUrl = input<string>('');

  readonly today = isoDate(new Date());
  readonly minimumAge = MINIMUM_AGE;
  readonly ageOfMajority = AGE_OF_MAJORITY;
  readonly busy = signal(false);
  readonly showPw = signal(false);
  readonly error = signal<ApiError | null>(null);
  readonly invite = signal<StaffInvitePreview | null>(null);
  readonly inviteError = signal<ApiError | null>(null);

  readonly form = this.fb.group({
    displayName: ['', [Validators.required, Validators.maxLength(60)]],
    email: ['', [Validators.required, Validators.email]],
    dateOfBirth: ['', [Validators.required, dobValidator]],
    guardianEmail: ['', [Validators.required, Validators.email, (c: AbstractControl<string>) => this.sameAsLearner(c)]],
    password: ['', [Validators.required, passwordPolicyValidator]],
  });
  private readonly pw = toSignal(this.form.controls.password.valueChanges, { initialValue: '' });
  private readonly dob = toSignal(this.form.controls.dateOfBirth.valueChanges, { initialValue: '' });
  readonly rules = computed(() => passwordRules(this.pw()));
  readonly minor = computed(() => ageBand(this.dob()) === 'minor');

  constructor() {
    this.form.controls.guardianEmail.disable();
    this.form.controls.dateOfBirth.valueChanges.subscribe((v) => {
      const g = this.form.controls.guardianEmail;
      if (ageBand(v) === 'minor') g.enable({ emitEvent: false });
      else g.disable({ emitEvent: false });
    });
    this.form.controls.email.valueChanges.subscribe(() => this.form.controls.guardianEmail.updateValueAndValidity({ emitEvent: false }));
  }

  ngOnInit(): void {
    if (this.returnUrl()) rememberReturnUrl(this.returnUrl());
    const token = this.staffInvite();
    if (token) {
      this.api.staffInvite(token).subscribe({
        next: (inv) => this.invite.set(inv),
        error: (e: unknown) => this.inviteError.set(toApiError(e)),
      });
    }
  }

  private sameAsLearner(c: AbstractControl<string>): ValidationErrors | null {
    const learner = this.form?.controls.email.value.trim().toLowerCase();
    return learner && c.value.trim().toLowerCase() === learner ? { same: true } : null;
  }

  async submit(): Promise<void> {
    if (this.form.invalid) {
      this.form.markAllAsTouched();
      return;
    }
    this.busy.set(true);
    this.error.set(null);
    const { displayName, email, password, dateOfBirth, guardianEmail } = this.form.getRawValue();
    const minor = this.minor();
    const body: RegisterRequest = { displayName: displayName.trim(), email: email.trim(), password, dateOfBirth };
    if (minor) body.guardianEmail = guardianEmail.trim();
    if (this.invite()?.status === 'pending') body.staffInviteToken = this.staffInvite();
    try {
      await firstValueFrom(this.api.register(body));
      await this.router.navigate(['/auth/check-email'], { queryParams: minor ? { email: body.email, guardian: 1 } : { email: body.email } });
    } catch (e) {
      const err = toApiError(e);
      if (err.code === 'AUTH_TOO_YOUNG') this.form.controls.dateOfBirth.setErrors({ tooYoung: true });
      this.applyFieldErrors(err);
      this.error.set(err);
    } finally {
      this.busy.set(false);
    }
  }

  private applyFieldErrors(err: ApiError): void {
    for (const [field, messages] of Object.entries(err.fieldErrors)) {
      const key = field.charAt(0).toLowerCase() + field.slice(1);
      const control = this.form.get(key);
      if (control && messages.length) {
        control.setErrors({ server: messages[0] });
        control.markAsTouched();
      }
    }
  }
}
