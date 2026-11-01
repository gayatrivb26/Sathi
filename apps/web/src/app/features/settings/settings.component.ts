import { DatePipe } from '@angular/common';
import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { MatInputModule } from '@angular/material/input';
import { firstValueFrom } from 'rxjs';
import { AuthApi } from '../../core/api/auth.api';
import { ClassesApi } from '../../core/api/classes.api';
import { formatJoinCode, joinCodeMessage, joinCodeProblem, normalizeJoinCode } from '../../core/classes/join-code';
import { toApiError } from '../../core/http/api-error';
import { createLoader } from '../../core/platform/loader';
import { confirmDialog } from '../../shared/ui/dialog/confirm-dialog.component';
import { ErrorStateComponent } from '../../shared/ui/states/error-state.component';
import { SkeletonComponent } from '../../shared/ui/states/skeleton.component';
import { FormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatDialog } from '@angular/material/dialog';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatSelectModule } from '@angular/material/select';
import { MatSlideToggleModule } from '@angular/material/slide-toggle';
import { AuthStore } from '../../core/auth/auth.store';
import { Notifier } from '../../core/errors/notifier.service';
import { Level } from '../../core/models/api.models';
import { ThemePreference, ThemeService } from '../../core/platform/theme.service';
import { IconComponent } from '../../shared/ui/icon/icon.component';
import { IconName } from '../../shared/ui/icon/icons';
import { DeleteAccountDialogComponent } from './delete-account-dialog.component';
import { hourLabel, timezonesWith } from './time-options';

@Component({
  selector: 'app-settings',
  imports: [DatePipe, FormsModule, MatButtonModule, MatFormFieldModule, MatInputModule, MatSelectModule, MatSlideToggleModule, IconComponent, SkeletonComponent, ErrorStateComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="page narrow">
      <header class="page-head"><div><h1>Settings</h1><p class="sub">Your profile, learning preferences and data.</p></div></header>

      <section class="card" aria-labelledby="profile-h">
        <h2 id="profile-h" class="card-title">Profile</h2>
        <form class="name-form" (ngSubmit)="saveName()" novalidate>
          <mat-form-field class="grow">
            <mat-label>Display name</mat-label>
            <input matInput name="displayName" [ngModel]="name()" (ngModelChange)="name.set($event); nameError.set(null)" maxlength="60" autocomplete="name" required aria-describedby="name-hint" />
            <mat-hint id="name-hint">How Sathi greets you, and what your teachers see. {{ name().length }}/60</mat-hint>
          </mat-form-field>
          <button matButton="outlined" type="submit" [disabled]="savingName() || !nameChanged()">{{ savingName() ? 'Saving…' : 'Save name' }}</button>
        </form>
        @if (nameError(); as ne) { <p class="small code-msg err" role="alert">{{ ne }}</p> }
        <dl class="profile">
          <div><dt>Email</dt><dd>{{ auth.me()?.email }} @if (auth.me()?.emailConfirmed) { <span class="pill mint"><app-icon name="check" [size]="12" [strokeWidth]="3" /> Verified</span> }</dd></div>
          <div><dt>Role</dt><dd>{{ auth.roles().join(', ') }}</dd></div>
        </dl>
      </section>

      <section class="card" aria-labelledby="classes-h">
        <div class="card-title">
          <h2 id="classes-h">My classes</h2>
        </div>
        <p class="muted small">Join your teacher’s class with the code they gave you. Classes give you access to private courses, and your teacher can see your progress in them.</p>
        <form class="join-row" (ngSubmit)="join()" novalidate>
          <label for="settings-code" class="sr-only">Class code</label>
          <input id="settings-code" class="code-input" name="code" placeholder="ABCD-EF23" autocomplete="off" autocapitalize="characters" spellcheck="false" maxlength="12"
            [ngModel]="code()" (ngModelChange)="onCode($event)" [class.bad]="!!codeError()" [attr.aria-invalid]="!!codeError()" aria-describedby="settings-code-msg" />
          <button matButton="filled" type="submit" [disabled]="joining()"><app-icon name="key" [size]="18" /> {{ joining() ? 'Joining…' : 'Join a class' }}</button>
        </form>
        <p id="settings-code-msg" class="small code-msg" [class.err]="!!codeError()" aria-live="polite">{{ codeError() ?? '' }}</p>
        @switch (classes.status()) {
          @case ('loading') { <app-skeleton [lines]="2" [card]="false" /> }
          @case ('error') { <app-error-state [error]="classes.error()" [compact]="true" title="We couldn’t load your classes" (retry)="classes.load()" /> }
          @default {
            <ul class="classes" role="list">
              @for (c of classes.data() ?? []; track c.classId) {
                <li>
                  <span class="cls-icon" aria-hidden="true"><app-icon name="classes" [size]="18" /></span>
                  <span class="cls-body">
                    <strong>{{ c.name }}</strong>
                    <span class="muted small">{{ c.course.title }} · joined {{ c.joinedAt | date: 'd MMM y' }}</span>
                  </span>
                  <button matButton="text" type="button" class="btn-danger" (click)="leave(c.classId, c.name, c.course.title)" [attr.aria-label]="'Leave ' + c.name">Leave</button>
                </li>
              } @empty {
                <li class="muted small none">You’re not in any classes yet.</li>
              }
            </ul>
          }
        }
      </section>

      <section class="card" aria-labelledby="learn-h">
        <h2 id="learn-h" class="card-title">Learning</h2>
        <fieldset class="levels">
          <legend>Default explanation level</legend>
          <div class="seg" role="group" aria-label="Default explanation level">
            @for (l of levels; track l.id) {
              <button type="button" [attr.aria-pressed]="level() === l.id" (click)="level.set(l.id)">{{ l.label }}</button>
            }
          </div>
        </fieldset>
        <div class="grid">
          <mat-slide-toggle [checked]="reminders()" (change)="reminders.set($event.checked)">Email me when revision is due</mat-slide-toggle>
          <mat-form-field>
            <mat-label>Reminder time</mat-label>
            <mat-select [value]="hour()" (valueChange)="hour.set($event)" [disabled]="!reminders()">
              @for (h of hours; track h) { <mat-option [value]="h">{{ hourLabel(h) }}</mat-option> }
            </mat-select>
          </mat-form-field>
          <mat-form-field>
            <mat-label>Time zone</mat-label>
            <mat-select [value]="tz()" (valueChange)="tz.set($event)">
              @for (z of zones; track z) { <mat-option [value]="z">{{ z }}</mat-option> }
            </mat-select>
          </mat-form-field>
        </div>
        <button matButton="filled" type="button" (click)="save()" [disabled]="saving()">{{ saving() ? 'Saving…' : 'Save preferences' }}</button>
      </section>

      <section class="card" aria-labelledby="theme-h">
        <h2 id="theme-h" class="card-title">Appearance</h2>
        <div class="themes" role="group" aria-label="Theme">
          @for (t of themes; track t.id) {
            <button type="button" class="theme" [attr.aria-pressed]="theme.preference() === t.id" (click)="theme.set(t.id)">
              <app-icon [name]="t.icon" [size]="20" /> {{ t.label }}
            </button>
          }
        </div>
        <p class="muted small">“System” follows your device’s light or dark setting. Saved on this device.</p>
      </section>

      <section class="card danger-zone" aria-labelledby="data-h">
        <h2 id="data-h" class="card-title">Your data</h2>
        <p class="muted">Deleting your account removes your profile, conversations, notes and progress. Uploaded files and their search passages are deleted from storage. This can’t be undone.</p>
        <button matButton="outlined" class="btn-danger" type="button" (click)="deleteAccount()"><app-icon name="trash" [size]="18" /> Delete my account and data</button>
      </section>
    </div>
  `,
  styles: `
    .narrow {
      max-width: 820px;
    }
    .card + .card {
      margin-top: 18px;
    }
    .name-form {
      display: flex;
      align-items: flex-start;
      gap: 12px;
      flex-wrap: wrap;
      margin-bottom: 14px;
      .grow {
        flex: 1;
        min-width: 220px;
      }
      button {
        margin-top: 6px;
        min-height: 48px;
      }
    }
    .join-row {
      display: flex;
      gap: 10px;
      flex-wrap: wrap;
      align-items: center;
      margin-top: 12px;
      .code-input {
        max-width: 240px;
        min-height: 48px;
        font-size: 1.15rem;
      }
      button {
        min-height: 48px;
      }
    }
    .code-msg {
      min-height: 1.4em;
      margin: 6px 0 4px;
      &.err {
        color: var(--danger);
        font-weight: 600;
      }
    }
    .classes {
      list-style: none;
      margin: 0;
      padding: 0;
      li {
        display: flex;
        align-items: center;
        gap: 12px;
        padding: 10px 0;
        border-top: 1px solid var(--border);
      }
      .none {
        border: 0;
      }
    }
    .cls-icon {
      display: grid;
      place-items: center;
      width: 36px;
      height: 36px;
      flex: none;
      border-radius: 12px;
      background: var(--primary-soft);
      color: var(--primary-ink);
    }
    .cls-body {
      flex: 1;
      min-width: 0;
      display: flex;
      flex-direction: column;
    }
    .profile {
      margin: 0;
      display: flex;
      flex-direction: column;
      gap: 12px;
      div {
        display: grid;
        grid-template-columns: 120px 1fr;
        gap: 12px;
        @media (max-width: 479.98px) {
          grid-template-columns: 1fr;
          gap: 2px;
        }
      }
      dt {
        color: var(--muted);
      }
      dd {
        margin: 0;
        display: flex;
        align-items: center;
        gap: 8px;
        flex-wrap: wrap;
        overflow-wrap: anywhere;
      }
    }
    .levels {
      border: 0;
      padding: 0;
      margin: 0 0 18px;
      legend {
        font-weight: 600;
        margin-bottom: 8px;
        padding: 0;
      }
    }
    .seg {
      display: inline-flex;
      flex-wrap: wrap;
      padding: 3px;
      border-radius: 14px;
      background: var(--surface-3);
      button {
        min-height: 44px;
        padding: 0 16px;
        border: 0;
        border-radius: 11px;
        background: none;
        color: var(--muted);
        font-weight: 600;
        cursor: pointer;
        &[aria-pressed='true'] {
          background: var(--primary);
          color: var(--on-primary);
        }
      }
    }
    .grid {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 12px 16px;
      margin-bottom: 14px;
      mat-slide-toggle {
        grid-column: 1 / -1;
      }
      @media (max-width: 559.98px) {
        grid-template-columns: 1fr;
      }
    }
    .themes {
      display: flex;
      gap: 10px;
      flex-wrap: wrap;
      margin-bottom: 10px;
    }
    .theme {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      min-height: 48px;
      padding: 0 18px;
      border: 2px solid var(--border);
      border-radius: 14px;
      background: var(--surface);
      font-weight: 600;
      cursor: pointer;
      &[aria-pressed='true'] {
        border-color: var(--primary);
        background: var(--primary-soft);
        color: var(--primary-soft-ink);
      }
    }
    .danger-zone {
      border-color: color-mix(in srgb, var(--danger) 35%, var(--border));
      p {
        margin-bottom: 14px;
      }
    }
  `,
})
export default class SettingsComponent {
  readonly auth = inject(AuthStore);
  readonly theme = inject(ThemeService);
  private readonly notifier = inject(Notifier);
  private readonly dialog = inject(MatDialog);

  readonly levels: { id: Level; label: string }[] = [
    { id: 'beginner', label: 'Beginner' },
    { id: 'intermediate', label: 'Intermediate' },
    { id: 'advanced', label: 'Advanced' },
  ];
  readonly themes: { id: ThemePreference; label: string; icon: IconName }[] = [
    { id: 'system', label: 'System', icon: 'monitor' },
    { id: 'light', label: 'Light', icon: 'sun' },
    { id: 'dark', label: 'Dark', icon: 'moon' },
  ];
  readonly hours = Array.from({ length: 24 }, (_, h) => h);
  readonly hourLabel = hourLabel;
  readonly zones = timezonesWith(this.auth.me()?.preferences.timezone);

  readonly level = signal<Level>(this.auth.me()?.preferences.level ?? 'beginner');
  readonly reminders = signal(this.auth.me()?.preferences.remindersEnabled ?? true);
  readonly hour = signal(this.auth.me()?.preferences.reminderHour ?? 18);
  readonly tz = signal(this.auth.me()?.preferences.timezone ?? 'Asia/Kolkata');
  readonly saving = signal(false);

  // profile (§11.3)
  private readonly authApi = inject(AuthApi);
  readonly name = signal(this.auth.me()?.displayName ?? '');
  readonly nameError = signal<string | null>(null);
  readonly savingName = signal(false);
  readonly nameChanged = computed(() => this.name().trim() !== (this.auth.me()?.displayName ?? '') && this.name().trim().length > 0);

  // classes (§11.1)
  private readonly classesApi = inject(ClassesApi);
  readonly classes = createLoader(() => this.classesApi.myClasses());
  readonly code = signal('');
  readonly codeError = signal<string | null>(null);
  readonly joining = signal(false);

  async saveName(): Promise<void> {
    const displayName = this.name().trim();
    if (!displayName || displayName.length > 60) {
      this.nameError.set('Use 1–60 characters.');
      return;
    }
    this.savingName.set(true);
    this.nameError.set(null);
    try {
      this.auth.set(await firstValueFrom(this.authApi.updateProfile({ displayName })));
      this.name.set(displayName);
      this.notifier.success('Name saved.');
    } catch (e) {
      const err = toApiError(e);
      this.nameError.set(err.fieldErrors['displayName']?.[0] ?? err.userMessage);
    } finally {
      this.savingName.set(false);
    }
  }

  onCode(value: string): void {
    this.code.set(formatJoinCode(value));
    this.codeError.set(null);
  }

  async join(): Promise<void> {
    const problem = joinCodeProblem(this.code());
    if (problem) {
      this.codeError.set(joinCodeMessage(problem));
      return;
    }
    this.joining.set(true);
    try {
      const r = await firstValueFrom(this.classesApi.join(normalizeJoinCode(this.code())));
      this.code.set('');
      this.classes.load();
      await this.auth.refresh();
      this.notifier.success(`You joined ${r.className} (${r.course.title}).`);
    } catch (e) {
      this.codeError.set(toApiError(e).userMessage);
    } finally {
      this.joining.set(false);
    }
  }

  async leave(classId: string, name: string, courseTitle: string): Promise<void> {
    const ok = await firstValueFrom(
      confirmDialog(this.dialog, { title: `Leave ${name}?`, message: `Your teacher will no longer see your progress in this class. If “${courseTitle}” is private, you’ll lose access to it until you join again. Your own notes and history stay.`, confirmText: 'Leave class', danger: true }),
    );
    if (!ok) return;
    try {
      await firstValueFrom(this.classesApi.leave(classId));
      this.classes.update((l) => l.filter((c) => c.classId !== classId));
      this.notifier.success(`You left ${name}.`);
    } catch {
      /* toast shown */
    }
  }

  async save(): Promise<void> {
    this.saving.set(true);
    try {
      await this.auth.updatePreferences({ level: this.level(), remindersEnabled: this.reminders(), reminderHour: this.hour(), timezone: this.tz() });
      this.notifier.success('Preferences saved.');
    } catch {
      /* toast shown */
    } finally {
      this.saving.set(false);
    }
  }

  deleteAccount(): void {
    this.dialog.open(DeleteAccountDialogComponent, { width: '480px', maxWidth: 'calc(100vw - 32px)' });
  }
}
