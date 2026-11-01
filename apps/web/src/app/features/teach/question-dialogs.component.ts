import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatCheckboxModule } from '@angular/material/checkbox';
import { MAT_DIALOG_DATA, MatDialogModule, MatDialogRef } from '@angular/material/dialog';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatSelectModule } from '@angular/material/select';
import { Concept, InstructorQuestion, QuestionStatus, QuestionUpsert, RubricCriterion } from '../../core/models/api.models';
import { IconComponent } from '../../shared/ui/icon/icon.component';

export interface QuestionDialogData {
  question: InstructorQuestion | null;
  concepts: Concept[];
}

/** Create / edit a question, including options (MCQ) or rubric (short answer). */
@Component({
  selector: 'app-question-edit-dialog',
  imports: [FormsModule, MatDialogModule, MatButtonModule, MatFormFieldModule, MatInputModule, MatSelectModule, MatCheckboxModule, IconComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <h2 mat-dialog-title>{{ data.question ? 'Edit question' : 'New question' }}</h2>
    <form (ngSubmit)="save()" #f="ngForm">
      <mat-dialog-content class="content">
        <div class="two">
          <mat-form-field>
            <mat-label>Concept</mat-label>
            <mat-select name="concept" [(ngModel)]="model.conceptId" required>
              @for (c of data.concepts; track c.id) { <mat-option [value]="c.id">{{ c.name }}</mat-option> }
            </mat-select>
          </mat-form-field>
          <mat-form-field>
            <mat-label>Type</mat-label>
            <mat-select name="type" [(ngModel)]="model.type">
              <mat-option value="mcq">Multiple choice</mat-option>
              <mat-option value="short">Short answer</mat-option>
            </mat-select>
          </mat-form-field>
        </div>
        <mat-form-field class="full"><mat-label>Question</mat-label><textarea matInput name="stem" rows="2" [(ngModel)]="model.stem" required></textarea></mat-form-field>

        @if (model.type === 'mcq') {
          <fieldset class="opts">
            <legend>Options — pick the correct one</legend>
            @for (o of model.options; track $index; let i = $index) {
              <div class="opt">
                <label class="correct"><input type="radio" name="correct" [checked]="o.isCorrect" (change)="markCorrect(i)" /><span class="sr-only">Option {{ o.label }} is correct</span><span aria-hidden="true">{{ o.label }}</span></label>
                <mat-form-field class="grow"><mat-label>Option {{ o.label }}</mat-label><input matInput [name]="'opt' + i" [(ngModel)]="o.text" required /></mat-form-field>
              </div>
            }
          </fieldset>
        } @else {
          <fieldset class="opts">
            <legend>Rubric</legend>
            @for (c of rubric; track c.id; let i = $index) {
              <div class="opt">
                <mat-form-field class="grow"><mat-label>Criterion {{ i + 1 }}</mat-label><input matInput [name]="'crit' + i" [(ngModel)]="c.description" /></mat-form-field>
                <mat-form-field class="pts"><mat-label>Points</mat-label><input matInput type="number" min="0" max="10" [name]="'pts' + i" [(ngModel)]="c.points" /></mat-form-field>
              </div>
            }
            <button matButton="text" type="button" (click)="addCriterion()"><app-icon name="plus" [size]="16" /> Add criterion</button>
            <mat-form-field class="full"><mat-label>Model answer</mat-label><textarea matInput name="model" rows="3" [(ngModel)]="modelAnswer"></textarea></mat-form-field>
          </fieldset>
        }

        <mat-form-field class="full"><mat-label>Explanation shown after answering</mat-label><textarea matInput name="expl" rows="3" [(ngModel)]="model.explanation"></textarea></mat-form-field>
        <div class="two">
          <mat-form-field>
            <mat-label>Difficulty</mat-label>
            <mat-select name="diff" [(ngModel)]="model.difficulty">
              <mat-option [value]="0.3">Easy</mat-option>
              <mat-option [value]="0.5">Medium</mat-option>
              <mat-option [value]="0.7">Hard</mat-option>
            </mat-select>
          </mat-form-field>
          <mat-form-field>
            <mat-label>Status</mat-label>
            <mat-select name="status" [(ngModel)]="model.status">
              <mat-option value="draft">Draft</mat-option>
              <mat-option value="published">Published</mat-option>
              <mat-option value="archived">Archived</mat-option>
            </mat-select>
          </mat-form-field>
        </div>
        <mat-checkbox name="diag" [(ngModel)]="model.isDiagnostic">Use in the diagnostic quiz</mat-checkbox>
        @if (error()) { <p class="err" role="alert">{{ error() }}</p> }
      </mat-dialog-content>
      <mat-dialog-actions align="end">
        <button matButton="text" type="button" mat-dialog-close>Cancel</button>
        <button matButton="filled" type="submit">Save question</button>
      </mat-dialog-actions>
    </form>
  `,
  styles: `
    .content {
      display: flex;
      flex-direction: column;
      gap: 4px;
    }
    .two {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 12px;
      @media (max-width: 519.98px) {
        grid-template-columns: 1fr;
      }
    }
    .opts {
      border: 0;
      padding: 0;
      margin: 0 0 8px;
      legend {
        font-weight: 700;
        padding: 0;
        margin-bottom: 8px;
      }
    }
    .opt {
      display: flex;
      align-items: center;
      gap: 10px;
      .grow {
        flex: 1;
      }
      .pts {
        width: 100px;
      }
    }
    .correct {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      min-width: 44px;
      min-height: 44px;
      font-weight: 700;
      cursor: pointer;
      input {
        width: 20px;
        height: 20px;
        accent-color: var(--mint);
      }
    }
    .err {
      color: var(--danger);
      font-weight: 600;
    }
  `,
})
export class QuestionEditDialogComponent {
  readonly data = inject<QuestionDialogData>(MAT_DIALOG_DATA);
  private readonly ref = inject(MatDialogRef<QuestionEditDialogComponent, QuestionUpsert>);
  readonly error = signal('');

  model: QuestionUpsert = this.data.question
    ? {
        conceptId: this.data.question.conceptId,
        lessonId: this.data.question.lessonId,
        type: this.data.question.type,
        stem: this.data.question.stem,
        explanation: this.data.question.explanation,
        difficulty: this.data.question.difficulty,
        status: this.data.question.status,
        isDiagnostic: this.data.question.isDiagnostic,
        options: this.data.question.options.map((o) => ({ label: o.label, text: o.text, isCorrect: o.isCorrect })),
      }
    : { conceptId: this.data.concepts[0]?.id ?? '', type: 'mcq', stem: '', explanation: '', difficulty: 0.5, status: 'draft' as QuestionStatus, isDiagnostic: false, options: [] };
  rubric: RubricCriterion[] = this.data.question?.rubric?.criteria.map((c) => ({ ...c })) ?? [{ id: 'c1', description: '', points: 2 }];
  modelAnswer = this.data.question?.rubric?.modelAnswer ?? '';

  constructor() {
    if (this.model.options.length < 4) {
      const labels = ['A', 'B', 'C', 'D'];
      this.model.options = labels.map((label, i) => this.model.options[i] ?? { label, text: '', isCorrect: i === 0 });
    }
  }

  markCorrect(i: number): void {
    this.model.options = this.model.options.map((o, idx) => ({ ...o, isCorrect: idx === i }));
  }
  addCriterion(): void {
    this.rubric = [...this.rubric, { id: `c${this.rubric.length + 1}`, description: '', points: 1 }];
  }

  save(): void {
    if (!this.model.stem.trim() || !this.model.conceptId) {
      this.error.set('Add the question text and choose a concept.');
      return;
    }
    if (this.model.type === 'mcq') {
      if (this.model.options.some((o) => !o.text.trim())) {
        this.error.set('Fill in all four options.');
        return;
      }
      if (this.model.options.filter((o) => o.isCorrect).length !== 1) {
        this.error.set('Mark exactly one option as correct.');
        return;
      }
    }
    const body: QuestionUpsert = {
      ...this.model,
      options: this.model.type === 'mcq' ? this.model.options : [],
      rubric: this.model.type === 'short' ? { criteria: this.rubric.filter((c) => c.description.trim()), modelAnswer: this.modelAnswer } : null,
    };
    this.ref.close(body);
  }
}

export interface GenerateDialogData {
  concepts: Concept[];
}
export interface GenerateDialogResult {
  conceptId: string;
  count: number;
  difficulty: number;
}

@Component({
  selector: 'app-generate-dialog',
  imports: [FormsModule, MatDialogModule, MatButtonModule, MatFormFieldModule, MatInputModule, MatSelectModule, IconComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <h2 mat-dialog-title><app-icon name="wand" [size]="20" /> Generate questions with AI</h2>
    <form (ngSubmit)="go()">
      <mat-dialog-content class="content">
        <p class="muted">Sathi drafts multiple-choice questions from your course material. They’re saved as <strong>drafts</strong> — review and publish the ones you like.</p>
        <mat-form-field>
          <mat-label>Concept</mat-label>
          <mat-select name="concept" [(ngModel)]="conceptId" required>
            @for (c of data.concepts; track c.id) { <mat-option [value]="c.id">{{ c.name }}</mat-option> }
          </mat-select>
        </mat-form-field>
        <mat-form-field>
          <mat-label>How many</mat-label>
          <input matInput type="number" name="count" min="1" max="10" [(ngModel)]="count" required />
          <mat-hint>1 to 10</mat-hint>
        </mat-form-field>
        <mat-form-field>
          <mat-label>Difficulty</mat-label>
          <mat-select name="diff" [(ngModel)]="difficulty">
            <mat-option [value]="0.3">Easy</mat-option>
            <mat-option [value]="0.5">Medium</mat-option>
            <mat-option [value]="0.7">Hard</mat-option>
          </mat-select>
        </mat-form-field>
      </mat-dialog-content>
      <mat-dialog-actions align="end">
        <button matButton="text" type="button" mat-dialog-close>Cancel</button>
        <button matButton="filled" type="submit" [disabled]="!conceptId || count < 1 || count > 10">Generate drafts</button>
      </mat-dialog-actions>
    </form>
  `,
  styles: `
    h2 {
      display: flex;
      align-items: center;
      gap: 8px;
    }
    .content {
      display: flex;
      flex-direction: column;
      gap: 6px;
    }
  `,
})
export class GenerateDialogComponent {
  readonly data = inject<GenerateDialogData>(MAT_DIALOG_DATA);
  private readonly ref = inject(MatDialogRef<GenerateDialogComponent, GenerateDialogResult>);
  conceptId = this.data.concepts[0]?.id ?? '';
  count = 5;
  difficulty = 0.5;

  go(): void {
    this.ref.close({ conceptId: this.conceptId, count: Math.max(1, Math.min(10, Math.round(this.count))), difficulty: this.difficulty });
  }
}
