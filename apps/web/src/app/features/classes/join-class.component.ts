import { ChangeDetectionStrategy, Component, computed, inject, input, OnInit, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { Router, RouterLink } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import { ClassesApi } from '../../core/api/classes.api';
import { AuthStore } from '../../core/auth/auth.store';
import { formatJoinCode, joinCodeMessage, joinCodeProblem, normalizeJoinCode } from '../../core/classes/join-code';
import { ApiError, toApiError } from '../../core/http/api-error';
import { JoinClassResult } from '../../core/models/api.models';
import { IconComponent } from '../../shared/ui/icon/icon.component';
import { ReferenceIdComponent } from '../../shared/ui/reference-id/reference-id.component';
import { rememberReturnUrl } from '../auth/return-url';
import { JoinSuccessComponent } from './join-success.component';

/** `/join?code=XXXX-XXXX` — join a class with the code from a teacher (contracts.md §11.1). */
@Component({
  selector: 'app-join-class',
  imports: [FormsModule, RouterLink, MatButtonModule, IconComponent, ReferenceIdComponent, JoinSuccessComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (result(); as r) {
      <app-join-success [result]="r" />
    } @else {
      <section class="card join" aria-labelledby="join-h">
        <span class="badge" aria-hidden="true"><app-icon name="classes" [size]="28" /></span>
        <h1 id="join-h">Join a class</h1>
        <p class="lede">Enter the 8-character code your teacher gave you. It looks like <span class="mono">ABCD-EF23</span>.</p>

        <form (ngSubmit)="submit()" novalidate>
          <label for="join-code" class="lbl">Class code</label>
          <input
            id="join-code"
            class="code-input"
            [class.bad]="showProblem()"
            [ngModel]="code()"
            (ngModelChange)="onInput($event)"
            name="code"
            autocomplete="off"
            autocapitalize="characters"
            spellcheck="false"
            inputmode="text"
            maxlength="12"
            placeholder="ABCD-EF23"
            [attr.aria-invalid]="showProblem()"
            aria-describedby="join-help"
          />
          <p id="join-help" class="help" [class.err]="showProblem()" [attr.role]="showProblem() ? 'alert' : null">
            @if (showProblem()) {
              <app-icon name="alert" [size]="15" /> {{ problemText() }}
            } @else {
              Letters and the digits 2–9. Capitals and the dash are optional.
            }
          </p>

          @if (error(); as e) {
            <div class="form-error" role="alert">
              <app-icon name="alert" [size]="18" />
              <div>
                <p>{{ e.userMessage }}</p>
                @if (e.status >= 500 || e.status === 0) { <app-reference-id [referenceId]="e.referenceId" /> }
              </div>
            </div>
          }

          @if (auth.signedIn()) {
            <button matButton="filled" type="submit" class="go" [disabled]="busy()">{{ busy() ? 'Joining…' : 'Join class' }}</button>
          } @else {
            <p class="muted small">Sign in or create a free account to join. We’ll bring you straight back here.</p>
            <div class="row">
              <button matButton="filled" type="submit" class="go">Sign in to join</button>
              <a matButton="outlined" routerLink="/auth/register" [queryParams]="{ returnUrl: back() }" (click)="remember()">Create an account</a>
            </div>
          }
        </form>
      </section>
      @if (auth.signedIn()) {
        <p class="back"><a [routerLink]="auth.needsOnboarding() ? '/onboarding' : '/home'"><app-icon name="arrow-left" [size]="16" /> Back</a></p>
      }
    }
  `,
  styles: `
    .join {
      display: flex;
      flex-direction: column;
      gap: 10px;
      padding: 28px;
      @media (max-width: 719.98px) {
        padding: 20px 18px;
      }
    }
    .badge {
      display: grid;
      place-items: center;
      width: 56px;
      height: 56px;
      border-radius: 18px;
      background: var(--primary-soft);
      color: var(--primary-ink);
    }
    h1 {
      font-size: 1.6rem;
    }
    .lede {
      color: var(--muted);
    }
    .mono {
      font-family: ui-monospace, 'SFMono-Regular', Consolas, monospace;
      font-weight: 600;
      color: var(--ink);
    }
    form {
      display: flex;
      flex-direction: column;
      gap: 8px;
      margin-top: 8px;
    }
    .lbl {
      font-weight: 600;
    }
    .help {
      display: flex;
      align-items: center;
      gap: 6px;
      font-size: 0.875rem;
      color: var(--muted);
      &.err {
        color: var(--danger);
        font-weight: 600;
      }
    }
    .go {
      align-self: flex-start;
      min-height: 48px;
      margin-top: 6px;
    }
    .row {
      display: flex;
      gap: 10px;
      flex-wrap: wrap;
    }
    .form-error {
      display: flex;
      gap: 10px;
      padding: 12px 14px;
      border-radius: 12px;
      background: var(--danger-soft);
      app-icon {
        color: var(--danger);
      }
    }
    .back {
      margin-top: 16px;
      a {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        min-height: 44px;
        font-weight: 600;
      }
    }
  `,
})
export default class JoinClassComponent implements OnInit {
  private readonly api = inject(ClassesApi);
  private readonly router = inject(Router);
  readonly auth = inject(AuthStore);

  /** `?code=` from a shared join link. */
  readonly codeParam = input<string>('', { alias: 'code' });

  readonly code = signal('');
  readonly touched = signal(false);
  readonly busy = signal(false);
  readonly error = signal<ApiError | null>(null);
  readonly result = signal<JoinClassResult | null>(null);

  readonly problem = computed(() => joinCodeProblem(this.code()));
  readonly showProblem = computed(() => this.touched() && this.problem() !== null);
  readonly problemText = computed(() => joinCodeMessage(this.problem()));
  readonly back = computed(() => (this.code() ? `/join?code=${formatJoinCode(this.code())}` : '/join'));

  ngOnInit(): void {
    if (this.codeParam()) this.code.set(formatJoinCode(this.codeParam()));
  }

  onInput(value: string): void {
    this.code.set(formatJoinCode(value));
    this.error.set(null);
    if (normalizeJoinCode(value).length >= 8) this.touched.set(true);
  }

  remember(): void {
    rememberReturnUrl(this.back());
  }

  async submit(): Promise<void> {
    this.touched.set(true);
    if (!this.auth.signedIn()) {
      this.remember();
      await this.router.navigate(['/auth/sign-in'], { queryParams: { returnUrl: this.back() } });
      return;
    }
    if (this.problem()) {
      document.getElementById('join-code')?.focus();
      return;
    }
    this.busy.set(true);
    this.error.set(null);
    try {
      this.result.set(await firstValueFrom(this.api.join(normalizeJoinCode(this.code()))));
      await this.auth.refresh();
    } catch (e) {
      this.error.set(toApiError(e));
    } finally {
      this.busy.set(false);
    }
  }
}
