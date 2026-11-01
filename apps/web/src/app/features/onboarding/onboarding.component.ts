import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { Router, RouterLink } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import { LearningApi } from '../../core/api/learning.api';
import { AuthStore } from '../../core/auth/auth.store';
import { ApiError, toApiError } from '../../core/http/api-error';
import { AnswerResult, Attempt, AttemptCompletion, CourseSummary, Level } from '../../core/models/api.models';
import { createLoader } from '../../core/platform/loader';
import { QuestionAnswer, QuestionCardComponent } from '../../shared/quiz/question-card.component';
import { IconComponent } from '../../shared/ui/icon/icon.component';
import { IconName } from '../../shared/ui/icon/icons';
import { LogoComponent } from '../../shared/ui/logo/logo.component';
import { MasteryBarComponent } from '../../shared/ui/mastery/mastery-bar.component';
import { ErrorStateComponent } from '../../shared/ui/states/error-state.component';
import { SkeletonComponent } from '../../shared/ui/states/skeleton.component';
import { OfflineBannerComponent } from '../../layout/offline-banner.component';

type Step = 'course' | 'level' | 'intro' | 'quiz' | 'results';

const LEVELS: { id: Level; title: string; text: string; icon: IconName }[] = [
  { id: 'beginner', title: 'Beginner', text: 'New to this. Explain from first principles with everyday examples.', icon: 'lightbulb' },
  { id: 'intermediate', title: 'Intermediate', text: 'I know the basics. Connect the ideas and show me the key formulas.', icon: 'layers' },
  { id: 'advanced', title: 'Advanced', text: 'Give me the maths, the derivations and the edge cases.', icon: 'zap' },
];

@Component({
  selector: 'app-onboarding',
  imports: [RouterLink, MatButtonModule, IconComponent, LogoComponent, QuestionCardComponent, MasteryBarComponent, ErrorStateComponent, SkeletonComponent, OfflineBannerComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './onboarding.component.html',
  styleUrl: './onboarding.component.scss',
})
export default class OnboardingComponent {
  private readonly api = inject(LearningApi);
  private readonly router = inject(Router);
  readonly auth = inject(AuthStore);

  readonly levels = LEVELS;
  readonly step = signal<Step>('course');
  readonly stepIndex = computed(() => ({ course: 1, level: 2, intro: 3, quiz: 3, results: 3 })[this.step()]);
  readonly courses = createLoader(() => this.api.courses());
  readonly courseId = signal<string | null>(this.auth.activeCourseId());
  readonly level = signal<Level>(this.auth.me()?.preferences.level ?? 'beginner');
  readonly busy = signal(false);
  readonly error = signal<ApiError | null>(null);

  readonly attempt = signal<Attempt | null>(null);
  readonly index = signal(0);
  readonly result = signal<AnswerResult | null>(null);
  readonly completion = signal<AttemptCompletion | null>(null);

  readonly question = computed(() => this.attempt()?.questions[this.index()] ?? null);
  readonly total = computed(() => this.attempt()?.questions.length ?? 0);
  readonly selectedCourse = computed(() => this.courses.data()?.find((c) => c.id === this.courseId()) ?? null);

  chooseCourse(c: CourseSummary): void {
    this.courseId.set(c.id);
  }

  async continueFromCourse(): Promise<void> {
    const id = this.courseId();
    if (!id) return;
    await this.run(async () => {
      await firstValueFrom(this.api.enroll(id));
      this.step.set('level');
    });
  }

  async continueFromLevel(): Promise<void> {
    await this.run(async () => {
      await this.auth.updatePreferences({ level: this.level(), activeCourseId: this.courseId() });
      this.step.set('intro');
    });
  }

  async startDiagnostic(): Promise<void> {
    await this.run(async () => {
      const a = await firstValueFrom(this.api.startDiagnostic(this.courseId()!));
      this.attempt.set(a);
      this.index.set(a.answers.length);
      this.result.set(null);
      if (a.questions.length === 0) await this.finish();
      else this.step.set('quiz');
    });
  }

  async skipDiagnostic(): Promise<void> {
    await this.run(async () => {
      const a = this.attempt() ?? (await firstValueFrom(this.api.startDiagnostic(this.courseId()!)));
      this.attempt.set(a);
      await this.finish();
    });
  }

  async answer(ans: QuestionAnswer): Promise<void> {
    const a = this.attempt();
    const q = this.question();
    if (!a || !q) return;
    await this.run(async () => {
      const r = await firstValueFrom(this.api.answer(a.attemptId, { questionId: q.id, ...ans }));
      this.result.set(r);
    });
  }

  async next(): Promise<void> {
    this.result.set(null);
    if (this.index() + 1 >= this.total()) await this.run(() => this.finish());
    else this.index.update((i) => i + 1);
  }

  private async finish(): Promise<void> {
    const c = await firstValueFrom(this.api.complete(this.attempt()!.attemptId));
    this.completion.set(c);
    await this.auth.refresh();
    this.step.set('results');
  }

  async goHome(): Promise<void> {
    await this.router.navigate(['/home']);
  }

  back(): void {
    this.error.set(null);
    if (this.step() === 'level') this.step.set('course');
    else if (this.step() === 'intro') this.step.set('level');
  }

  async signOut(): Promise<void> {
    await this.auth.logout();
    await this.router.navigate(['/auth/sign-in']);
  }

  private async run(fn: () => Promise<void>): Promise<void> {
    this.busy.set(true);
    this.error.set(null);
    try {
      await fn();
    } catch (e) {
      this.error.set(toApiError(e));
    } finally {
      this.busy.set(false);
    }
  }
}
