import { DatePipe } from '@angular/common';
import { ChangeDetectionStrategy, Component, computed, effect, inject, input, output, signal, untracked } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatDialog } from '@angular/material/dialog';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatSlideToggleModule } from '@angular/material/slide-toggle';
import { firstValueFrom, Observable } from 'rxjs';
import { environment } from '../../../environments/environment';
import { InstructorApi } from '../../core/api/staff.api';
import { formatJoinCode, joinLink, parseEmailList, shareText } from '../../core/classes/join-code';
import { Notifier } from '../../core/errors/notifier.service';
import { ApiError, toApiError } from '../../core/http/api-error';
import { ClassInviteResult, ClassMember, ClassSummary } from '../../core/models/api.models';
import { copyText } from '../../core/platform/clipboard';
import { createLoader } from '../../core/platform/loader';
import { confirmDialog } from '../../shared/ui/dialog/confirm-dialog.component';
import { IconComponent } from '../../shared/ui/icon/icon.component';
import { ErrorStateComponent } from '../../shared/ui/states/error-state.component';
import { SkeletonComponent } from '../../shared/ui/states/skeleton.component';

const VIA: Record<string, string> = { code: 'code', invite: 'email invite', added: 'added by staff' };

/** One class: share code/link, joining on/off, new code, archive, members, email invites. */
@Component({
  selector: 'app-class-detail',
  imports: [DatePipe, FormsModule, MatButtonModule, MatFormFieldModule, MatInputModule, MatSlideToggleModule, IconComponent, SkeletonComponent, ErrorStateComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <section class="card" [attr.aria-labelledby]="'cd-h-' + cls().id">
      <div class="head">
        @if (editing()) {
          <form class="edit" (ngSubmit)="saveDetails()" novalidate>
            <mat-form-field subscriptSizing="dynamic"><mat-label>Class name</mat-label><input matInput name="n" [ngModel]="eName()" (ngModelChange)="eName.set($event)" maxlength="80" /></mat-form-field>
            <mat-form-field subscriptSizing="dynamic"><mat-label>Description</mat-label><input matInput name="d" [ngModel]="eDesc()" (ngModelChange)="eDesc.set($event)" maxlength="200" /></mat-form-field>
            <div class="row">
              <button matButton="filled" type="submit" [disabled]="busy() !== null || !eName().trim()">Save</button>
              <button matButton="text" type="button" (click)="editing.set(false)">Cancel</button>
            </div>
          </form>
        } @else {
          <div class="title">
            <h2 [id]="'cd-h-' + cls().id">{{ cls().name }}</h2>
            @if (cls().description) { <p class="muted small">{{ cls().description }}</p> }
            <p class="muted small">{{ courseTitle() }} · created {{ cls().createdAt | date: 'd MMM y' }}</p>
          </div>
          <div class="row">
            <button matButton="text" type="button" (click)="startEdit()"><app-icon name="pencil" [size]="16" /> Edit</button>
            @if (cls().archivedAt) {
              <button matButton="outlined" type="button" (click)="unarchive()" [disabled]="busy() !== null"><app-icon name="archive-restore" [size]="16" /> Unarchive</button>
            } @else {
              <button matButton="text" type="button" (click)="archive()" [disabled]="busy() !== null"><app-icon name="archive" [size]="16" /> Archive</button>
            }
          </div>
        }
      </div>

      @if (cls().archivedAt) {
        <div class="inline-alert info" role="note">
          <app-icon name="archive" [size]="18" />
          <p>Archived {{ cls().archivedAt | date: 'd MMM y' }}. The code doesn’t work and members lose access to a private course through this class; their history is kept. Unarchive to reopen it.</p>
        </div>
      } @else {
        <div class="share" aria-label="Share this class">
          <div class="code-box">
            <span class="lbl">Join code</span>
            <span class="join-code big" [class.off]="!cls().joinEnabled" [attr.aria-label]="'Join code ' + spaced()">{{ code() }}</span>
            <div class="row">
              <button matButton="outlined" type="button" (click)="copy(code(), 'Code copied.')"><app-icon name="copy" [size]="16" /> Copy code</button>
              <button matButton="outlined" type="button" (click)="copy(link(), 'Join link copied.')"><app-icon name="link" [size]="16" /> Copy link</button>
              <button matButton="outlined" type="button" (click)="share()"><app-icon name="share" [size]="16" /> {{ canShare ? 'Share…' : 'Copy message' }}</button>
            </div>
            <p class="link small muted"><span class="sr-only">Join link: </span>{{ link() }}</p>
          </div>
          <div class="controls">
            <mat-slide-toggle [checked]="cls().joinEnabled" (change)="setJoin($event.checked)" [disabled]="busy() !== null">Students can join with this code</mat-slide-toggle>
            <p class="small muted">{{ cls().joinEnabled ? 'Anyone with the code or link can join.' : 'Joining is off — the code is kept but doesn’t work. Email invites still work.' }}</p>
            <button matButton="text" type="button" (click)="regenerate()" [disabled]="busy() !== null"><app-icon name="refresh" [size]="16" /> Get a new code</button>
          </div>
        </div>
      }
      @if (actionError(); as e) {
        <div class="inline-alert" role="alert"><app-icon name="alert" [size]="18" /><div><p>{{ e.userMessage }}</p></div></div>
      }
    </section>

    <section class="card" [attr.aria-labelledby]="'mem-h-' + cls().id">
      <div class="card-title">
        <h2 [id]="'mem-h-' + cls().id">Students <span class="count num">{{ cls().memberCount }}</span></h2>
      </div>
      @switch (members.status()) {
        @case ('loading') { <app-skeleton [lines]="4" [card]="false" /> }
        @case ('error') { <app-error-state [error]="members.error()" [compact]="true" title="We couldn’t load the students" (retry)="members.load()" /> }
        @default {
          @if ((members.data() ?? []).length) {
            <ul class="members" role="list">
              @for (m of members.data() ?? []; track m.userId) {
                <li>
                  <span class="who">
                    <strong>{{ m.displayName }}</strong>
                    <span class="muted small">{{ m.email }}</span>
                  </span>
                  <span class="small muted when">Joined {{ m.joinedAt | date: 'd MMM' }} by {{ via(m) }}<br />{{ m.lastActiveAt ? 'Active ' + (m.lastActiveAt | date: 'd MMM') : 'Not active yet' }}</span>
                  <span class="mastery small">
                    @if (m.averageMastery !== null) {
                      <span class="bar thin" aria-hidden="true"><span class="fill" [style.width.%]="m.averageMastery * 100"></span></span>
                      <span class="num">{{ pct(m.averageMastery) }}% avg</span>
                    } @else {
                      <span class="muted">No practice yet</span>
                    }
                  </span>
                  <button type="button" class="icon-only" (click)="removeMember(m)" [attr.aria-label]="'Remove ' + m.displayName + ' from ' + cls().name"><app-icon name="user-minus" [size]="18" /></button>
                </li>
              }
            </ul>
          } @else {
            <p class="muted">No students yet. Share the code above or invite them by email below.</p>
          }
        }
      }
    </section>

    @if (!cls().archivedAt) {
      <section class="card" [attr.aria-labelledby]="'inv-h-' + cls().id">
        <h2 class="card-title" [id]="'inv-h-' + cls().id">Invite by email</h2>
        <form (ngSubmit)="invite()" novalidate class="invite">
          <mat-form-field subscriptSizing="dynamic">
            <mat-label>Email addresses</mat-label>
            <textarea matInput name="emails" rows="4" [ngModel]="emailText()" (ngModelChange)="emailText.set($event); inviteResult.set(null)" placeholder="asha@school.in, rahul@school.in&#10;or paste a column from a spreadsheet" aria-describedby="inv-count"></textarea>
          </mat-form-field>
          <p id="inv-count" class="small muted" aria-live="polite">
            @if (parsed().valid.length || parsed().invalid.length) {
              {{ parsed().valid.length }} email{{ parsed().valid.length === 1 ? '' : 's' }} ready{{ parsed().invalid.length ? ' · ' + parsed().invalid.length + ' don’t look like emails: ' + parsed().invalid.join(', ') : '' }}{{ parsed().valid.length > 100 ? ' · up to 100 at a time' : '' }}
            } @else {
              Separate with commas, spaces or new lines. Each person gets a link that works for 14 days.
            }
          </p>
          <button matButton="filled" type="submit" [disabled]="busy() !== null || !parsed().valid.length || parsed().valid.length > 100"><app-icon name="send" [size]="16" /> {{ busy() === 'invite' ? 'Sending…' : 'Send invites' }}</button>
        </form>
        @if (inviteResult(); as r) {
          <div class="inline-alert" [class.ok]="r.invited > 0" [class.info]="r.invited === 0" role="status">
            <app-icon [name]="r.invited > 0 ? 'check-circle' : 'info'" [size]="18" />
            <div>
              <p><strong>{{ r.invited }}</strong> invite{{ r.invited === 1 ? '' : 's' }} sent.</p>
              @if (r.alreadyMembers.length) { <p class="small">Already in this class: {{ r.alreadyMembers.join(', ') }}</p> }
              @if (r.invalid.length) { <p class="small">Not valid: {{ r.invalid.join(', ') }}</p> }
              @if (demoLink()) { <p class="small">Demo mode: <a [href]="demoLink()">open the last invite link</a></p> }
            </div>
          </div>
        }

        <h3 class="pending-h">Pending invites</h3>
        @switch (invites.status()) {
          @case ('loading') { <app-skeleton [lines]="2" [card]="false" /> }
          @case ('error') { <app-error-state [error]="invites.error()" [compact]="true" title="We couldn’t load the invites" (retry)="invites.load()" /> }
          @default {
            <ul class="invites" role="list">
              @for (i of invites.data() ?? []; track i.id) {
                <li>
                  <span class="who"><strong class="mail">{{ i.email }}</strong><span class="muted small">Sent {{ i.createdAt | date: 'd MMM' }} · {{ i.status === 'expired' ? 'expired ' : 'expires ' }}{{ i.expiresAt | date: 'd MMM' }}</span></span>
                  <span class="pill" [class.amber]="i.status === 'pending'" [class.neutral]="i.status !== 'pending'">{{ i.status === 'pending' ? 'Waiting' : i.status === 'expired' ? 'Expired' : 'Revoked' }}</span>
                  <span class="row">
                    <button matButton="text" type="button" (click)="resend(i.id, i.email)" [attr.aria-label]="'Resend invite to ' + i.email">Resend</button>
                    @if (i.status === 'pending') {
                      <button matButton="text" type="button" class="btn-danger" (click)="revoke(i.id, i.email)" [attr.aria-label]="'Revoke invite for ' + i.email">Revoke</button>
                    }
                  </span>
                </li>
              } @empty {
                <li class="muted small">No invites waiting.</li>
              }
            </ul>
          }
        }
      </section>
    }
  `,
  styles: `
    :host {
      display: flex;
      flex-direction: column;
      gap: 18px;
    }
    .head {
      display: flex;
      justify-content: space-between;
      align-items: flex-start;
      gap: 12px;
      flex-wrap: wrap;
      margin-bottom: 14px;
    }
    .title h2 {
      font-size: 1.3rem;
    }
    .edit {
      flex: 1;
      display: flex;
      flex-direction: column;
      gap: 10px;
      min-width: 240px;
    }
    .row {
      display: flex;
      gap: 6px;
      flex-wrap: wrap;
      align-items: center;
    }
    .share {
      display: grid;
      grid-template-columns: minmax(0, 1.4fr) minmax(0, 1fr);
      gap: 18px;
      @media (max-width: 719.98px) {
        grid-template-columns: minmax(0, 1fr);
      }
    }
    .code-box {
      display: flex;
      flex-direction: column;
      gap: 10px;
      padding: 16px;
      border-radius: 16px;
      background: var(--surface-2);
      border: 1px dashed var(--border-input);
    }
    .lbl {
      font-size: 0.75rem;
      font-weight: 700;
      letter-spacing: 0.08em;
      text-transform: uppercase;
      color: var(--muted);
    }
    .big {
      font-size: clamp(1.8rem, 1.2rem + 2vw, 2.4rem);
      color: var(--ink);
      &.off {
        color: var(--muted);
        text-decoration: line-through;
      }
    }
    .link {
      overflow-wrap: anywhere;
      margin: 0;
    }
    .controls {
      display: flex;
      flex-direction: column;
      align-items: flex-start;
      gap: 6px;
      p {
        margin: 0;
      }
    }
    .inline-alert {
      margin-top: 12px;
    }
    .count {
      margin-left: 6px;
      font-size: 0.9rem;
      color: var(--muted);
    }
    .members,
    .invites {
      list-style: none;
      margin: 0;
      padding: 0;
      li {
        display: grid;
        grid-template-columns: minmax(0, 1.4fr) minmax(0, 1fr) 140px auto;
        align-items: center;
        gap: 12px;
        padding: 10px 0;
        border-bottom: 1px solid var(--border);
        &:last-child {
          border-bottom: 0;
        }
        @media (max-width: 719.98px) {
          grid-template-columns: minmax(0, 1fr) auto;
          .when,
          .mastery {
            grid-column: 1;
          }
          .icon-only {
            grid-row: 1;
            grid-column: 2;
          }
        }
      }
    }
    .invites li {
      grid-template-columns: minmax(0, 1fr) auto auto;
      @media (max-width: 719.98px) {
        grid-template-columns: minmax(0, 1fr) auto;
        .row {
          grid-column: 1 / -1;
        }
      }
    }
    .who {
      display: flex;
      flex-direction: column;
      min-width: 0;
      overflow-wrap: anywhere;
    }
    .mastery {
      display: flex;
      align-items: center;
      gap: 8px;
      .bar {
        width: 60px;
        display: block;
      }
      .fill {
        display: block;
      }
    }
    .invite {
      display: flex;
      flex-direction: column;
      gap: 8px;
      button {
        align-self: flex-start;
      }
    }
    .pending-h {
      font-size: 1rem;
      margin: 22px 0 6px;
    }
  `,
})
export class ClassDetailComponent {
  private readonly api = inject(InstructorApi);
  private readonly dialog = inject(MatDialog);
  private readonly notifier = inject(Notifier);
  readonly cls = input.required<ClassSummary>();
  readonly courseTitle = input('');
  readonly changed = output<ClassSummary>();

  readonly canShare = typeof navigator !== 'undefined' && typeof navigator.share === 'function';
  readonly busy = signal<'update' | 'code' | 'archive' | 'invite' | null>(null);
  readonly actionError = signal<ApiError | null>(null);
  readonly editing = signal(false);
  readonly eName = signal('');
  readonly eDesc = signal('');
  readonly emailText = signal('');
  readonly inviteResult = signal<ClassInviteResult | null>(null);
  readonly demoLink = signal<string | null>(null);

  readonly code = computed(() => formatJoinCode(this.cls().joinCode));
  readonly spaced = computed(() => this.code().split('').join(' '));
  readonly link = computed(() => joinLink(location.origin, this.cls().joinCode));
  readonly parsed = computed(() => parseEmailList(this.emailText()));

  readonly members = createLoader(() => this.api.members(this.cls().id), { immediate: false });
  readonly invites = createLoader(() => this.api.classInvites(this.cls().id), { immediate: false });

  constructor() {
    effect(() => {
      this.cls().id;
      untracked(() => {
        this.editing.set(false);
        this.actionError.set(null);
        this.inviteResult.set(null);
        this.emailText.set('');
        this.members.load();
        this.invites.load();
      });
    });
  }

  via(m: ClassMember): string {
    return VIA[m.joinedVia] ?? m.joinedVia;
  }
  pct(v: number): number {
    return Math.round(v * 100);
  }

  async copy(text: string, done: string): Promise<void> {
    if (await copyText(text)) this.notifier.success(done);
    else this.notifier.error('Your browser blocked copying. Select the text and copy it yourself.');
  }

  async share(): Promise<void> {
    const text = shareText({ className: this.cls().name, courseTitle: this.courseTitle(), code: this.cls().joinCode, origin: location.origin });
    if (this.canShare) {
      try {
        await navigator.share({ title: `Join ${this.cls().name} on Sathi`, text });
        return;
      } catch {
        /* cancelled or unsupported — fall back to copying */
      }
    }
    await this.copy(text, 'Invitation message copied — paste it into your class group.');
  }

  startEdit(): void {
    this.eName.set(this.cls().name);
    this.eDesc.set(this.cls().description ?? '');
    this.editing.set(true);
  }

  async saveDetails(): Promise<void> {
    const ok = await this.run('update', () => this.api.updateClass(this.cls().id, { name: this.eName().trim(), description: this.eDesc().trim() || null, joinEnabled: this.cls().joinEnabled }));
    if (ok) this.editing.set(false);
  }

  async setJoin(on: boolean): Promise<void> {
    await this.run('update', () => this.api.updateClass(this.cls().id, { name: this.cls().name, description: this.cls().description, joinEnabled: on }), on ? 'Joining is on.' : 'Joining is off. The code no longer works.');
  }

  async regenerate(): Promise<void> {
    const ok = await firstValueFrom(
      confirmDialog(this.dialog, { title: 'Get a new join code?', message: `The current code ${this.code()} and its link stop working straight away. Students already in the class stay in it.`, confirmText: 'Get new code' }),
    );
    if (ok) await this.run('code', () => this.api.regenerateCode(this.cls().id), 'New code ready. Share it with your students.');
  }

  async archive(): Promise<void> {
    const ok = await firstValueFrom(
      confirmDialog(this.dialog, { title: `Archive ${this.cls().name}?`, message: 'The code stops working and the class is hidden from your list. If the course is private, members lose access through this class. You can unarchive it later.', confirmText: 'Archive class' }),
    );
    if (ok) await this.run('archive', () => this.api.archiveClass(this.cls().id), 'Class archived.');
  }

  async unarchive(): Promise<void> {
    await this.run('archive', () => this.api.unarchiveClass(this.cls().id), 'Class reopened.');
  }

  async removeMember(m: ClassMember): Promise<void> {
    const ok = await firstValueFrom(
      confirmDialog(this.dialog, { title: `Remove ${m.displayName}?`, message: `They leave ${this.cls().name}. Their own notes and history are kept; if the course is private they lose access unless they’re in another class.`, confirmText: 'Remove student', danger: true }),
    );
    if (!ok) return;
    try {
      await firstValueFrom(this.api.removeMember(this.cls().id, m.userId));
      this.members.update((l) => l.filter((x) => x.userId !== m.userId));
      this.changed.emit({ ...this.cls(), memberCount: Math.max(0, this.cls().memberCount - 1) });
      this.notifier.success(`${m.displayName} removed from ${this.cls().name}.`);
    } catch {
      /* toast shown */
    }
  }

  async invite(): Promise<void> {
    const emails = this.parsed().valid;
    if (!emails.length) return;
    this.busy.set('invite');
    try {
      const r = await firstValueFrom(this.api.inviteToClass(this.cls().id, emails));
      this.inviteResult.set({ ...r, invalid: [...this.parsed().invalid, ...r.invalid] });
      this.emailText.set('');
      this.invites.load();
      this.changed.emit({ ...this.cls(), pendingInvites: this.cls().pendingInvites + r.invited });
      if (environment.mockApi) this.demoLink.set(readDemo());
    } catch {
      /* toast shown */
    } finally {
      this.busy.set(null);
    }
  }

  async resend(id: string, email: string): Promise<void> {
    try {
      await firstValueFrom(this.api.resendInvite(id));
      this.invites.load();
      this.notifier.success(`Invite sent to ${email} again.`);
    } catch {
      /* toast shown */
    }
  }

  async revoke(id: string, email: string): Promise<void> {
    const ok = await firstValueFrom(confirmDialog(this.dialog, { title: 'Revoke this invite?', message: `The link sent to ${email} stops working.`, confirmText: 'Revoke invite', danger: true }));
    if (!ok) return;
    try {
      await firstValueFrom(this.api.revokeInvite(id));
      this.invites.update((l) => l.map((i) => (i.id === id ? { ...i, status: 'revoked' } : i)));
      this.changed.emit({ ...this.cls(), pendingInvites: Math.max(0, this.cls().pendingInvites - 1) });
    } catch {
      /* toast shown */
    }
  }

  private async run(kind: 'update' | 'code' | 'archive', call: () => Observable<ClassSummary>, done?: string): Promise<boolean> {
    this.busy.set(kind);
    this.actionError.set(null);
    try {
      const updated = await firstValueFrom(call());
      this.changed.emit(updated);
      if (done) this.notifier.success(done);
      return true;
    } catch (e) {
      this.actionError.set(toApiError(e));
      return false;
    } finally {
      this.busy.set(null);
    }
  }
}

function readDemo(): string | null {
  try {
    return sessionStorage.getItem('sathi.mock.lastClassInviteLink');
  } catch {
    return null;
  }
}
