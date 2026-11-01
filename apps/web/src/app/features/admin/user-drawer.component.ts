import { A11yModule } from '@angular/cdk/a11y';
import { DatePipe } from '@angular/common';
import { ChangeDetectionStrategy, Component, computed, effect, inject, input, output, signal, untracked } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatCheckboxModule } from '@angular/material/checkbox';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatSelectModule } from '@angular/material/select';
import { firstValueFrom } from 'rxjs';
import { AdminApi } from '../../core/api/staff.api';
import { AuthStore } from '../../core/auth/auth.store';
import { Notifier } from '../../core/errors/notifier.service';
import { ApiError, toApiError } from '../../core/http/api-error';
import { AdminUser, AdminUserDetail, Role } from '../../core/models/api.models';
import { createLoader } from '../../core/platform/loader';
import { IconComponent } from '../../shared/ui/icon/icon.component';
import { ErrorStateComponent } from '../../shared/ui/states/error-state.component';
import { SkeletonComponent } from '../../shared/ui/states/skeleton.component';
import { normalizeRoles, ROLE_INFO, roleLockReason, sameRoles, statusPills } from './roles';

/** Slide-over with one person's roles, lock state, verification and courses/classes. Focus trapped; Esc closes. */
@Component({
  selector: 'app-user-drawer',
  imports: [A11yModule, DatePipe, FormsModule, MatButtonModule, MatCheckboxModule, MatFormFieldModule, MatSelectModule, IconComponent, SkeletonComponent, ErrorStateComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { '(document:keydown.escape)': 'closed.emit()' },
  template: `
    <div class="drawer-scrim" (click)="closed.emit()" aria-hidden="true"></div>
    <aside class="drawer-panel" role="dialog" aria-modal="true" aria-labelledby="ud-h" cdkTrapFocus [cdkTrapFocusAutoCapture]="true">
      <header class="head">
        <h2 id="ud-h">{{ user.data()?.displayName ?? 'User' }}</h2>
        <button type="button" class="icon-only" (click)="closed.emit()" aria-label="Close user details"><app-icon name="x" [size]="20" /></button>
      </header>
      @switch (user.status()) {
        @case ('loading') { <app-skeleton [lines]="8" [card]="false" /> }
        @case ('error') { <app-error-state [error]="user.error()" [compact]="true" title="We couldn’t load this user" (retry)="user.load()" /> }
        @default {
          @if (user.data(); as u) {
            <p class="muted em">{{ u.email }}{{ isMe() ? ' · you' : '' }}</p>
            <div class="pills">
              @for (s of pills(u); track s.label) { <span class="pill" [class]="s.tone">{{ s.label }}</span> }
            </div>
            <p class="muted small">Joined {{ u.createdAt | date: 'd MMM y' }} · {{ u.lastActiveAt ? 'last active ' + (u.lastActiveAt | date: 'd MMM, HH:mm') : 'never signed in' }}</p>

            <section aria-labelledby="ud-roles">
              <h3 id="ud-roles">Roles</h3>
              <fieldset class="roles">
                <legend class="sr-only">Roles for {{ u.displayName }}</legend>
                @for (r of roleInfo; track r.id) {
                  <div class="role">
                    <mat-checkbox [checked]="selected().includes(r.id)" [disabled]="!!lockReason(r.id, u)" (change)="toggle(r.id, $event.checked)" [attr.aria-describedby]="'role-' + r.id + '-d'">
                      {{ r.label }}
                    </mat-checkbox>
                    <p class="small muted" [id]="'role-' + r.id + '-d'">{{ lockReason(r.id, u) ?? r.text }}</p>
                  </div>
                }
              </fieldset>
              @if (rolesError(); as e) {
                <div class="inline-alert" role="alert"><app-icon name="alert" [size]="18" /><div><p>{{ e.userMessage }}</p></div></div>
              }
              <div class="row">
                <button matButton="filled" type="button" (click)="saveRoles(u)" [disabled]="busy() !== null || !rolesChanged()">{{ busy() === 'roles' ? 'Saving…' : 'Save roles' }}</button>
                @if (rolesChanged()) { <span class="small muted">Applies within a minute.</span> }
              </div>
            </section>

            <section aria-labelledby="ud-acc">
              <h3 id="ud-acc">Account</h3>
              @if (accountError(); as e) {
                <div class="inline-alert" role="alert"><app-icon name="alert" [size]="18" /><div><p>{{ e.userMessage }}</p></div></div>
              }
              @if (u.lockedOut) {
                <p class="small">This account is locked, so they can’t sign in.</p>
                <button matButton="outlined" type="button" (click)="unlock(u)" [disabled]="busy() !== null"><app-icon name="unlock" [size]="16" /> {{ busy() === 'lock' ? 'Unlocking…' : 'Unlock' }}</button>
              } @else if (isMe()) {
                <p class="small muted">You can’t lock your own account.</p>
              } @else {
                <div class="lock-row">
                  <mat-form-field subscriptSizing="dynamic">
                    <mat-label>Lock for</mat-label>
                    <mat-select [value]="lockMinutes()" (valueChange)="lockMinutes.set($event)">
                      <mat-option [value]="60">1 hour</mat-option>
                      <mat-option [value]="1440">1 day</mat-option>
                      <mat-option [value]="10080">7 days</mat-option>
                      <mat-option [value]="0">Until I unlock it</mat-option>
                    </mat-select>
                  </mat-form-field>
                  <button matButton="outlined" class="btn-danger" type="button" (click)="lock(u)" [disabled]="busy() !== null"><app-icon name="lock" [size]="16" /> {{ busy() === 'lock' ? 'Locking…' : 'Lock account' }}</button>
                </div>
                <p class="small muted">Locking signs them out within a minute. Their data stays.</p>
              }
              @if (!u.emailConfirmed) {
                <div class="row verify">
                  <span class="small">Email not verified yet.</span>
                  <button matButton="text" type="button" (click)="resend(u)" [disabled]="busy() !== null"><app-icon name="mail" [size]="16" /> Resend verification email</button>
                </div>
              }
            </section>

            <section aria-labelledby="ud-courses">
              <h3 id="ud-courses">Teaches</h3>
              @for (c of u.courses; track c.id) {
                <p class="line"><app-icon name="teach" [size]="16" /> {{ c.title }} <span class="pill neutral">{{ c.role }}</span></p>
              } @empty {
                <p class="small muted">No courses.</p>
              }
              <h3>Classes</h3>
              @for (c of u.classes; track c.id) {
                <p class="line"><app-icon name="classes" [size]="16" /> {{ c.name }} <span class="muted small">· {{ c.courseTitle }}</span></p>
              } @empty {
                <p class="small muted">Not in any class.</p>
              }
            </section>
          }
        }
      }
    </aside>
  `,
  styles: `
    .head {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 10px;
      h2 {
        font-size: 1.25rem;
      }
    }
    .em {
      margin-top: -10px;
      overflow-wrap: anywhere;
    }
    .pills {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
    }
    section {
      display: flex;
      flex-direction: column;
      gap: 10px;
      padding-top: 14px;
      border-top: 1px solid var(--border);
    }
    h3 {
      font-size: 1rem;
    }
    .roles {
      border: 0;
      margin: 0;
      padding: 0;
      display: flex;
      flex-direction: column;
      gap: 6px;
    }
    .role p {
      margin: -6px 0 0 40px;
    }
    .row {
      display: flex;
      align-items: center;
      gap: 10px;
      flex-wrap: wrap;
    }
    .lock-row {
      display: flex;
      gap: 10px;
      align-items: center;
      flex-wrap: wrap;
      mat-form-field {
        width: 180px;
      }
    }
    .line {
      display: flex;
      align-items: center;
      gap: 8px;
      flex-wrap: wrap;
    }
  `,
})
export class UserDrawerComponent {
  private readonly api = inject(AdminApi);
  private readonly auth = inject(AuthStore);
  private readonly notifier = inject(Notifier);
  readonly userId = input.required<string>();
  readonly closed = output<void>();
  readonly changed = output<AdminUser>();

  readonly roleInfo = ROLE_INFO;
  readonly pills = statusPills;
  readonly user = createLoader<AdminUserDetail>(() => this.api.user(this.userId()), { immediate: false });
  readonly selected = signal<Role[]>([]);
  readonly busy = signal<'roles' | 'lock' | 'verify' | null>(null);
  readonly rolesError = signal<ApiError | null>(null);
  readonly accountError = signal<ApiError | null>(null);
  readonly lockMinutes = signal(1440);
  readonly isMe = computed(() => this.user.data()?.id === this.auth.me()?.id);
  readonly rolesChanged = computed(() => {
    const u = this.user.data();
    return !!u && this.selected().length > 0 && !sameRoles(u.roles, this.selected());
  });

  constructor() {
    effect(() => {
      this.userId();
      untracked(() => this.user.load());
    });
    effect(() => {
      const u = this.user.data();
      untracked(() => this.selected.set(u ? normalizeRoles(u.roles) : []));
    });
  }

  lockReason(role: Role, u: AdminUser): string | null {
    return roleLockReason(role, u, this.auth.me()?.id, this.selected());
  }

  toggle(role: Role, on: boolean): void {
    this.rolesError.set(null);
    this.selected.update((s) => normalizeRoles(on ? [...s, role] : s.filter((r) => r !== role)));
  }

  async saveRoles(u: AdminUserDetail): Promise<void> {
    this.busy.set('roles');
    this.rolesError.set(null);
    try {
      const updated = await firstValueFrom(this.api.setRoles(u.id, this.selected()));
      this.user.update((d) => ({ ...d, ...updated }));
      this.changed.emit(updated);
      this.notifier.success(`Roles saved for ${u.displayName}. They apply within a minute.`);
      if (u.id === this.auth.me()?.id) await this.auth.refresh();
    } catch (e) {
      this.rolesError.set(toApiError(e));
    } finally {
      this.busy.set(null);
    }
  }

  async lock(u: AdminUserDetail): Promise<void> {
    await this.account(u, () => this.api.lock(u.id, this.lockMinutes() || null), true, `${u.displayName} is locked.`);
  }
  async unlock(u: AdminUserDetail): Promise<void> {
    await this.account(u, () => this.api.unlock(u.id), false, `${u.displayName} is unlocked.`);
  }
  async resend(u: AdminUserDetail): Promise<void> {
    this.busy.set('verify');
    try {
      await firstValueFrom(this.api.resendVerification(u.id));
      this.notifier.success(`Verification email sent to ${u.email}.`);
    } catch {
      /* toast shown */
    } finally {
      this.busy.set(null);
    }
  }

  private async account(u: AdminUserDetail, call: () => ReturnType<AdminApi['unlock']>, lockedOut: boolean, done: string): Promise<void> {
    this.busy.set('lock');
    this.accountError.set(null);
    try {
      await firstValueFrom(call());
      this.user.update((d) => ({ ...d, lockedOut }));
      this.changed.emit({ ...u, lockedOut });
      this.notifier.success(done);
    } catch (e) {
      this.accountError.set(toApiError(e));
    } finally {
      this.busy.set(null);
    }
  }
}
