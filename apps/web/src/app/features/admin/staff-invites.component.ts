import { DatePipe } from '@angular/common';
import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatDialog } from '@angular/material/dialog';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatRadioModule } from '@angular/material/radio';
import { MatSelectModule } from '@angular/material/select';
import { firstValueFrom } from 'rxjs';
import { environment } from '../../../environments/environment';
import { AdminApi, InstructorApi } from '../../core/api/staff.api';
import { Notifier } from '../../core/errors/notifier.service';
import { ApiError, toApiError } from '../../core/http/api-error';
import { StaffInviteCreated, StaffRole } from '../../core/models/api.models';
import { createLoader } from '../../core/platform/loader';
import { confirmDialog } from '../../shared/ui/dialog/confirm-dialog.component';
import { IconComponent } from '../../shared/ui/icon/icon.component';
import { EmptyStateComponent } from '../../shared/ui/states/empty-state.component';
import { ErrorStateComponent } from '../../shared/ui/states/error-state.component';
import { SkeletonComponent } from '../../shared/ui/states/skeleton.component';

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

/** Admin → Staff invites (contracts.md §11.2): invite an Instructor or Admin by email, list and revoke. */
@Component({
  selector: 'app-staff-invites',
  imports: [DatePipe, FormsModule, MatButtonModule, MatFormFieldModule, MatInputModule, MatRadioModule, MatSelectModule, IconComponent, SkeletonComponent, ErrorStateComponent, EmptyStateComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="grid">
      <section class="card" aria-labelledby="si-new">
        <h2 id="si-new" class="card-title">Invite staff</h2>
        <p class="muted small">We email a sign-up link that works for 7 days. New people register with it; people who already have an account accept it while signed in with the same email.</p>
        <form (ngSubmit)="send()" novalidate class="form">
          <mat-form-field>
            <mat-label>Email</mat-label>
            <input matInput type="email" name="email" [ngModel]="email()" (ngModelChange)="email.set($event); emailError.set(null)" required autocomplete="off" />
            @if (emailError(); as ee) { <mat-hint class="err">{{ ee }}</mat-hint> }
          </mat-form-field>
          <fieldset class="role">
            <legend>Role</legend>
            <mat-radio-group [value]="role()" (change)="role.set($event.value)" aria-label="Role">
              <mat-radio-button value="Instructor">Instructor <span class="muted small">— builds courses and runs classes</span></mat-radio-button>
              <mat-radio-button value="Admin">Admin <span class="muted small">— manages users, roles and every course</span></mat-radio-button>
            </mat-radio-group>
          </fieldset>
          <mat-form-field>
            <mat-label>Add them to a course (optional)</mat-label>
            <mat-select [value]="courseId()" (valueChange)="courseId.set($event)">
              <mat-option value="">No course</mat-option>
              @for (c of courses.data() ?? []; track c.id) { <mat-option [value]="c.id">{{ c.title }}</mat-option> }
            </mat-select>
            <mat-hint>They become an instructor of this course when they accept.</mat-hint>
          </mat-form-field>
          @if (error(); as e) {
            <div class="inline-alert" role="alert"><app-icon name="alert" [size]="18" /><div><p>{{ e.userMessage }}</p></div></div>
          }
          @if (sent(); as s) {
            <div class="inline-alert ok" role="status">
              <app-icon name="check-circle" [size]="18" />
              <div>
                <p>Invite sent to <strong>{{ s.email }}</strong> as {{ s.role }}. It expires {{ s.expiresAt | date: 'd MMM, HH:mm' }}.</p>
                @if (demoLink()) { <p class="small">Demo mode: <a [href]="demoLink()">open the invite link</a></p> }
              </div>
            </div>
          }
          <button matButton="filled" type="submit" [disabled]="busy()"><app-icon name="send" [size]="16" /> {{ busy() ? 'Sending…' : 'Send invite' }}</button>
        </form>
      </section>

      <section class="card" aria-labelledby="si-list">
        <h2 id="si-list" class="card-title">Invites</h2>
        @switch (invites.status()) {
          @case ('loading') { <app-skeleton [lines]="5" [card]="false" /> }
          @case ('error') { <app-error-state [error]="invites.error()" [compact]="true" title="We couldn’t load invites" (retry)="invites.load()" /> }
          @default {
            @if ((invites.data() ?? []).length) {
              <ul class="list" role="list">
                @for (i of invites.data() ?? []; track i.id) {
                  <li>
                    <span class="body">
                      <strong class="mail">{{ i.email }}</strong>
                      <span class="muted small">{{ i.role }}{{ i.courseTitle ? ' · ' + i.courseTitle : '' }} · sent {{ i.createdAt | date: 'd MMM' }}{{ i.status === 'pending' ? ' · expires ' + (i.expiresAt | date: 'd MMM') : '' }}</span>
                    </span>
                    <span class="pill" [class]="tone(i.status)">{{ label(i.status) }}</span>
                    @if (i.status === 'pending') {
                      <button matButton="text" type="button" class="btn-danger" (click)="revoke(i.id, i.email)" [attr.aria-label]="'Revoke invite for ' + i.email">Revoke</button>
                    }
                  </li>
                }
              </ul>
            } @else {
              <app-empty-state [plain]="true" icon="mail" title="No staff invites yet" text="Invite your first instructor with the form." />
            }
          }
        }
      </section>
    </div>
  `,
  styles: `
    .grid {
      display: grid;
      grid-template-columns: minmax(0, 1fr) minmax(0, 1.2fr);
      gap: 22px;
      align-items: start;
      @media (max-width: 959.98px) {
        grid-template-columns: minmax(0, 1fr);
      }
    }
    .form {
      display: flex;
      flex-direction: column;
      gap: 12px;
      margin-top: 12px;
      button {
        align-self: flex-start;
      }
    }
    .err {
      color: var(--danger);
      font-weight: 600;
    }
    .role {
      border: 0;
      margin: 0;
      padding: 0;
      legend {
        font-weight: 600;
        margin-bottom: 4px;
      }
      mat-radio-group {
        display: flex;
        flex-direction: column;
      }
    }
    .list {
      list-style: none;
      margin: 0;
      padding: 0;
      li {
        display: flex;
        align-items: center;
        gap: 10px;
        flex-wrap: wrap;
        padding: 10px 0;
        border-bottom: 1px solid var(--border);
        &:last-child {
          border-bottom: 0;
        }
      }
    }
    .body {
      flex: 1;
      min-width: 200px;
      display: flex;
      flex-direction: column;
    }
    .mail {
      overflow-wrap: anywhere;
    }
  `,
})
export default class StaffInvitesComponent {
  private readonly api = inject(AdminApi);
  private readonly instructor = inject(InstructorApi);
  private readonly dialog = inject(MatDialog);
  private readonly notifier = inject(Notifier);

  readonly invites = createLoader(() => this.api.staffInvites());
  readonly courses = createLoader(() => this.instructor.courses());
  readonly email = signal('');
  readonly emailError = signal<string | null>(null);
  readonly role = signal<StaffRole>('Instructor');
  readonly courseId = signal('');
  readonly busy = signal(false);
  readonly error = signal<ApiError | null>(null);
  readonly sent = signal<StaffInviteCreated | null>(null);
  readonly demoLink = signal<string | null>(null);

  label(status: string): string {
    return { pending: 'Waiting', accepted: 'Accepted', expired: 'Expired', revoked: 'Revoked' }[status] ?? status;
  }
  tone(status: string): string {
    return { pending: 'amber', accepted: 'mint', expired: 'neutral', revoked: 'neutral' }[status] ?? 'neutral';
  }

  async send(): Promise<void> {
    const email = this.email().trim();
    if (!EMAIL.test(email)) {
      this.emailError.set('Enter a valid email address.');
      return;
    }
    this.busy.set(true);
    this.error.set(null);
    this.sent.set(null);
    try {
      const created = await firstValueFrom(this.api.createStaffInvite({ email, role: this.role(), ...(this.courseId() ? { courseId: this.courseId() } : {}) }));
      this.sent.set(created);
      this.email.set('');
      this.invites.load();
      if (environment.mockApi) this.demoLink.set(readDemo());
    } catch (e) {
      const err = toApiError(e);
      const field = err.fieldErrors['email']?.[0];
      if (field) this.emailError.set(field);
      else this.error.set(err);
    } finally {
      this.busy.set(false);
    }
  }

  async revoke(id: string, email: string): Promise<void> {
    const ok = await firstValueFrom(confirmDialog(this.dialog, { title: 'Revoke this invite?', message: `The link sent to ${email} will stop working. You can invite them again later.`, confirmText: 'Revoke invite', danger: true }));
    if (!ok) return;
    try {
      await firstValueFrom(this.api.revokeStaffInvite(id));
      this.invites.update((l) => l.map((i) => (i.id === id ? { ...i, status: 'revoked' } : i)));
      this.notifier.success('Invite revoked.');
    } catch {
      /* toast shown */
    }
  }
}

function readDemo(): string | null {
  try {
    return sessionStorage.getItem('sathi.mock.lastStaffInviteLink');
  } catch {
    return null;
  }
}
