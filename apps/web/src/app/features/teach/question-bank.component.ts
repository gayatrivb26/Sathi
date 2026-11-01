import { ChangeDetectionStrategy, Component, computed, effect, inject, signal, untracked } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatDialog } from '@angular/material/dialog';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatSelectModule } from '@angular/material/select';
import { firstValueFrom, forkJoin, of } from 'rxjs';
import { LearningApi } from '../../core/api/learning.api';
import { InstructorApi } from '../../core/api/staff.api';
import { Notifier } from '../../core/errors/notifier.service';
import { Concept, InstructorQuestion, QuestionStatus, QuestionUpsert } from '../../core/models/api.models';
import { createLoader } from '../../core/platform/loader';
import { IconComponent } from '../../shared/ui/icon/icon.component';
import { EmptyStateComponent } from '../../shared/ui/states/empty-state.component';
import { ErrorStateComponent } from '../../shared/ui/states/error-state.component';
import { SkeletonComponent } from '../../shared/ui/states/skeleton.component';
import { ReferenceIdComponent } from '../../shared/ui/reference-id/reference-id.component';
import { GenerateDialogComponent, GenerateDialogData, GenerateDialogResult, QuestionDialogData, QuestionEditDialogComponent } from './question-dialogs.component';
import { TeachContext } from './teach-context.service';

const DIFF: Record<string, string> = { '0.3': 'Easy', '0.5': 'Medium', '0.7': 'Hard' };

function toUpsert(q: InstructorQuestion, status: QuestionStatus = q.status): QuestionUpsert {
  return { conceptId: q.conceptId, lessonId: q.lessonId, type: q.type, stem: q.stem, explanation: q.explanation, difficulty: q.difficulty, status, isDiagnostic: q.isDiagnostic, options: q.options.map(({ label, text, isCorrect }) => ({ label, text, isCorrect })), rubric: q.rubric };
}

@Component({
  selector: 'app-question-bank',
  imports: [MatButtonModule, MatFormFieldModule, MatSelectModule, IconComponent, SkeletonComponent, ErrorStateComponent, EmptyStateComponent, ReferenceIdComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="toolbar">
      <div class="filters" role="group" aria-label="Filter by status">
        @for (s of statuses; track s.id) {
          <button type="button" class="chip-btn" [attr.aria-pressed]="status() === s.id" (click)="status.set(s.id)">{{ s.label }}</button>
        }
      </div>
      <mat-form-field class="concept-filter" subscriptSizing="dynamic">
        <mat-label>Concept</mat-label>
        <mat-select [value]="conceptId()" (valueChange)="conceptId.set($event)">
          <mat-option value="">All concepts</mat-option>
          @for (c of concepts(); track c.id) { <mat-option [value]="c.id">{{ c.name }}</mat-option> }
        </mat-select>
      </mat-form-field>
      <span class="spacer"></span>
      <button matButton="outlined" type="button" (click)="create()"><app-icon name="plus" [size]="16" /> New question</button>
      <button matButton="filled" type="button" (click)="generate()" [disabled]="!concepts().length"><app-icon name="wand" [size]="16" /> Generate questions with AI</button>
    </div>

    @if (generated(); as g) {
      <div class="gen" role="status">
        <app-icon name="sparkles" [size]="18" />
        <div><strong>Drafts generated.</strong> Review them below before publishing. <app-reference-id [referenceId]="g" [hint]="false" /></div>
        <button type="button" class="x" (click)="generated.set(null)" aria-label="Dismiss"><app-icon name="x" [size]="16" /></button>
      </div>
    }

    @switch (list.status()) {
      @case ('loading') { <div class="stack"><app-skeleton [lines]="3" /><app-skeleton [lines]="3" /></div> }
      @case ('error') { <app-error-state [error]="list.error()" title="We couldn’t load questions" (retry)="list.load()" /> }
      @default {
        <p class="muted small count">{{ list.data()?.length ?? 0 }} question{{ list.data()?.length === 1 ? '' : 's' }}</p>
        <ul class="qs">
          @for (q of list.data() ?? []; track q.id) {
            <li class="card q">
              <div class="tags">
                <span class="pill" [class.mint]="q.status === 'published'" [class.amber]="q.status === 'draft'" [class.neutral]="q.status === 'archived'">{{ statusLabel(q.status) }}</span>
                <span class="pill neutral">{{ q.type === 'mcq' ? 'Multiple choice' : 'Short answer' }}</span>
                <span class="pill neutral">{{ q.conceptName }}</span>
                <span class="pill neutral">{{ diff(q.difficulty) }}</span>
                @if (q.source === 'generated') { <span class="pill upload"><app-icon name="wand" [size]="12" /> AI draft</span> }
                @if (q.isDiagnostic) { <span class="pill">Diagnostic</span> }
              </div>
              <p class="stem">{{ q.stem }}</p>
              @if (q.type === 'mcq') {
                <ol class="opts">
                  @for (o of q.options; track o.label) {
                    <li [class.correct]="o.isCorrect"><strong>{{ o.label }}.</strong> {{ o.text }} @if (o.isCorrect) { <span class="ok">· Correct</span> }</li>
                  }
                </ol>
              } @else if (q.rubric) {
                <p class="muted small">Rubric: {{ q.rubric.criteria.length }} criteria · {{ totalPoints(q) }} points</p>
              }
              <div class="row">
                <button matButton="outlined" type="button" (click)="edit(q)"><app-icon name="edit" [size]="16" /> Edit</button>
                @if (q.status !== 'published') {
                  <button matButton="filled" type="button" (click)="setStatus(q, 'published')"><app-icon name="check" [size]="16" /> Publish</button>
                }
                @if (q.status !== 'archived') {
                  <button matButton="text" type="button" (click)="setStatus(q, 'archived')">Archive</button>
                }
              </div>
            </li>
          } @empty {
            <app-empty-state icon="layers" title="No questions match" text="Try another filter, write a question, or let AI draft some for you." />
          }
        </ul>
      }
    }
  `,
  styles: `
    .toolbar {
      display: flex;
      align-items: center;
      gap: 10px;
      flex-wrap: wrap;
      margin-bottom: 16px;
    }
    .filters {
      display: flex;
      gap: 6px;
      flex-wrap: wrap;
    }
    .concept-filter {
      width: 220px;
    }
    .gen {
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 12px 14px;
      margin-bottom: 16px;
      border-radius: 14px;
      background: var(--upload-soft);
      > div {
        flex: 1;
      }
    }
    .x {
      display: grid;
      place-items: center;
      width: 44px;
      height: 44px;
      border: 0;
      background: none;
      border-radius: 10px;
      cursor: pointer;
      color: var(--muted);
    }
    .count {
      margin-bottom: 10px;
    }
    .qs {
      list-style: none;
      margin: 0;
      padding: 0;
      display: flex;
      flex-direction: column;
      gap: 14px;
    }
    .q {
      display: flex;
      flex-direction: column;
      gap: 10px;
    }
    .tags {
      display: flex;
      gap: 6px;
      flex-wrap: wrap;
    }
    .stem {
      font-weight: 600;
      font-size: 1.02rem;
    }
    .opts {
      list-style: none;
      margin: 0;
      padding: 0;
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 4px 18px;
      font-size: 0.9rem;
      color: var(--muted);
      @media (max-width: 719.98px) {
        grid-template-columns: 1fr;
      }
      .correct {
        color: var(--ink);
      }
      .ok {
        color: var(--mint-ink);
        font-weight: 700;
      }
    }
  `,
})
export default class QuestionBankComponent {
  private readonly api = inject(InstructorApi);
  private readonly learning = inject(LearningApi);
  private readonly dialog = inject(MatDialog);
  private readonly notifier = inject(Notifier);
  private readonly ctx = inject(TeachContext);

  readonly statuses: { id: QuestionStatus | ''; label: string }[] = [
    { id: '', label: 'All' },
    { id: 'draft', label: 'Drafts' },
    { id: 'published', label: 'Published' },
    { id: 'archived', label: 'Archived' },
  ];
  readonly status = signal<QuestionStatus | ''>('');
  readonly conceptId = signal('');
  readonly generated = signal<string | null>(null);
  readonly conceptList = signal<Concept[]>([]);
  readonly concepts = computed(() => this.conceptList());

  readonly list = createLoader(() => {
    const id = this.ctx.courseId();
    return id ? this.api.questions(id, this.status(), this.conceptId()) : of([] as InstructorQuestion[]);
  }, { immediate: false });

  constructor() {
    effect(() => {
      const id = this.ctx.courseId();
      this.status();
      this.conceptId();
      untracked(() => this.list.load());
      if (id) untracked(() => forkJoin([this.learning.course(id)]).subscribe({ next: ([c]) => this.conceptList.set(c.concepts), error: () => undefined }));
    });
  }

  diff(d: number): string {
    return DIFF[String(d)] ?? `Difficulty ${Math.round(d * 100)}%`;
  }
  statusLabel(s: QuestionStatus): string {
    return s === 'draft' ? 'Draft' : s === 'published' ? 'Published' : 'Archived';
  }
  totalPoints(q: InstructorQuestion): number {
    return q.rubric?.criteria.reduce((s, c) => s + c.points, 0) ?? 0;
  }

  async create(): Promise<void> {
    const body = await firstValueFrom(this.dialog.open<QuestionEditDialogComponent, QuestionDialogData, QuestionUpsert>(QuestionEditDialogComponent, { data: { question: null, concepts: this.concepts() }, width: '640px', maxWidth: 'calc(100vw - 32px)' }).afterClosed());
    if (!body) return;
    await firstValueFrom(this.api.createQuestion(body)).then(() => {
      this.notifier.success('Question created.');
      this.list.load();
    }).catch(() => undefined);
  }

  async edit(q: InstructorQuestion): Promise<void> {
    const body = await firstValueFrom(this.dialog.open<QuestionEditDialogComponent, QuestionDialogData, QuestionUpsert>(QuestionEditDialogComponent, { data: { question: q, concepts: this.concepts() }, width: '640px', maxWidth: 'calc(100vw - 32px)' }).afterClosed());
    if (!body) return;
    await firstValueFrom(this.api.updateQuestion(q.id, body)).then((updated) => {
      this.list.update((l) => l.map((x) => (x.id === q.id ? updated : x)));
      this.notifier.success('Question saved.');
    }).catch(() => undefined);
  }

  setStatus(q: InstructorQuestion, status: QuestionStatus): void {
    this.api.updateQuestion(q.id, toUpsert(q, status)).subscribe((updated) => {
      this.list.update((l) => l.map((x) => (x.id === q.id ? updated : x)));
      this.notifier.success(status === 'published' ? 'Published — students can now get this question.' : 'Question archived.');
    });
  }

  async generate(): Promise<void> {
    const courseId = this.ctx.courseId();
    if (!courseId) return;
    const r = await firstValueFrom(this.dialog.open<GenerateDialogComponent, GenerateDialogData, GenerateDialogResult>(GenerateDialogComponent, { data: { concepts: this.concepts() }, width: '480px', maxWidth: 'calc(100vw - 32px)' }).afterClosed());
    if (!r) return;
    try {
      const accepted = await firstValueFrom(this.api.generateQuestions({ courseId, ...r }));
      this.notifier.info(`Generating ${r.count} draft question${r.count === 1 ? '' : 's'}…`);
      this.generated.set(accepted.referenceId);
      this.status.set('draft');
      setTimeout(() => this.list.load(), 2000);
    } catch {
      /* toast shown */
    }
  }
}
