import { DatePipe } from '@angular/common';
import { ChangeDetectionStrategy, Component, effect, inject, signal, untracked } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatSelectModule } from '@angular/material/select';
import { of } from 'rxjs';
import { InstructorApi } from '../../core/api/staff.api';
import { Notifier } from '../../core/errors/notifier.service';
import { GradingQueueItem } from '../../core/models/api.models';
import { createLoader } from '../../core/platform/loader';
import { IconComponent } from '../../shared/ui/icon/icon.component';
import { EmptyStateComponent } from '../../shared/ui/states/empty-state.component';
import { ErrorStateComponent } from '../../shared/ui/states/error-state.component';
import { SkeletonComponent } from '../../shared/ui/states/skeleton.component';
import { TeachContext } from './teach-context.service';

interface Draft {
  mode: 'idle' | 'override';
  score: number;
  feedback: string;
  busy: boolean;
}

export function confidenceLabel(c: number): string {
  if (c >= 0.75) return 'High confidence';
  if (c >= 0.5) return 'Medium confidence';
  return 'Low confidence';
}

@Component({
  selector: 'app-grading-queue',
  imports: [DatePipe, FormsModule, MatButtonModule, MatFormFieldModule, MatInputModule, MatSelectModule, IconComponent, SkeletonComponent, ErrorStateComponent, EmptyStateComponent],
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
    <p class="intro muted">Answers the AI grader wasn’t sure about. Accept its score or override it — your decision updates the student’s mastery and is logged.</p>
    @switch (queue.status()) {
      @case ('loading') { <div class="stack"><app-skeleton [lines]="6" /><app-skeleton [lines]="6" /></div> }
      @case ('error') { <app-error-state [error]="queue.error()" title="We couldn’t load the review queue" (retry)="queue.load()" /> }
      @default {
        <ul class="items">
          @for (g of queue.data() ?? []; track g.gradingId) {
            <li class="card item" [attr.aria-labelledby]="'g-' + g.gradingId">
              <header class="head">
                <div>
                  <h2 [id]="'g-' + g.gradingId" class="who"><app-icon name="user" [size]="16" /> {{ g.studentDisplayName }}</h2>
                  <p class="muted small">Submitted {{ g.submittedAt | date: 'EEE d MMM, HH:mm' }}</p>
                </div>
                <div class="ai">
                  <span class="score num"><small>AI score</small> {{ g.aiScore }} / {{ g.maxScore }}</span>
                  <span class="conf" [class.low]="g.confidence < 0.5">
                    <span class="bar thin" aria-hidden="true"><span class="fill" [style.width.%]="g.confidence * 100"></span></span>
                    {{ confidenceLabel(g.confidence) }} · {{ pct(g.confidence) }}%
                  </span>
                </div>
              </header>
              <div class="grid">
                <div>
                  <h3>Question</h3>
                  <p>{{ g.questionStem }}</p>
                  <h3>Student answer</h3>
                  <blockquote class="answer">{{ g.answerText }}</blockquote>
                  <h3>AI feedback</h3>
                  <p class="muted">{{ g.aiFeedback }}</p>
                </div>
                <div class="rubric">
                  <h3>Rubric</h3>
                  <ul>
                    @for (c of g.rubric.criteria; track c.id) {
                      <li><span>{{ c.description }}</span><span class="pts num">{{ c.points }} pt{{ c.points === 1 ? '' : 's' }}</span></li>
                    }
                  </ul>
                  @if (g.rubric.modelAnswer) {
                    <details>
                      <summary>Model answer</summary>
                      <p>{{ g.rubric.modelAnswer }}</p>
                    </details>
                  }
                </div>
              </div>

              @if (draft(g).mode === 'override') {
                <form class="override" (ngSubmit)="submit(g, draft(g).score, draft(g).feedback)">
                  <mat-form-field class="sc">
                    <mat-label>Final score (0–{{ g.maxScore }})</mat-label>
                    <input matInput type="number" [min]="0" [max]="g.maxScore" step="0.5" [name]="'s' + g.gradingId" [ngModel]="draft(g).score" (ngModelChange)="patch(g, { score: +$event })" required />
                  </mat-form-field>
                  <mat-form-field class="fb">
                    <mat-label>Feedback to the student</mat-label>
                    <textarea matInput rows="2" [name]="'f' + g.gradingId" [ngModel]="draft(g).feedback" (ngModelChange)="patch(g, { feedback: $event })" required></textarea>
                  </mat-form-field>
                  <div class="row">
                    <button matButton="text" type="button" (click)="patch(g, { mode: 'idle' })">Cancel</button>
                    <button matButton="filled" type="submit" [disabled]="draft(g).busy || !validScore(g) || !draft(g).feedback.trim()">{{ draft(g).busy ? 'Saving…' : 'Save review' }}</button>
                  </div>
                </form>
              } @else {
                <div class="row actions">
                  <button matButton="filled" type="button" (click)="submit(g, g.aiScore, g.aiFeedback)" [disabled]="draft(g).busy"><app-icon name="check" [size]="16" /> Accept AI score</button>
                  <button matButton="outlined" type="button" (click)="patch(g, { mode: 'override' })"><app-icon name="edit" [size]="16" /> Override</button>
                </div>
              }
            </li>
          } @empty {
            <app-empty-state icon="check-circle" title="All caught up" text="No answers need review right now. Low-confidence grades will appear here." />
          }
        </ul>
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
    .intro {
      margin-bottom: 16px;
      max-width: 70ch;
    }
    .items {
      list-style: none;
      margin: 0;
      padding: 0;
      display: flex;
      flex-direction: column;
      gap: 18px;
    }
    .item {
      display: flex;
      flex-direction: column;
      gap: 14px;
    }
    .head {
      display: flex;
      justify-content: space-between;
      gap: 14px;
      flex-wrap: wrap;
    }
    .who {
      display: flex;
      align-items: center;
      gap: 6px;
      font-size: 1.05rem;
    }
    .ai {
      display: flex;
      flex-direction: column;
      align-items: flex-end;
      gap: 6px;
      @media (max-width: 599.98px) {
        align-items: flex-start;
      }
    }
    .score {
      font-family: var(--font-head);
      font-size: 1.3rem;
      font-weight: 700;
      small {
        font-family: var(--font-body);
        font-size: 0.75rem;
        color: var(--muted);
        font-weight: 600;
        margin-right: 4px;
      }
    }
    .conf {
      display: flex;
      align-items: center;
      gap: 8px;
      font-size: 0.8125rem;
      font-weight: 600;
      color: var(--muted);
      .bar {
        width: 80px;
        display: block;
      }
      .fill {
        display: block;
        background: var(--primary);
      }
      &.low {
        color: var(--amber-ink);
        .fill {
          background: var(--amber-bar);
        }
      }
    }
    .grid {
      display: grid;
      grid-template-columns: minmax(0, 1.4fr) minmax(0, 1fr);
      gap: 20px;
      @media (max-width: 899.98px) {
        grid-template-columns: 1fr;
      }
      h3 {
        font-size: 0.8rem;
        letter-spacing: 0.06em;
        text-transform: uppercase;
        color: var(--muted);
        margin: 12px 0 6px;
        &:first-child {
          margin-top: 0;
        }
      }
    }
    .answer {
      margin: 0;
      padding: 12px 16px;
      border-inline-start: 4px solid var(--primary);
      background: var(--surface-2);
      border-radius: 0 12px 12px 0;
      white-space: pre-wrap;
    }
    .rubric {
      padding: 14px 16px;
      border-radius: 14px;
      background: var(--surface-2);
      align-self: start;
      ul {
        list-style: none;
        margin: 0;
        padding: 0;
        display: flex;
        flex-direction: column;
        gap: 8px;
      }
      li {
        display: flex;
        justify-content: space-between;
        gap: 10px;
        font-size: 0.9rem;
      }
      .pts {
        font-weight: 700;
        white-space: nowrap;
      }
      details {
        margin-top: 12px;
        font-size: 0.9rem;
      }
      summary {
        cursor: pointer;
        font-weight: 600;
        min-height: 32px;
      }
    }
    .override {
      display: flex;
      gap: 12px;
      flex-wrap: wrap;
      align-items: flex-start;
      .sc {
        width: 180px;
      }
      .fb {
        flex: 1;
        min-width: 240px;
      }
      .row {
        width: 100%;
        justify-content: flex-end;
      }
    }
  `,
})
export default class GradingQueueComponent {
  private readonly api = inject(InstructorApi);
  private readonly notifier = inject(Notifier);
  readonly ctx = inject(TeachContext);
  readonly classId = signal('');
  readonly confidenceLabel = confidenceLabel;
  private readonly drafts = signal<Record<string, Draft>>({});

  readonly queue = createLoader(() => {
    const id = this.ctx.courseId();
    return id ? this.api.gradingQueue(id, this.classId() || null) : of([] as GradingQueueItem[]);
  }, { immediate: false });

  constructor() {
    effect(() => {
      this.ctx.courseId();
      untracked(() => this.classId.set(''));
    });
    effect(() => {
      this.ctx.courseId();
      this.classId();
      untracked(() => this.queue.load());
    });
  }

  draft(g: GradingQueueItem): Draft {
    return this.drafts()[g.gradingId] ?? { mode: 'idle', score: g.aiScore, feedback: g.aiFeedback, busy: false };
  }
  patch(g: GradingQueueItem, p: Partial<Draft>): void {
    this.drafts.update((d) => ({ ...d, [g.gradingId]: { ...this.draft(g), ...p } }));
  }
  validScore(g: GradingQueueItem): boolean {
    const s = this.draft(g).score;
    return Number.isFinite(s) && s >= 0 && s <= g.maxScore;
  }
  pct(v: number): number {
    return Math.round(v * 100);
  }

  submit(g: GradingQueueItem, finalScore: number, feedback: string): void {
    this.patch(g, { busy: true });
    this.api.review(g.gradingId, { finalScore, feedback }).subscribe({
      next: () => {
        this.queue.update((l) => l.filter((x) => x.gradingId !== g.gradingId));
        this.notifier.success(`Review saved for ${g.studentDisplayName}.`);
      },
      error: () => this.patch(g, { busy: false }),
    });
  }
}
