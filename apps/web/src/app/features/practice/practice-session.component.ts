import { ChangeDetectionStrategy, Component, computed, DestroyRef, effect, ElementRef, inject, input, signal, untracked, viewChild } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { Router, RouterLink } from '@angular/router';
import { firstValueFrom, Subscription, takeWhile, timer, switchMap } from 'rxjs';
import { LearningApi } from '../../core/api/learning.api';
import { ApiError, toApiError } from '../../core/http/api-error';
import { newIdempotencyKey } from '../../core/http/trace';
import { AnswerResult, Attempt } from '../../core/models/api.models';
import { createLoader } from '../../core/platform/loader';
import { QuestionAnswer, QuestionCardComponent } from '../../shared/quiz/question-card.component';
import { IconComponent } from '../../shared/ui/icon/icon.component';
import { MasteryChangeComponent } from '../../shared/ui/mastery/mastery-change.component';
import { ErrorStateComponent } from '../../shared/ui/states/error-state.component';
import { SkeletonComponent } from '../../shared/ui/states/skeleton.component';

const POLL_MS = 2000;
const POLL_GIVE_UP_MS = 60_000;

@Component({
  selector: 'app-practice-session',
  imports: [RouterLink, MatButtonModule, IconComponent, QuestionCardComponent, MasteryChangeComponent, ErrorStateComponent, SkeletonComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './practice-session.component.html',
  styleUrl: './practice-session.component.scss',
})
export default class PracticeSessionComponent {
  private readonly api = inject(LearningApi);
  private readonly router = inject(Router);
  readonly attemptId = input.required<string>();

  readonly attempt = createLoader(() => this.api.attempt(this.attemptId()), { immediate: false });
  readonly index = signal(0);
  readonly result = signal<AnswerResult | null>(null);
  readonly submitting = signal(false);
  readonly finishing = signal(false);
  readonly answerError = signal<ApiError | null>(null);
  readonly gradingSlow = signal(false);
  readonly announce = signal('');

  private pollSub: Subscription | null = null;
  private idemKey = newIdempotencyKey();
  private readonly nextBtn = viewChild<ElementRef<HTMLButtonElement>>('nextBtn');

  readonly total = computed(() => this.attempt.data()?.questions.length ?? 0);
  readonly question = computed(() => this.attempt.data()?.questions[this.index()] ?? null);
  readonly isLast = computed(() => this.index() + 1 >= this.total());
  readonly progress = computed(() => (this.total() ? ((this.index() + (this.result() ? 1 : 0)) / this.total()) * 100 : 0));
  readonly heading = computed(() => {
    const a = this.attempt.data();
    return a ? (a.conceptName ?? a.title) : 'Practice';
  });
  readonly correctLabel = computed(() => {
    const r = this.result();
    const q = this.question();
    if (!r?.correctOptionId || !q) return '';
    return q.options.find((o) => o.id === r.correctOptionId)?.label ?? '';
  });
  readonly pending = computed(() => this.result()?.grading?.status === 'pending');
  readonly tutorQuery = computed(() => {
    const q = this.question();
    if (!q) return {};
    return { q: `Can you explain this question? “${q.stem}”` };
  });

  constructor() {
    effect(() => {
      this.attemptId();
      untracked(() => {
        this.stopPolling();
        this.result.set(null);
        this.attempt.load();
      });
    });
    effect(() => {
      const a = this.attempt.data();
      if (!a) return;
      untracked(() => this.resume(a));
    });
    inject(DestroyRef).onDestroy(() => this.stopPolling());
  }

  private resume(a: Attempt): void {
    const answered = new Map(a.answers.map((x) => [x.questionId, x]));
    const firstOpen = a.questions.findIndex((q) => !answered.has(q.id));
    if (firstOpen === -1) {
      this.index.set(Math.max(0, a.questions.length - 1));
      const last = a.questions[a.questions.length - 1];
      this.result.set(last ? (answered.get(last.id) ?? null) : null);
    } else {
      this.index.set(firstOpen);
      this.result.set(null);
    }
    const r = this.result();
    if (r?.grading?.status === 'pending') this.poll(r);
  }

  async answer(ans: QuestionAnswer): Promise<void> {
    const q = this.question();
    if (!q) return;
    this.submitting.set(true);
    this.answerError.set(null);
    try {
      const r = await firstValueFrom(this.api.answer(this.attemptId(), { questionId: q.id, ...ans }, this.idemKey));
      this.result.set(r);
      if (r.grading?.status === 'pending') {
        this.announce.set('Answer submitted. Grading…');
        this.poll(r);
      } else {
        this.announce.set(r.isCorrect ? 'Correct.' : `Not quite. The correct answer is ${this.correctLabel()}.`);
        this.focusNext();
      }
    } catch (e) {
      this.answerError.set(toApiError(e));
    } finally {
      this.submitting.set(false);
    }
  }

  private poll(r: AnswerResult): void {
    this.stopPolling();
    this.gradingSlow.set(false);
    const started = Date.now();
    this.pollSub = timer(POLL_MS, POLL_MS)
      .pipe(
        switchMap(() => this.api.answerResult(this.attemptId(), r.answerId)),
        takeWhile((x) => x.grading?.status === 'pending' && Date.now() - started < POLL_GIVE_UP_MS, true),
      )
      .subscribe({
        next: (x) => {
          this.result.set(x);
          if (x.grading?.status !== 'pending') {
            this.announce.set(x.grading?.status === 'needs_review' ? 'Your answer will be reviewed by your teacher.' : 'Your answer has been graded.');
            this.focusNext();
          } else if (Date.now() - started >= POLL_GIVE_UP_MS) this.gradingSlow.set(true);
        },
        error: () => this.gradingSlow.set(true),
      });
  }

  private stopPolling(): void {
    this.pollSub?.unsubscribe();
    this.pollSub = null;
  }

  private focusNext(): void {
    setTimeout(() => this.nextBtn()?.nativeElement.focus());
  }

  async next(): Promise<void> {
    this.stopPolling();
    this.gradingSlow.set(false);
    if (this.isLast()) {
      await this.finish();
      return;
    }
    this.idemKey = newIdempotencyKey();
    this.result.set(null);
    this.index.update((i) => i + 1);
    window.scrollTo({ top: 0 });
  }

  async finish(): Promise<void> {
    this.finishing.set(true);
    try {
      const completion = await firstValueFrom(this.api.complete(this.attemptId()));
      await this.router.navigate(['/practice', this.attemptId(), 'summary'], { state: { completion, title: this.heading() } });
    } catch {
      /* toast shown */
    } finally {
      this.finishing.set(false);
    }
  }

  pct(v: number): number {
    return Math.round(v * 100);
  }
}
