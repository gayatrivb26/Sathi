import { ChangeDetectionStrategy, Component, OnInit, inject, input, signal } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { Router, RouterLink } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import { ClassesApi } from '../../core/api/classes.api';
import { AuthStore } from '../../core/auth/auth.store';
import { ApiError, toApiError } from '../../core/http/api-error';
import { JoinClassResult } from '../../core/models/api.models';
import { createLoader } from '../../core/platform/loader';
import { IconComponent } from '../../shared/ui/icon/icon.component';
import { ReferenceIdComponent } from '../../shared/ui/reference-id/reference-id.component';
import { ErrorStateComponent } from '../../shared/ui/states/error-state.component';
import { SkeletonComponent } from '../../shared/ui/states/skeleton.component';
import { rememberReturnUrl } from '../auth/return-url';
import { JoinSuccessComponent } from './join-success.component';

/** `/join/:token` — an email invite to a class (contracts.md §11.1). Works signed out; accepting needs an account. */
@Component({
  selector: 'app-class-invite',
  imports: [RouterLink, MatButtonModule, IconComponent, ReferenceIdComponent, ErrorStateComponent, SkeletonComponent, JoinSuccessComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (result(); as r) {
      <app-join-success [result]="r" />
    } @else {
      @switch (invite.status()) {
        @case ('loading') { <app-skeleton [lines]="4" /> }
        @case ('error') {
          @if (invite.error()?.code === 'NOT_FOUND') {
            <section class="card inv">
              <span class="badge bad" aria-hidden="true"><app-icon name="alert" [size]="28" /></span>
              <h1>This invite link isn’t valid</h1>
              <p class="lede">It may have been mistyped or withdrawn. If your teacher gave you a class code, you can join with that instead.</p>
              <a matButton="filled" routerLink="/join">Join with a code</a>
            </section>
          } @else {
            <app-error-state [error]="invite.error()" title="We couldn’t open this invite" (retry)="invite.load()" />
          }
        }
        @default {
          @if (invite.data(); as inv) {
            <section class="card inv" aria-labelledby="inv-h">
              <span class="badge" [class.bad]="inv.status !== 'valid'" aria-hidden="true"><app-icon [name]="inv.status === 'valid' ? 'mail' : 'alert'" [size]="28" /></span>
              <p class="eyebrow">Class invite</p>
              <h1 id="inv-h">{{ inv.status === 'valid' ? 'Join ' + inv.className : statusTitle(inv.status) }}</h1>
              <dl class="facts">
                <div><dt>Class</dt><dd>{{ inv.className }}</dd></div>
                <div><dt>Course</dt><dd>{{ inv.courseTitle }}</dd></div>
                <div><dt>Teacher</dt><dd>{{ inv.instructorName }}</dd></div>
                <div><dt>Sent to</dt><dd>{{ inv.emailMasked }}</dd></div>
              </dl>

              @switch (inv.status) {
                @case ('valid') {
                  @if (error(); as e) {
                    <div class="inline-alert" role="alert">
                      <app-icon name="alert" [size]="18" />
                      <div>
                        <p>{{ e.userMessage }}</p>
                        @if (e.code === 'CLASS_INVITE_EMAIL_MISMATCH') {
                          <p class="small">You’re signed in as <strong>{{ auth.me()?.email }}</strong>, but this invite went to {{ inv.emailMasked }}.</p>
                          <button matButton="outlined" type="button" (click)="switchAccount()">Sign out and use that account</button>
                        }
                        @if (e.status >= 500 || e.status === 0) { <app-reference-id [referenceId]="e.referenceId" /> }
                      </div>
                    </div>
                  }
                  @if (auth.signedIn()) {
                    <button matButton="filled" type="button" class="go" (click)="accept()" [disabled]="busy()">{{ busy() ? 'Joining…' : 'Accept and join' }}</button>
                  } @else {
                    <p class="muted small">Sign in with <strong>{{ inv.emailMasked }}</strong> to accept, or create a free account with that address. We’ll bring you back here.</p>
                    <div class="row">
                      <a matButton="filled" routerLink="/auth/sign-in" [queryParams]="{ returnUrl: here() }" (click)="remember()">Sign in to accept</a>
                      <a matButton="outlined" routerLink="/auth/register" [queryParams]="{ returnUrl: here() }" (click)="remember()">Create an account</a>
                    </div>
                  }
                }
                @case ('expired') {
                  <p class="lede">Invites last 14 days. Ask {{ inv.instructorName }} to send a new one — or join with the class code if you have it.</p>
                  <a matButton="outlined" routerLink="/join">Join with a code</a>
                }
                @case ('accepted') {
                  <p class="lede">This invite has already been used. If that was you, the class is already in your account.</p>
                  <a matButton="filled" [routerLink]="auth.signedIn() ? '/home' : '/auth/sign-in'">{{ auth.signedIn() ? 'Go to home' : 'Sign in' }}</a>
                }
                @case ('revoked') {
                  <p class="lede">{{ inv.instructorName }} withdrew this invite. Ask them if you should still join.</p>
                }
              }
            </section>
          }
        }
      }
    }
  `,
  styles: `
    .inv {
      display: flex;
      flex-direction: column;
      align-items: flex-start;
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
      &.bad {
        background: var(--amber-soft);
        color: var(--amber-ink);
      }
    }
    h1 {
      font-size: 1.5rem;
    }
    .lede {
      color: var(--muted);
    }
    .facts {
      width: 100%;
      margin: 6px 0 8px;
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 10px 16px;
      @media (max-width: 479.98px) {
        grid-template-columns: 1fr;
      }
      dt {
        font-size: 0.8rem;
        color: var(--muted);
      }
      dd {
        margin: 0;
        font-weight: 600;
        overflow-wrap: anywhere;
      }
    }
    .go {
      min-height: 48px;
    }
    .row {
      display: flex;
      gap: 10px;
      flex-wrap: wrap;
    }
    .inline-alert {
      width: 100%;
    }
  `,
})
export default class ClassInviteComponent implements OnInit {
  private readonly api = inject(ClassesApi);
  private readonly router = inject(Router);
  readonly auth = inject(AuthStore);
  readonly token = input.required<string>();

  readonly invite = createLoader(() => this.api.invite(this.token()), { immediate: false });

  ngOnInit(): void {
    this.invite.load();
  }
  readonly busy = signal(false);
  readonly error = signal<ApiError | null>(null);
  readonly result = signal<JoinClassResult | null>(null);

  here(): string {
    return `/join/${encodeURIComponent(this.token())}`;
  }
  remember(): void {
    rememberReturnUrl(this.here());
  }
  statusTitle(status: string): string {
    return status === 'expired' ? 'This invite has expired' : status === 'accepted' ? 'This invite was already used' : 'This invite was withdrawn';
  }

  async accept(): Promise<void> {
    this.busy.set(true);
    this.error.set(null);
    try {
      this.result.set(await firstValueFrom(this.api.acceptInvite(this.token())));
      await this.auth.refresh();
    } catch (e) {
      const err = toApiError(e);
      if (err.code === 'CLASS_INVITE_EXPIRED') this.invite.update((i) => ({ ...i, status: 'expired' }));
      this.error.set(err);
    } finally {
      this.busy.set(false);
    }
  }

  async switchAccount(): Promise<void> {
    this.remember();
    await this.auth.logout();
    await this.router.navigate(['/auth/sign-in'], { queryParams: { returnUrl: this.here() } });
  }
}
