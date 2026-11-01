import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { RouterLink } from '@angular/router';
import { LearningApi } from '../../core/api/learning.api';
import { AuthStore } from '../../core/auth/auth.store';
import { ApiError } from '../../core/http/api-error';
import { createLoader } from '../../core/platform/loader';
import { IconComponent } from '../../shared/ui/icon/icon.component';
import { EmptyStateComponent } from '../../shared/ui/states/empty-state.component';
import { ErrorStateComponent } from '../../shared/ui/states/error-state.component';
import { SkeletonComponent } from '../../shared/ui/states/skeleton.component';
import { throwError } from 'rxjs';

@Component({
  selector: 'app-course',
  imports: [RouterLink, MatButtonModule, IconComponent, SkeletonComponent, ErrorStateComponent, EmptyStateComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="page">
      @switch (course.status()) {
        @case ('loading') {
          <app-skeleton [lines]="1" [card]="false" />
          <div class="stack" style="margin-top: 20px"><app-skeleton [lines]="4" /><app-skeleton [lines]="4" /></div>
        }
        @case ('error') {
          @if (course.error()?.code === 'NOT_FOUND') {
            <app-empty-state icon="compass" title="No course selected" text="Choose a course to see its lessons.">
              <a matButton="filled" routerLink="/onboarding">Choose a course</a>
            </app-empty-state>
          } @else {
            <app-error-state [error]="course.error()" title="We couldn’t load the course" (retry)="course.load()" />
          }
        }
        @case ('ready') {
          @if (course.data(); as c) {
            <header class="page-head">
              <div>
                <p class="eyebrow">Course</p>
                <h1>{{ c.title }}</h1>
                <p class="sub">{{ c.description }}</p>
              </div>
              <div class="summary">
                <span class="num"><strong>{{ completed() }}</strong> of {{ total() }} lessons done</span>
                <div class="bar" aria-hidden="true"><div class="fill" [style.width.%]="total() ? (completed() / total()) * 100 : 0"></div></div>
              </div>
            </header>
            <div class="stack">
              @for (m of c.modules; track m.id) {
                <section class="card" [attr.aria-labelledby]="'m-' + m.id">
                  <div class="mod-head">
                    <span class="mod-n" aria-hidden="true">{{ m.position }}</span>
                    <div>
                      <h2 [id]="'m-' + m.id">Module {{ m.position }} · {{ m.title }}</h2>
                      <p class="muted small">{{ m.summary }}</p>
                    </div>
                  </div>
                  <ol class="lessons">
                    @for (l of m.lessons; track l.id) {
                      <li>
                        <a [routerLink]="['/lessons', l.id]" class="lesson">
                          <span class="state" [class]="l.status" aria-hidden="true">
                            @switch (l.status) {
                              @case ('completed') { <app-icon name="check" [size]="16" [strokeWidth]="3" /> }
                              @case ('in_progress') { <app-icon name="play" [size]="14" /> }
                              @default { {{ l.position }} }
                            }
                          </span>
                          <span class="l-body">
                            <span class="l-title">{{ l.title }}</span>
                            <span class="l-meta">{{ l.estimatedMinutes }} min · {{ statusText(l.status, l.percent) }}</span>
                          </span>
                          <app-icon name="chevron-right" [size]="18" class="chev" />
                        </a>
                      </li>
                    }
                  </ol>
                </section>
              }
            </div>
          }
        }
      }
    </div>
  `,
  styles: `
    .summary {
      min-width: 220px;
      display: flex;
      flex-direction: column;
      gap: 8px;
      color: var(--muted);
      font-size: 0.9rem;
      strong {
        color: var(--ink);
      }
      .fill {
        background: var(--mint-bar);
      }
    }
    .mod-head {
      display: flex;
      gap: 14px;
      align-items: flex-start;
      margin-bottom: 12px;
    }
    .mod-n {
      display: grid;
      place-items: center;
      flex: none;
      width: 40px;
      height: 40px;
      border-radius: 12px;
      background: var(--primary-soft);
      color: var(--primary-ink);
      font-family: var(--font-head);
      font-weight: 700;
    }
    .lessons {
      list-style: none;
      margin: 0;
      padding: 0;
    }
    .lesson {
      display: flex;
      align-items: center;
      gap: 14px;
      min-height: 56px;
      padding: 8px 10px;
      margin: 0 -10px;
      border-radius: 12px;
      color: inherit;
      text-decoration: none;
      &:hover {
        background: var(--surface-2);
      }
    }
    .state {
      display: grid;
      place-items: center;
      flex: none;
      width: 30px;
      height: 30px;
      border-radius: 50%;
      border: 2px solid var(--border-input);
      font-size: 0.8rem;
      font-weight: 700;
      color: var(--muted);
      &.completed {
        background: var(--mint);
        border-color: var(--mint);
        color: #fff;
      }
      &.in_progress {
        border-color: var(--primary);
        color: var(--primary-ink);
      }
    }
    .l-body {
      display: flex;
      flex-direction: column;
      flex: 1;
      min-width: 0;
    }
    .l-title {
      font-weight: 600;
    }
    .l-meta {
      font-size: 0.85rem;
      color: var(--muted);
    }
    .chev {
      color: var(--muted);
    }
  `,
})
export default class CourseComponent {
  private readonly api = inject(LearningApi);
  private readonly auth = inject(AuthStore);
  readonly course = createLoader(() => {
    const id = this.auth.activeCourseId();
    return id ? this.api.course(id) : throwError(() => new ApiError({ status: 404, code: 'NOT_FOUND' }));
  });
  readonly total = computed(() => this.course.data()?.modules.reduce((s, m) => s + m.lessons.length, 0) ?? 0);
  readonly completed = computed(() => this.course.data()?.modules.reduce((s, m) => s + m.lessons.filter((l) => l.status === 'completed').length, 0) ?? 0);

  statusText(status: string, percent: number): string {
    if (status === 'completed') return 'Completed';
    if (status === 'in_progress') return `In progress · ${percent}%`;
    return 'Not started';
  }
}

