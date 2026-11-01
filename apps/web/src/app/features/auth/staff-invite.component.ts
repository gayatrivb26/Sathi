import { ChangeDetectionStrategy, Component, OnInit, inject, input, signal } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { Router, RouterLink } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import { AuthApi } from '../../core/api/auth.api';
import { AuthStore } from '../../core/auth/auth.store';
import { ApiError, toApiError } from '../../core/http/api-error';
import { createLoader } from '../../core/platform/loader';
import { IconComponent } from '../../shared/ui/icon/icon.component';
import { ReferenceIdComponent } from '../../shared/ui/reference-id/reference-id.component';
import { ErrorStateComponent } from '../../shared/ui/states/error-state.component';
import { SkeletonComponent } from '../../shared/ui/states/skeleton.component';
import { rememberReturnUrl } from './return-url';

/** `/staff-invite/:token` — a signed-in user accepts an Instructor/Admin invite (contracts.md §11.2). */
@Component({
  selector: 'app-staff-invite',
  imports: [RouterLink, MatButtonModule, IconComponent, ReferenceIdComponent, ErrorStateComponent, SkeletonComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @switch (invite.status()) {
      @case ('loading') { <app-skeleton [lines]="4" /> }
      @case ('error') {
        @if (invite.error()?.code === 'STAFF_INVITE_INVALID' || invite.error()?.code === 'NOT_FOUND') {
          <section class="card s">
            <span class="badge warn" aria-hidden="true"><app-icon name="alert" [size]="28" /></span>
            <h1>This invite link isn’t valid</h1>
            <p class="lede">Ask your admin to send a new staff invite.</p>
            <a matButton="outlined" routerLink="/home">Go to home</a>
          </section>
        } @else {
          <app-error-state [error]="invite.error()" title="We couldn’t open this invite" (retry)="invite.load()" />
        }
      }
      @default {
        @if (invite.data(); as inv) {
          <section class="card s" aria-labelledby="si-h">
            @if (accepted()) {
              <span class="badge ok" aria-hidden="true"><app-icon name="check-circle" [size]="28" /></span>
              <h1 id="si-h" tabindex="-1">You’re now {{ inv.role === 'Admin' ? 'an Admin' : 'an Instructor' }}</h1>
              <p class="lede">{{ inv.role === 'Admin' ? 'The Admin area is in your sidebar.' : 'The Teach area is in your sidebar.' }}{{ inv.courseTitle ? ' You can edit “' + inv.courseTitle + '”.' : '' }}</p>
              <a matButton="filled" [routerLink]="inv.role === 'Admin' ? '/admin' : '/teach'">Open {{ inv.role === 'Admin' ? 'Admin' : 'Teach' }}</a>
            } @else if (inv.status === 'pending') {
              <span class="badge" aria-hidden="true"><app-icon name="teach" [size]="28" /></span>
              <p class="eyebrow">Staff invite</p>
              <h1 id="si-h">Become {{ inv.role === 'Admin' ? 'an Admin' : 'an Instructor' }}{{ inv.courseTitle ? ' for “' + inv.courseTitle + '”' : '' }}</h1>
              <p class="lede">
                {{ inv.role === 'Admin' ? 'Admins manage users and roles and can look into any problem a student reports.' : 'Instructors build courses, run classes and review answers the AI grader wasn’t sure about.' }}
                You keep your student access too.
              </p>
              <p class="small">This invite was sent to <strong>{{ inv.emailMasked }}</strong>. You’re signed in as <strong>{{ auth.me()?.email }}</strong>.</p>
              @if (error(); as e) {
                <div class="inline-alert" role="alert">
                  <app-icon name="alert" [size]="18" />
                  <div>
                    <p>{{ e.code === 'AUTH_FORBIDDEN' ? 'This invite was sent to a different email address. Sign in with that address to accept it.' : e.userMessage }}</p>
                    @if (e.code === 'AUTH_FORBIDDEN') {
                      <button matButton="outlined" type="button" (click)="switchAccount()">Sign out and use that account</button>
                    }
                    @if (e.status >= 500 || e.status === 0) { <app-reference-id [referenceId]="e.referenceId" /> }
                  </div>
                </div>
              }
              <div class="row">
                <button matButton="filled" type="button" (click)="accept()" [disabled]="busy()">{{ busy() ? 'Accepting…' : 'Accept invite' }}</button>
                <a matButton="text" routerLink="/home">Not now</a>
              </div>
            } @else {
              <span class="badge warn" aria-hidden="true"><app-icon name="alert" [size]="28" /></span>
              <h1 id="si-h">This invite {{ inv.status === 'accepted' ? 'was already used' : inv.status === 'revoked' ? 'was withdrawn' : 'has expired' }}</h1>
              <p class="lede">Ask your admin for a new staff invite if you still need access.</p>
              <a matButton="outlined" routerLink="/home">Go to home</a>
            }
          </section>
        }
      }
    }
  `,
  styles: `
    .s {
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
      &.ok {
        background: var(--mint-soft);
        color: var(--mint-ink);
      }
      &.warn {
        background: var(--amber-soft);
        color: var(--amber-ink);
      }
    }
    h1 {
      font-size: 1.5rem;
      outline: none;
    }
    .lede {
      color: var(--muted);
    }
    .row {
      display: flex;
      gap: 10px;
      flex-wrap: wrap;
    }
  `,
})
export default class StaffInviteComponent implements OnInit {
  private readonly api = inject(AuthApi);
  private readonly router = inject(Router);
  readonly auth = inject(AuthStore);
  readonly token = input.required<string>();

  readonly invite = createLoader(() => this.api.staffInvite(this.token()), { immediate: false });

  ngOnInit(): void {
    this.invite.load();
  }
  readonly busy = signal(false);
  readonly accepted = signal(false);
  readonly error = signal<ApiError | null>(null);

  async accept(): Promise<void> {
    this.busy.set(true);
    this.error.set(null);
    try {
      this.auth.set(await firstValueFrom(this.api.acceptStaffInvite(this.token())));
      this.accepted.set(true);
      setTimeout(() => document.getElementById('si-h')?.focus());
    } catch (e) {
      this.error.set(toApiError(e));
    } finally {
      this.busy.set(false);
    }
  }

  async switchAccount(): Promise<void> {
    const back = `/staff-invite/${encodeURIComponent(this.token())}`;
    rememberReturnUrl(back);
    await this.auth.logout();
    await this.router.navigate(['/auth/sign-in'], { queryParams: { returnUrl: back } });
  }
}
