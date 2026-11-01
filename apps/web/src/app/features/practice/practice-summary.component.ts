import { ChangeDetectionStrategy, Component, computed, inject, input, OnInit, signal } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { Router, RouterLink } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import { LearningApi } from '../../core/api/learning.api';
import { AuthStore } from '../../core/auth/auth.store';
import { ApiError, toApiError } from '../../core/http/api-error';
import { AttemptCompletion } from '../../core/models/api.models';
import { STUDY_ICON, StudyNavigator } from '../../shared/study/study-navigator.service';
import { IconComponent } from '../../shared/ui/icon/icon.component';
import { MasteryChangeComponent } from '../../shared/ui/mastery/mastery-change.component';
import { ErrorStateComponent } from '../../shared/ui/states/error-state.component';
import { SkeletonComponent } from '../../shared/ui/states/skeleton.component';

@Component({
  selector: 'app-practice-summary',
  imports: [RouterLink, MatButtonModule, IconComponent, MasteryChangeComponent, ErrorStateComponent, SkeletonComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="page">
      @if (error(); as e) {
        <app-error-state [error]="e" title="We couldn’t load your results" (retry)="load()" />
      } @else if (!data()) {
        <app-skeleton [lines]="6" />
      } @else if (data(); as d) {
        <section class="hero card" aria-labelledby="sum-h">
          <div class="ring" [style.--p]="ratio()" role="img" [attr.aria-label]="d.correct + ' of ' + d.total + ' correct'">
            <span class="ring-n num">{{ d.correct }}<small>/{{ d.total }}</small></span>
          </div>
          <div>
            <p class="eyebrow">Quiz complete · {{ title() }}</p>
            <h1 id="sum-h">{{ headline() }}</h1>
            <p class="muted">{{ d.correct }} of {{ d.total }} correct. Mastery changes are below — every answer counts, even the misses.</p>
          </div>
        </section>

        <div class="grid-2">
          <section class="card" aria-labelledby="mc-h">
            <h2 id="mc-h" class="card-title">Mastery changes</h2>
            <div class="stack">
              @for (m of d.masteryChanges; track m.conceptId) {
                <app-mastery-change [name]="m.name" [before]="m.before" [after]="m.after" />
              } @empty {
                <p class="muted">No mastery changes yet — answers waiting for review will update it later.</p>
              }
            </div>
          </section>
          <section class="card" aria-labelledby="sn-h">
            <h2 id="sn-h" class="card-title">Study next</h2>
            <ul class="next">
              @for (s of d.studyNext; track s.type + s.targetId) {
                <li>
                  <button type="button" class="next-item" (click)="study.open(s, courseId())">
                    <app-icon [name]="icon[s.type]" [size]="18" />
                    <span><strong>{{ s.title }}</strong><span class="muted small">{{ s.reason }}</span></span>
                    <app-icon name="chevron-right" [size]="18" />
                  </button>
                </li>
              } @empty {
                <li class="muted">You’re on track — continue your lesson.</li>
              }
            </ul>
          </section>
        </div>
        <div class="row end">
          <a matButton="text" routerLink="/home">Back to home</a>
          <a matButton="filled" routerLink="/practice">Practise more</a>
        </div>
      }
    </div>
  `,
  styles: `
    .hero {
      display: flex;
      align-items: center;
      gap: 26px;
      margin-bottom: 22px;
      flex-wrap: wrap;
      padding: 26px;
    }
    .ring {
      --p: 0;
      flex: none;
      display: grid;
      place-items: center;
      width: 120px;
      height: 120px;
      border-radius: 50%;
      background: conic-gradient(var(--mint-bar) calc(var(--p) * 1turn), var(--track) 0);
      position: relative;
      &::before {
        content: '';
        position: absolute;
        inset: 12px;
        border-radius: 50%;
        background: var(--surface);
      }
    }
    .ring-n {
      position: relative;
      font-family: var(--font-head);
      font-size: 2rem;
      font-weight: 700;
      small {
        font-size: 1rem;
        color: var(--muted);
      }
    }
    h1 {
      margin: 4px 0 6px;
    }
    .next {
      list-style: none;
      margin: 0;
      padding: 0;
    }
    .next-item {
      display: flex;
      align-items: center;
      gap: 12px;
      width: 100%;
      min-height: 56px;
      padding: 10px;
      border: 0;
      border-radius: 12px;
      background: none;
      text-align: left;
      cursor: pointer;
      > span {
        flex: 1;
        display: flex;
        flex-direction: column;
      }
      &:hover {
        background: var(--surface-2);
      }
    }
    .end {
      justify-content: flex-end;
      margin-top: 22px;
    }
  `,
})
export default class PracticeSummaryComponent implements OnInit {
  private readonly api = inject(LearningApi);
  private readonly router = inject(Router);
  private readonly auth = inject(AuthStore);
  readonly study = inject(StudyNavigator);
  readonly attemptId = input.required<string>();
  readonly icon = STUDY_ICON;

  readonly data = signal<AttemptCompletion | null>(null);
  readonly title = signal('Practice');
  readonly error = signal<ApiError | null>(null);
  readonly courseId = computed(() => this.auth.activeCourseId() ?? '');
  readonly ratio = computed(() => {
    const d = this.data();
    return d && d.total ? d.correct / d.total : 0;
  });
  readonly headline = computed(() => {
    const r = this.ratio();
    if (r >= 0.85) return 'Excellent work!';
    if (r >= 0.6) return 'Good progress';
    if (r > 0) return 'Every miss is a lesson';
    return 'Thanks for trying';
  });

  ngOnInit(): void {
    const state = (this.router.lastSuccessfulNavigation()?.extras.state ?? history.state) as { completion?: AttemptCompletion; title?: string } | null;
    if (state?.completion?.attemptId === this.attemptId()) {
      this.data.set(state.completion);
      if (state.title) this.title.set(state.title);
    } else void this.load();
  }

  async load(): Promise<void> {
    this.error.set(null);
    try {
      const a = await firstValueFrom(this.api.attempt(this.attemptId()));
      this.title.set(a.conceptName ?? a.title);
      this.data.set(await firstValueFrom(this.api.complete(this.attemptId())));
    } catch (e) {
      this.error.set(toApiError(e));
    }
  }
}
