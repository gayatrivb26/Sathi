import { DatePipe } from '@angular/common';
import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { RouterLink } from '@angular/router';
import { LearningApi } from '../../core/api/learning.api';
import { AuthStore } from '../../core/auth/auth.store';
import { createLoader } from '../../core/platform/loader';
import { ChartPoint, LineChartComponent } from '../../shared/ui/chart/line-chart.component';
import { IconComponent } from '../../shared/ui/icon/icon.component';
import { IconName } from '../../shared/ui/icon/icons';
import { MasteryBarComponent } from '../../shared/ui/mastery/mastery-bar.component';
import { isPractised } from '../../shared/ui/mastery/mastery-labels';
import { EmptyStateComponent } from '../../shared/ui/states/empty-state.component';
import { ErrorStateComponent } from '../../shared/ui/states/error-state.component';
import { SkeletonComponent } from '../../shared/ui/states/skeleton.component';

@Component({
  selector: 'app-progress',
  imports: [DatePipe, RouterLink, MatButtonModule, IconComponent, MasteryBarComponent, LineChartComponent, SkeletonComponent, ErrorStateComponent, EmptyStateComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="page">
      <header class="page-head">
        <div>
          <h1>Your progress</h1>
          <p class="sub">How your understanding is growing, topic by topic.</p>
        </div>
      </header>
      @switch (p.status()) {
        @case ('loading') {
          <div class="stats">@for (i of [1, 2, 3, 4]; track i) { <app-skeleton [lines]="1" /> }</div>
          <div class="grid-2" style="margin-top: 22px"><app-skeleton [lines]="6" /><app-skeleton [lines]="6" /></div>
        }
        @case ('error') { <app-error-state [error]="p.error()" title="We couldn’t load your progress" (retry)="p.load()" /> }
        @case ('ready') {
          @if (p.data(); as d) {
            <ul class="stats" role="list">
              @for (s of stats(); track s.label) {
                <li class="card stat">
                  <span class="s-icon" [class]="s.tone" aria-hidden="true"><app-icon [name]="s.icon" [size]="20" /></span>
                  <span class="s-val num">{{ s.value }}</span>
                  <span class="s-lbl">{{ s.label }}</span>
                </li>
              }
            </ul>

            <div class="grid-2">
              <section class="card" aria-labelledby="trend-h">
                <div class="card-title">
                  <h2 id="trend-h">Mastery over time</h2>
                  @if (trendDelta() !== null) {
                    <span class="pill" [class.mint]="trendDelta()! >= 0" [class.amber]="trendDelta()! < 0">{{ trendDelta()! >= 0 ? '+' : '' }}{{ trendDelta() }} pts</span>
                  }
                </div>
                @if (trend().length > 1) {
                  <app-line-chart [points]="trend()" caption="Average mastery across practised topics" />
                } @else {
                  <app-empty-state [plain]="true" icon="chart" title="Not enough data yet" text="Practise on a couple of different days to see your trend." />
                }
              </section>

              <section class="card" aria-labelledby="mastery-h">
                <h2 id="mastery-h" class="card-title">Mastery by topic</h2>
                @if (practised().length) {
                  <div class="stack">
                    @for (m of practised(); track m.conceptId) {
                      <app-mastery-bar [name]="m.name" [mastery]="m.mastery" [needsWork]="m.needsWork" [attempts]="m.attempts" />
                    }
                  </div>
                  @if (untried().length) {
                    <h3 class="untried-h">Not practised yet</h3>
                    <ul class="untried" role="list">
                      @for (m of untried(); track m.conceptId) { <li class="pill neutral">{{ m.name }}</li> }
                    </ul>
                  }
                } @else {
                  <app-empty-state [plain]="true" icon="target" title="No topics practised yet" text="Your mastery per topic appears after your first quiz.">
                    <a matButton="outlined" routerLink="/practice">Start practising</a>
                  </app-empty-state>
                }
              </section>
            </div>

            <section class="card quizzes" aria-labelledby="quiz-h">
              <h2 id="quiz-h" class="card-title">Quiz history</h2>
              @if (d.quizzes.length) {
                <div class="table-wrap">
                  <table>
                    <thead><tr><th scope="col">Quiz</th><th scope="col">Completed</th><th scope="col">Score</th></tr></thead>
                    <tbody>
                      @for (q of d.quizzes; track q.attemptId) {
                        <tr>
                          <td>{{ q.title }}</td>
                          <td>{{ q.completedAt | date: 'EEE d MMM' }}</td>
                          <td>
                            <span class="score">
                              <span class="num"><strong>{{ q.correct }}</strong> / {{ q.total }}</span>
                              <span class="bar thin" aria-hidden="true"><span class="fill" [style.width.%]="q.total ? (q.correct / q.total) * 100 : 0"></span></span>
                            </span>
                          </td>
                        </tr>
                      }
                    </tbody>
                  </table>
                </div>
              } @else {
                <p class="muted">No quizzes yet.</p>
              }
            </section>
          }
        }
      }
    </div>
  `,
  styles: `
    .stats {
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
    .stat {
      display: flex;
      flex-direction: column;
      gap: 4px;
    }
    .s-icon {
      display: grid;
      place-items: center;
      width: 38px;
      height: 38px;
      border-radius: 12px;
      margin-bottom: 6px;
      background: var(--primary-soft);
      color: var(--primary-ink);
      &.amber {
        background: var(--amber-soft);
        color: var(--amber-ink);
      }
      &.mint {
        background: var(--mint-soft);
        color: var(--mint-ink);
      }
    }
    .s-val {
      font-family: var(--font-head);
      font-size: 1.7rem;
      font-weight: 700;
      line-height: 1.1;
    }
    .s-lbl {
      color: var(--muted);
      font-size: 0.875rem;
    }
    .quizzes {
      margin-top: 22px;
    }
    .untried-h {
      font-size: 0.95rem;
      margin: 20px 0 8px;
    }
    .untried {
      list-style: none;
      margin: 0;
      padding: 0;
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
    }
    .table-wrap {
      overflow-x: auto;
    }
    table {
      width: 100%;
      border-collapse: collapse;
    }
    th {
      text-align: left;
      font-size: 0.8rem;
      color: var(--muted);
      font-weight: 600;
      padding: 8px 10px;
      border-bottom: 1px solid var(--border);
    }
    td {
      padding: 12px 10px;
      border-bottom: 1px solid var(--border);
    }
    tr:last-child td {
      border-bottom: 0;
    }
    .score {
      display: flex;
      align-items: center;
      gap: 10px;
      .bar {
        width: 90px;
        display: block;
      }
      .fill {
        display: block;
        background: var(--mint-bar);
      }
    }
  `,
})
export default class ProgressComponent {
  private readonly api = inject(LearningApi);
  private readonly auth = inject(AuthStore);
  readonly p = createLoader(() => this.api.progress(this.auth.activeCourseId()));
  readonly practised = computed(() => (this.p.data()?.mastery ?? []).filter(isPractised));
  readonly untried = computed(() => (this.p.data()?.mastery ?? []).filter((m) => !isPractised(m)));

  readonly trend = computed<ChartPoint[]>(() =>
    (this.p.data()?.masteryTrend ?? []).map((t) => ({
      label: new Date(t.date + (t.date.length === 10 ? 'T00:00:00' : '')).toLocaleDateString(undefined, { day: 'numeric', month: 'short' }),
      value: t.average,
    })),
  );
  readonly trendDelta = computed(() => {
    const t = this.p.data()?.masteryTrend ?? [];
    if (t.length < 2) return null;
    return Math.round((t[t.length - 1].average - t[0].average) * 100);
  });
  readonly stats = computed<{ label: string; value: string; icon: IconName; tone: string }[]>(() => {
    const d = this.p.data();
    if (!d) return [];
    return [
      { label: 'Day streak', value: String(d.streakDays), icon: 'flame', tone: 'amber' },
      { label: 'Lessons completed', value: `${d.lessonsCompleted}/${d.lessonCount}`, icon: 'book', tone: '' },
      { label: 'Quizzes taken', value: String(d.quizzes.length), icon: 'target', tone: 'mint' },
      { label: 'Questions asked', value: String(d.questionsAsked), icon: 'tutor', tone: '' },
    ];
  });
}
