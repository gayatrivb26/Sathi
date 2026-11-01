import { ChangeDetectionStrategy, Component, computed, DestroyRef, effect, ElementRef, inject, input, signal, untracked, viewChild } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { Router, RouterLink } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import { LearningApi } from '../../core/api/learning.api';
import { createLoader } from '../../core/platform/loader';
import { IconComponent } from '../../shared/ui/icon/icon.component';
import { MarkdownViewComponent } from '../../shared/ui/markdown/markdown-view.component';
import { ErrorStateComponent } from '../../shared/ui/states/error-state.component';
import { SkeletonComponent } from '../../shared/ui/states/skeleton.component';

@Component({
  selector: 'app-lesson',
  imports: [RouterLink, MatButtonModule, IconComponent, MarkdownViewComponent, ErrorStateComponent, SkeletonComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './lesson.component.html',
  styleUrl: './lesson.component.scss',
  host: { '(window:scroll)': 'onScroll()', '(window:resize)': 'onScroll()' },
})
export default class LessonComponent {
  private readonly api = inject(LearningApi);
  private readonly router = inject(Router);
  readonly lessonId = input.required<string>();

  readonly lesson = createLoader(() => this.api.lesson(this.lessonId()), { immediate: false });
  readonly readPercent = signal(0);
  readonly completed = signal(false);
  readonly starting = signal(false);
  private readonly article = viewChild<ElementRef<HTMLElement>>('article');

  private lastSent = 0;
  private sendTimer: ReturnType<typeof setTimeout> | null = null;

  readonly minutesLeft = computed(() => {
    const l = this.lesson.data();
    if (!l) return 0;
    return Math.max(1, Math.round(l.estimatedMinutes * (1 - this.readPercent() / 100)));
  });

  constructor() {
    // Reload when navigating between lessons (the component is reused for /lessons/:id).
    effect(() => {
      this.lessonId();
      untracked(() => {
        this.flush();
        this.lastSent = 0;
        this.readPercent.set(0);
        this.completed.set(false);
        this.lesson.load();
      });
    });
    effect(() => {
      const l = this.lesson.data();
      if (!l) return;
      untracked(() => {
        this.lastSent = l.progress.percent;
        this.readPercent.set(l.progress.percent);
        this.completed.set(l.progress.status === 'completed');
      });
      setTimeout(() => this.onScroll(), 50);
    });
    inject(DestroyRef).onDestroy(() => this.flush());
  }

  onScroll(): void {
    const el = this.article()?.nativeElement;
    if (!el || !this.lesson.data()) return;
    const rect = el.getBoundingClientRect();
    const seen = window.innerHeight - rect.top;
    const pct = Math.round(Math.max(0, Math.min(1, seen / rect.height)) * 100);
    if (pct > this.readPercent()) this.readPercent.set(pct);
    if (this.readPercent() >= 95 && !this.completed()) this.markComplete();
    else if (this.readPercent() - this.lastSent >= 10) this.schedule();
  }

  private schedule(): void {
    if (this.sendTimer) return;
    this.sendTimer = setTimeout(() => this.flush(), 1200);
  }

  private flush(): void {
    if (this.sendTimer) clearTimeout(this.sendTimer);
    this.sendTimer = null;
    const l = this.lesson.data();
    if (!l || this.completed() || this.readPercent() <= this.lastSent) return;
    this.lastSent = this.readPercent();
    this.api.lessonProgress(l.id, this.lastSent, false).subscribe({ error: () => undefined });
  }

  markComplete(): void {
    const l = this.lesson.data();
    if (!l || this.completed()) return;
    this.completed.set(true);
    this.readPercent.set(100);
    this.lastSent = 100;
    this.api.lessonProgress(l.id, 100, true).subscribe({ error: () => this.completed.set(false) });
  }

  async checkUnderstanding(): Promise<void> {
    const l = this.lesson.data();
    if (!l) return;
    this.starting.set(true);
    try {
      const a = await firstValueFrom(this.api.startPractice({ courseId: l.course.id, lessonId: l.id, count: 5 }));
      await this.router.navigate(['/practice', a.attemptId]);
    } catch {
      /* toast already shown */
    } finally {
      this.starting.set(false);
    }
  }
}
