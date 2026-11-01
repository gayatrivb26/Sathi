import { ChangeDetectionStrategy, Component, computed, effect, inject, signal, untracked } from '@angular/core';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatSelectModule } from '@angular/material/select';
import { MatButtonModule } from '@angular/material/button';
import { RouterLink } from '@angular/router';
import { of } from 'rxjs';
import { InstructorApi } from '../../core/api/staff.api';
import { ClassInsights } from '../../core/models/api.models';
import { createLoader } from '../../core/platform/loader';
import { IconComponent } from '../../shared/ui/icon/icon.component';
import { IconName } from '../../shared/ui/icon/icons';
import { MasteryBarComponent } from '../../shared/ui/mastery/mastery-bar.component';
import { ErrorStateComponent } from '../../shared/ui/states/error-state.component';
import { SkeletonComponent } from '../../shared/ui/states/skeleton.component';
import { TeachContext } from './teach-context.service';

@Component({
  selector: 'app-insights',
  imports: [RouterLink, MatButtonModule, MatFormFieldModule, MatSelectModule, IconComponent, MasteryBarComponent, SkeletonComponent, ErrorStateComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (ctx.activeClasses().length) {
      <div class="class-filter">
        <mat-form-field subscriptSizing="dynamic">
          <mat-label>Show</mat-label>
          <mat-select [value]="classId()" (valueChange)="classId.set($event)">
            <mat-option value="">All students in this course</mat-option>
            @for (k of ctx.activeClasses(); track k.id) { <mat-option [value]="k.id">{{ k.name }} ({{ k.memberCount }})</mat-option> }
          </mat-select>
        </mat-form-field>
      </div>
    }
    @switch (data.status()) {
      @case ('loading') { <div class="kpis">@for (i of [1, 2, 3, 4]; track i) { <app-skeleton [lines]="1" /> }</div> }
      @case ('error') { <app-error-state [error]="data.error()" title="We couldn’t load class insights" (retry)="data.load()" /> }
      @default {
        @if (data.data(); as d) {
          <ul class="kpis" role="list">
            @for (k of kpis(); track k.label) {
              <li class="card kpi">
                <span class="k-icon" aria-hidden="true"><app-icon [name]="k.icon" [size]="20" /></span>
                <span class="k-val num">{{ k.value }}</span>
                <span class="k-lbl">{{ k.label }}</span>
              </li>
            }
          </ul>
          <div class="grid">
            <section class="card" aria-labelledby="weak-h">
              <div class="card-title">
                <h2 id="weak-h">Concept mastery across the class</h2>
                <span class="muted small">Weakest first</span>
              </div>
              <ul class="concepts">
                @for (c of d.conceptMastery; track c.conceptId) {
                  <li>
                    <app-mastery-bar [name]="c.name" [mastery]="c.averageMastery" />
                    <p class="below small" [class.warn]="c.studentsBelowHalf / (d.enrolled || 1) > 0.4">{{ c.studentsBelowHalf }} of {{ d.enrolled }} students below 50%</p>
                  </li>
                }
              </ul>
            </section>
            <section class="card actions" aria-labelledby="act-h">
              <h2 id="act-h" class="card-title">Suggested actions</h2>
              @if (weakest(); as w) {
                <div class="act">
                  <app-icon name="target" [size]="20" />
                  <p><strong>{{ w.name }}</strong> is the weakest topic ({{ pct(w.averageMastery) }}% average). Consider adding worked examples or more practice questions.</p>
                </div>
              }
              @if (d.pendingReviews > 0) {
                <div class="act">
                  <app-icon name="check-circle" [size]="20" />
                  <p><strong>{{ d.pendingReviews }}</strong> answer{{ d.pendingReviews === 1 ? '' : 's' }} waiting for your review.</p>
                </div>
                <a matButton="filled" routerLink="../grading">Review answers</a>
              }
              <a matButton="outlined" routerLink="../questions">Open question bank</a>
            </section>
          </div>
        }
      }
    }
  `,
  styles: `
    .class-filter {
      display: flex;
      justify-content: flex-end;
      margin: -8px 0 16px;
      mat-form-field {
        width: 300px;
        max-width: 100%;
      }
    }
    .kpis {
      list-style: none;
      margin: 0 0 22px;
      padding: 0;
      display: grid;
      grid-template-columns: repeat(4, minmax(0, 1fr));
      gap: 16px;
      @media (max-width: 899.98px) {
        grid-template-columns: repeat(2, minmax(0, 1fr));
      }
    }
    .kpi {
      display: flex;
      flex-direction: column;
      gap: 4px;
    }
    .k-icon {
      display: grid;
      place-items: center;
      width: 38px;
      height: 38px;
      border-radius: 12px;
      background: var(--primary-soft);
      color: var(--primary-ink);
      margin-bottom: 6px;
    }
    .k-val {
      font-family: var(--font-head);
      font-size: 1.7rem;
      font-weight: 700;
    }
    .k-lbl {
      color: var(--muted);
      font-size: 0.875rem;
    }
    .grid {
      display: grid;
      grid-template-columns: minmax(0, 1.5fr) minmax(0, 1fr);
      gap: 22px;
      align-items: start;
      @media (max-width: 899.98px) {
        grid-template-columns: 1fr;
      }
    }
    .concepts {
      list-style: none;
      margin: 0;
      padding: 0;
      display: flex;
      flex-direction: column;
      gap: 16px;
    }
    .below {
      margin-top: 4px;
      color: var(--muted);
      &.warn {
        color: var(--amber-ink);
        font-weight: 600;
      }
    }
    .actions {
      display: flex;
      flex-direction: column;
      gap: 12px;
      align-items: flex-start;
    }
    .act {
      display: flex;
      gap: 10px;
      app-icon {
        color: var(--primary-ink);
        margin-top: 2px;
      }
    }
  `,
})
export default class InsightsComponent {
  private readonly api = inject(InstructorApi);
  readonly ctx = inject(TeachContext);
  /** '' = the whole course (§11.1: insights accept an optional classId). */
  readonly classId = signal('');
  readonly data = createLoader<ClassInsights | null>(() => {
    const id = this.ctx.courseId();
    return id ? this.api.insights(id, this.classId() || null) : of(null);
  }, { immediate: false });

  constructor() {
    effect(() => {
      this.ctx.courseId();
      untracked(() => this.classId.set(''));
    });
    effect(() => {
      this.ctx.courseId();
      this.classId();
      untracked(() => this.data.load());
    });
  }

  readonly weakest = computed(() => this.data.data()?.conceptMastery[0] ?? null);
  readonly kpis = computed<{ label: string; value: string; icon: IconName }[]>(() => {
    const d = this.data.data();
    if (!d) return [];
    return [
      { label: 'Students enrolled', value: String(d.enrolled), icon: 'user' },
      { label: 'Active in the last 7 days', value: String(d.activeLast7Days), icon: 'activity' },
      { label: 'Questions asked (7 days)', value: String(d.questionsAsked7Days), icon: 'tutor' },
      { label: 'Answers rated helpful', value: d.helpfulRate === null ? '—' : `${this.pct(d.helpfulRate)}%`, icon: 'thumbs-up' },
    ];
  });

  pct(v: number): number {
    return Math.round(v * 100);
  }
}
