import { ChangeDetectionStrategy, Component, OnInit, computed, inject, input, signal } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatDialog } from '@angular/material/dialog';
import { firstValueFrom } from 'rxjs';
import { AuthApi } from '../../core/api/auth.api';
import { ApiError, toApiError } from '../../core/http/api-error';
import { GuardianDecision } from '../../core/models/api.models';
import { createLoader } from '../../core/platform/loader';
import { confirmDialog } from '../../shared/ui/dialog/confirm-dialog.component';
import { IconComponent } from '../../shared/ui/icon/icon.component';
import { ReferenceIdComponent } from '../../shared/ui/reference-id/reference-id.component';
import { ErrorStateComponent } from '../../shared/ui/states/error-state.component';
import { SkeletonComponent } from '../../shared/ui/states/skeleton.component';

/**
 * `/consent/:token` — a parent or guardian approves (or declines, or later withdraws) a learner's
 * account (contracts.md §11.4, India DPDP Act 2023 s.9). Public, no sign-in, mobile-first.
 */
@Component({
  selector: 'app-guardian-consent',
  imports: [MatButtonModule, IconComponent, ReferenceIdComponent, ErrorStateComponent, SkeletonComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @switch (info.status()) {
      @case ('loading') { <app-skeleton [lines]="6" /> }
      @case ('error') {
        @if (info.error()?.code === 'NOT_FOUND') {
          <section class="card c">
            <span class="badge warn" aria-hidden="true"><app-icon name="alert" [size]="28" /></span>
            <h1>This link isn’t valid</h1>
            <p class="lede">Please use the most recent email from Sathi. If you can’t find it, ask your child to send it again from the Sathi sign-in page.</p>
          </section>
        } @else {
          <app-error-state [error]="info.error()" title="We couldn’t open this page" (retry)="info.load()" />
        }
      }
      @default {
        @if (info.data(); as d) {
          @switch (d.status) {
            @case ('pending') {
              <section class="card c" aria-labelledby="gc-h">
                <span class="badge" aria-hidden="true"><app-icon name="consent" [size]="28" /></span>
                <p class="eyebrow">For a parent or guardian</p>
                <h1 id="gc-h">{{ first() }} would like to learn with Sathi</h1>
                <p class="lede">
                  <strong>{{ d.learnerDisplayName }}</strong> ({{ d.learnerEmailMasked }}) created a Sathi account. Because they are under 18,
                  India’s Digital Personal Data Protection Act asks us to get your permission before they start.
                </p>

                <h2>What Sathi is</h2>
                <p>An AI tutor for a course. It explains topics at the right level, answers questions with sources, and suggests what to practise next.</p>

                <h2>What we process, and why</h2>
                <ul class="data">
                  @for (item of d.dataWeProcess; track item) {
                    <li><app-icon name="check" [size]="16" [strokeWidth]="2.5" /> <span>{{ item }}</span></li>
                  }
                </ul>

                <h2>What we never do</h2>
                <ul class="data never">
                  <li><app-icon name="ban" [size]="16" /> <span>No advertising and no behavioural tracking.</span></li>
                  <li><app-icon name="ban" [size]="16" /> <span>We don’t sell or share {{ first() }}’s data. Learning data is used only for tutoring.</span></li>
                </ul>

                <h2>Your choice</h2>
                <p>You can change your mind later: the confirmation email has a link to withdraw. Withdrawing or declining closes the account and deletes what {{ first() }} has entered.</p>

                @if (error(); as e) {
                  <div class="inline-alert" role="alert">
                    <app-icon name="alert" [size]="18" />
                    <div><p>{{ e.userMessage }}</p><app-reference-id [referenceId]="e.referenceId" /></div>
                  </div>
                }
                <div class="actions">
                  <button matButton="filled" type="button" (click)="decide('granted')" [disabled]="busy() !== null">
                    <app-icon name="check" [size]="18" /> {{ busy() === 'granted' ? 'Saving…' : 'I approve' }}
                  </button>
                  <button matButton="outlined" type="button" (click)="decide('declined')" [disabled]="busy() !== null">
                    {{ busy() === 'declined' ? 'Saving…' : 'I don’t approve' }}
                  </button>
                </div>
                <p class="muted small">Policy version {{ d.policyVersion }}. We record your decision, the time and a one-way fingerprint of your device so we can show consent was given.</p>
              </section>
            }
            @case ('granted') {
              <section class="card c" aria-labelledby="gc-h">
                <span class="badge ok" aria-hidden="true"><app-icon name="check-circle" [size]="28" /></span>
                <h1 id="gc-h" tabindex="-1">Thank you — {{ first() }} can start learning</h1>
                <p class="lede">You approved {{ d.learnerDisplayName }}’s account. We’ve emailed you a confirmation with a link back to this page.</p>
                <h2>Changed your mind?</h2>
                <p>You can withdraw consent at any time. This closes the account and deletes {{ first() }}’s questions, notes and progress.</p>
                @if (error(); as e) {
                  <div class="inline-alert" role="alert"><app-icon name="alert" [size]="18" /><div><p>{{ e.userMessage }}</p></div></div>
                }
                <div class="actions">
                  <button matButton="outlined" class="btn-danger" type="button" (click)="decide('withdrawn')" [disabled]="busy() !== null">
                    {{ busy() === 'withdrawn' ? 'Withdrawing…' : 'Withdraw consent' }}
                  </button>
                </div>
              </section>
            }
            @case ('expired') {
              <section class="card c">
                <span class="badge warn" aria-hidden="true"><app-icon name="hourglass" [size]="28" /></span>
                <h1>This link has expired</h1>
                <p class="lede">Approval links last 7 days. Ask {{ first() }} to open the Sathi sign-in page and choose “Send the email to my parent or guardian again”.</p>
              </section>
            }
            @default {
              <section class="card c">
                <span class="badge" aria-hidden="true"><app-icon name="shield" [size]="28" /></span>
                <h1 tabindex="-1" id="gc-h">{{ d.learnerDisplayName }}’s account is closed</h1>
                <p class="lede">
                  {{ d.status === 'withdrawn' ? 'You withdrew consent.' : 'You didn’t approve the account.' }}
                  We’ve closed it and are deleting what {{ first() }} entered. Nothing else is needed from you.
                </p>
              </section>
            }
          }
        }
      }
    }
    <p class="sr-only" role="status">{{ announce() }}</p>
  `,
  styles: `
    .c {
      display: flex;
      flex-direction: column;
      gap: 10px;
      padding: 28px;
      line-height: 1.55;
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
      font-size: 1.55rem;
      outline: none;
    }
    h2 {
      font-size: 1.05rem;
      margin-top: 10px;
    }
    .lede {
      color: var(--muted);
    }
    .data {
      list-style: none;
      margin: 0;
      padding: 0;
      display: flex;
      flex-direction: column;
      gap: 8px;
      li {
        display: flex;
        gap: 10px;
        align-items: flex-start;
      }
      app-icon {
        color: var(--mint-ink);
        margin-top: 3px;
      }
      &.never app-icon {
        color: var(--danger);
      }
    }
    .actions {
      display: flex;
      gap: 10px;
      flex-wrap: wrap;
      margin-top: 8px;
      button {
        min-height: 48px;
      }
      @media (max-width: 479.98px) {
        flex-direction: column;
        button {
          width: 100%;
        }
      }
    }
  `,
})
export default class GuardianConsentComponent implements OnInit {
  private readonly api = inject(AuthApi);
  private readonly dialog = inject(MatDialog);
  readonly token = input.required<string>();

  readonly info = createLoader(() => this.api.guardianConsent(this.token()), { immediate: false });

  ngOnInit(): void {
    this.info.load();
  }
  readonly busy = signal<GuardianDecision | null>(null);
  readonly error = signal<ApiError | null>(null);
  readonly announce = signal('');
  readonly first = computed(() => (this.info.data()?.learnerDisplayName ?? 'Your child').split(' ')[0]);

  async decide(decision: GuardianDecision): Promise<void> {
    if (decision !== 'granted') {
      const ok = await firstValueFrom(
        confirmDialog(this.dialog, {
          title: decision === 'declined' ? 'Don’t approve this account?' : 'Withdraw consent?',
          message: `${this.info.data()?.learnerDisplayName ?? 'The'}’s account will be closed and what they entered will be deleted. This can’t be undone.`,
          confirmText: decision === 'declined' ? 'Don’t approve' : 'Withdraw consent',
          cancelText: 'Go back',
          danger: true,
        }),
      );
      if (!ok) return;
    }
    this.busy.set(decision);
    this.error.set(null);
    try {
      await firstValueFrom(this.api.decideGuardianConsent(this.token(), decision));
      this.info.update((d) => ({ ...d, status: decision }));
      this.announce.set(decision === 'granted' ? 'Thank you. The account is approved.' : 'The account has been closed.');
      setTimeout(() => document.getElementById('gc-h')?.focus());
    } catch (e) {
      this.error.set(toApiError(e));
    } finally {
      this.busy.set(null);
    }
  }
}
