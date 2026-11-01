import { ChangeDetectionStrategy, Component, computed, effect, input, output, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { AttemptQuestion } from '../../core/models/api.models';
import { IconComponent } from '../ui/icon/icon.component';

export interface QuestionReveal {
  selectedOptionId: string | null;
  correctOptionId: string | null;
  isCorrect: boolean | null;
}
export interface QuestionAnswer {
  selectedOptionId?: string;
  freeText?: string;
}

let nextId = 0;

/**
 * Accessible question card: MCQ as a native radio group (keyboard + screen reader for free),
 * short answers as a labelled textarea. After `reveal`, options carry text labels
 * ("Correct answer", "Your answer") as well as colour and icons.
 */
@Component({
  selector: 'app-question-card',
  imports: [FormsModule, MatButtonModule, IconComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './question-card.component.html',
  styleUrl: './question-card.component.scss',
})
export class QuestionCardComponent {
  readonly question = input.required<AttemptQuestion>();
  readonly reveal = input<QuestionReveal | null>(null);
  readonly busy = input(false);
  readonly allowIdk = input(false);
  readonly submitLabel = input('Check answer');
  /** Hide the built-in submit button (the parent provides its own actions). */
  readonly hideSubmit = input(false);

  readonly answer = output<QuestionAnswer>();
  readonly idk = output<void>();
  readonly selectionChange = output<string | null>();

  readonly uid = `q${++nextId}`;
  readonly selected = signal<string | null>(null);
  readonly freeText = signal('');
  readonly locked = computed(() => !!this.reveal() || this.busy());
  readonly canSubmit = computed(() =>
    this.question().type === 'mcq' ? !!this.selected() : this.freeText().trim().length > 0,
  );

  constructor() {
    // Reset when the question changes.
    effect(() => {
      this.question();
      this.selected.set(null);
      this.freeText.set('');
    });
    effect(() => {
      const r = this.reveal();
      if (r?.selectedOptionId) this.selected.set(r.selectedOptionId);
    });
  }

  choose(id: string): void {
    if (this.locked()) return;
    this.selected.set(id);
    this.selectionChange.emit(id);
  }

  submit(): void {
    if (!this.canSubmit() || this.locked()) return;
    if (this.question().type === 'mcq') this.answer.emit({ selectedOptionId: this.selected()! });
    else this.answer.emit({ freeText: this.freeText().trim() });
  }

  state(optionId: string): 'correct' | 'wrong' | 'selected' | 'idle' {
    const r = this.reveal();
    if (r) {
      if (optionId === r.correctOptionId) return 'correct';
      if (optionId === r.selectedOptionId) return 'wrong';
      return 'idle';
    }
    return this.selected() === optionId ? 'selected' : 'idle';
  }

  isYours(optionId: string): boolean {
    return this.reveal()?.selectedOptionId === optionId;
  }
}
