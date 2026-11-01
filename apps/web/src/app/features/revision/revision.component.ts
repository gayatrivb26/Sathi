import { DatePipe } from '@angular/common';
import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatSelectModule } from '@angular/material/select';
import { MatSlideToggleModule } from '@angular/material/slide-toggle';
import { RouterLink } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import { LearningApi } from '../../core/api/learning.api';
import { AuthStore } from '../../core/auth/auth.store';
import { Notifier } from '../../core/errors/notifier.service';
import { ApiError, toApiError } from '../../core/http/api-error';
import { RevisionReviewResult } from '../../core/models/api.models';
import { createLoader } from '../../core/platform/loader';
import { QuestionCardComponent } from '../../shared/quiz/question-card.component';
import { IconComponent } from '../../shared/ui/icon/icon.component';
import { EmptyStateComponent } from '../../shared/ui/states/empty-state.component';
import { ErrorStateComponent } from '../../shared/ui/states/error-state.component';
import { SkeletonComponent } from '../../shared/ui/states/skeleton.component';
import { hourLabel, timezonesWith } from '../settings/time-options';

const RATINGS = [
  { quality: 1, label: 'Again', hint: 'I didn’t know it' },
  { quality: 3, label: 'Hard', hint: 'Took real effort' },
  { quality: 4, label: 'Good', hint: 'Knew it after a moment' },
  { quality: 5, label: 'Easy', hint: 'Knew it instantly' },
];

@Component({
  selector: 'app-revision',
  imports: [DatePipe, FormsModule, RouterLink, MatButtonModule, MatFormFieldModule, MatSelectModule, MatSlideToggleModule, IconComponent, QuestionCardComponent, SkeletonComponent, ErrorStateComponent, EmptyStateComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './revision.component.html',
  styleUrl: './revision.component.scss',
})
export default class RevisionComponent {
  private readonly api = inject(LearningApi);
  private readonly auth = inject(AuthStore);
  private readonly notifier = inject(Notifier);

  readonly ratings = RATINGS;
  readonly timezones = timezonesWith(this.auth.me()?.preferences.timezone);
  readonly hours = Array.from({ length: 24 }, (_, h) => h);
  readonly hourLabel = hourLabel;

  readonly due = createLoader(() => this.api.revisionDue(this.auth.activeCourseId()));
  readonly schedule = createLoader(() => this.api.revisionSchedule(this.auth.activeCourseId()));

  readonly started = signal(false);
  readonly index = signal(0);
  readonly selected = signal<string | null>(null);
  readonly freeText = signal('');
  readonly result = signal<(RevisionReviewResult & { selectedOptionId: string | null }) | null>(null);
  readonly busy = signal(false);
  readonly error = signal<ApiError | null>(null);
  readonly reviewed = signal(0);

  readonly cards = computed(() => this.due.data()?.cards ?? []);
  readonly card = computed(() => this.cards()[this.index()] ?? null);
  readonly finished = computed(() => this.started() && this.index() >= this.cards().length);
  readonly minutes = computed(() => Math.max(1, Math.ceil(this.cards().length * 1.2)));
  readonly maxDay = computed(() => Math.max(1, ...(this.schedule.data()?.days ?? []).map((d) => d.count)));
  readonly upcoming = computed(() => (this.schedule.data()?.days ?? []).reduce((s, d) => s + d.count, 0));

  // reminders
  readonly remindersEnabled = signal(this.auth.me()?.preferences.remindersEnabled ?? true);
  readonly reminderHour = signal(this.auth.me()?.preferences.reminderHour ?? 18);
  readonly timezone = signal(this.auth.me()?.preferences.timezone ?? 'Asia/Kolkata');
  readonly savingPrefs = signal(false);

  canRate(): boolean {
    const c = this.card();
    if (!c) return false;
    return c.question.type === 'mcq' ? !!this.selected() : this.freeText().trim().length > 0;
  }

  async rate(quality: number): Promise<void> {
    const c = this.card();
    if (!c || !this.canRate()) return;
    this.busy.set(true);
    this.error.set(null);
    try {
      const body = c.question.type === 'mcq' ? { selectedOptionId: this.selected()!, quality } : { freeText: this.freeText().trim(), quality };
      const r = await firstValueFrom(this.api.reviewCard(c.cardId, body));
      this.result.set({ ...r, selectedOptionId: this.selected() });
      this.reviewed.update((n) => n + 1);
    } catch (e) {
      this.error.set(toApiError(e));
    } finally {
      this.busy.set(false);
    }
  }

  next(): void {
    this.result.set(null);
    this.selected.set(null);
    this.freeText.set('');
    this.index.update((i) => i + 1);
    if (this.finished()) this.schedule.load();
  }

  dayLabel(iso: string, i: number): string {
    if (i === 0) return 'Today';
    if (i === 1) return 'Tomorrow';
    return new Date(iso + 'T00:00:00').toLocaleDateString(undefined, { weekday: 'short', day: 'numeric' });
  }

  async savePrefs(): Promise<void> {
    this.savingPrefs.set(true);
    try {
      await this.auth.updatePreferences({ remindersEnabled: this.remindersEnabled(), reminderHour: this.reminderHour(), timezone: this.timezone() });
      this.notifier.success('Reminder settings saved.');
    } catch {
      /* toast shown */
    } finally {
      this.savingPrefs.set(false);
    }
  }
}
