import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { Router, RouterLink } from '@angular/router';
import { firstValueFrom, forkJoin, throwError } from 'rxjs';
import { LearningApi } from '../../core/api/learning.api';
import { AuthStore } from '../../core/auth/auth.store';
import { ApiError } from '../../core/http/api-error';
import { PracticeSessionRequest } from '../../core/models/api.models';
import { createLoader } from '../../core/platform/loader';
import { IconComponent } from '../../shared/ui/icon/icon.component';
import { MasteryBarComponent } from '../../shared/ui/mastery/mastery-bar.component';
import { isPractised, practiceRecommendation } from '../../shared/ui/mastery/mastery-labels';
import { EmptyStateComponent } from '../../shared/ui/states/empty-state.component';
import { ErrorStateComponent } from '../../shared/ui/states/error-state.component';
import { SkeletonComponent } from '../../shared/ui/states/skeleton.component';

@Component({
  selector: 'app-practice-picker',
  imports: [RouterLink, MatButtonModule, IconComponent, MasteryBarComponent, SkeletonComponent, ErrorStateComponent, EmptyStateComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="page">
      <header class="page-head">
        <div>
          <h1>Practice</h1>
          <p class="sub">Short quizzes with instant feedback. Your mastery updates after every answer.</p>
        </div>
      </header>

      @switch (data.status()) {
        @case ('loading') {
          <app-skeleton [lines]="2" />
          <div class="grid" style="margin-top: 18px">
            @for (i of [1, 2, 3, 4, 5, 6]; track i) { <app-skeleton [lines]="2" /> }
          </div>
        }
        @case ('error') {
          @if (data.error()?.code === 'NOT_FOUND') {
            <app-empty-state icon="compass" title="Choose a course first" text="Practice questions come from your course.">
              <a matButton="filled" routerLink="/onboarding">Choose a course</a>
            </app-empty-state>
          } @else {
            <app-error-state [error]="data.error()" title="We couldn’t load practice" (retry)="data.load()" />
          }
        }
        @case ('ready') {
          <section class="reco" aria-labelledby="reco-h">
            <span class="reco-icon" aria-hidden="true"><app-icon name="sparkles" [size]="26" /></span>
            <div class="reco-body">
              <p class="eyebrow on-dark">Recommended for you</p>
              <h2 id="reco-h">{{ recommendation().title }}</h2>
              <p>{{ recommendation().text }}</p>
            </div>
            <button matButton="filled" class="btn-amber" type="button" (click)="start({})" [disabled]="busy() !== null">
              {{ busy() === 'mixed' ? 'Preparing…' : 'Start practice' }}
            </button>
          </section>

          <h2 class="section-h">Practise a topic</h2>
          <ul class="grid" role="list">
            @for (c of concepts(); track c.id) {
              <li class="card concept">
                <h3>{{ c.name }}</h3>
                <p class="muted small desc">{{ c.description }}</p>
                @if (c.mastery; as m) {
                  <app-mastery-bar [name]="'Mastery'" [mastery]="m.mastery" [needsWork]="m.needsWork" [attempts]="m.attempts" />
                } @else {
                  <p class="small new"><app-icon name="star" [size]="14" /> Not practised yet</p>
                }
                <button matButton="outlined" type="button" (click)="start({ conceptId: c.id }, c.id)" [disabled]="busy() !== null" [attr.aria-label]="'Practise ' + c.name">
                  {{ busy() === c.id ? 'Preparing…' : 'Practise' }}
                </button>
              </li>
            } @empty {
              <app-empty-state icon="target" title="No topics yet" text="Your instructor hasn’t added practice questions to this course yet." />
            }
          </ul>
        }
      }
    </div>
  `,
  styles: `
    .reco {
      display: flex;
      align-items: center;
      gap: 18px;
      padding: 22px 24px;
      border-radius: var(--radius);
      background: linear-gradient(135deg, #12192b, #262f52);
      color: #e9ecf6;
      box-shadow: var(--shadow-card);
      flex-wrap: wrap;
      h2 {
        color: #fff;
        font-size: 1.25rem;
        margin: 2px 0 4px;
      }
      p {
        color: #c9cfe0;
      }
    }
    .on-dark {
      color: #ffc56b;
    }
    .reco-icon {
      display: grid;
      place-items: center;
      width: 52px;
      height: 52px;
      border-radius: 16px;
      background: rgba(255, 181, 71, 0.16);
      color: #ffb547;
    }
    .reco-body {
      flex: 1;
      min-width: 220px;
    }
    .section-h {
      margin: 30px 0 14px;
    }
    .grid {
      list-style: none;
      margin: 0;
      padding: 0;
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(250px, 1fr));
      gap: 16px;
    }
    .concept {
      display: flex;
      flex-direction: column;
      gap: 12px;
      h3 {
        font-size: 1.05rem;
      }
      button {
        margin-top: auto;
        align-self: flex-start;
      }
    }
    .desc {
      min-height: 2.6em;
    }
    .new {
      display: flex;
      align-items: center;
      gap: 6px;
      color: var(--primary-ink);
      font-weight: 600;
    }
  `,
})
export default class PracticePickerComponent {
  private readonly api = inject(LearningApi);
  private readonly auth = inject(AuthStore);
  private readonly router = inject(Router);
  readonly busy = signal<string | null>(null);

  readonly data = createLoader(() => {
    const id = this.auth.activeCourseId();
    if (!id) return throwError(() => new ApiError({ status: 404, code: 'NOT_FOUND' }));
    return forkJoin({ course: this.api.course(id), progress: this.api.progress(id) });
  });

  /** Practised topics that need work first (weakest first), then untried topics, then the rest. */
  readonly concepts = computed(() => {
    const d = this.data.data();
    if (!d) return [];
    const m = new Map(d.progress.mastery.filter(isPractised).map((x) => [x.conceptId, x]));
    const rank = (x: { mastery: { mastery: number; needsWork: boolean } | null }) => (x.mastery === null ? 1 : x.mastery.needsWork ? 0 : 2);
    return d.course.concepts
      .map((c) => ({ ...c, mastery: m.get(c.id) ?? null }))
      .sort((a, b) => rank(a) - rank(b) || (a.mastery?.mastery ?? 0) - (b.mastery?.mastery ?? 0));
  });
  readonly recommendation = computed(() => {
    const d = this.data.data();
    return practiceRecommendation(d?.progress.mastery ?? [], d?.course.concepts ?? []);
  });

  async start(opts: Omit<PracticeSessionRequest, 'courseId'>, key = 'mixed'): Promise<void> {
    const courseId = this.auth.activeCourseId();
    if (!courseId) return;
    this.busy.set(key);
    try {
      const a = await firstValueFrom(this.api.startPractice({ courseId, ...opts, count: 8 }));
      await this.router.navigate(['/practice', a.attemptId]);
    } catch {
      /* toast shown by the interceptor */
    } finally {
      this.busy.set(null);
    }
  }
}
