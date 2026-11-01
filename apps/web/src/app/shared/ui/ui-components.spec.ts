import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { ApiError } from '../../core/http/api-error';
import { AttemptQuestion } from '../../core/models/api.models';
import { QuestionCardComponent } from '../quiz/question-card.component';
import { MasteryBarComponent } from './mastery/mastery-bar.component';
import { MasteryChangeComponent } from './mastery/mastery-change.component';
import { ErrorStateComponent } from './states/error-state.component';

const Q: AttemptQuestion = {
  id: 'q1',
  position: 1,
  type: 'mcq',
  stem: 'Which statement about the chain rule in backpropagation is correct?',
  conceptId: 'c',
  conceptName: 'Backpropagation',
  options: [
    { id: 'a', label: 'A', text: 'Gradients are computed from the input forward' },
    { id: 'b', label: 'B', text: 'Each layer multiplies the incoming gradient by its local derivative' },
    { id: 'c', label: 'C', text: 'Weights are updated before gradients exist' },
    { id: 'd', label: 'D', text: 'Only the final layer receives a gradient' },
  ],
};

describe('shared UI components', () => {
  beforeEach(() => TestBed.configureTestingModule({ providers: [provideZonelessChangeDetection()] }));

  it('MasteryBar shows "needs work" in text, not only colour', async () => {
    const f = TestBed.createComponent(MasteryBarComponent);
    f.componentRef.setInput('name', 'Backpropagation');
    f.componentRef.setInput('mastery', 0.42);
    await f.whenStable();
    const text = (f.nativeElement as HTMLElement).textContent ?? '';
    expect(text).toContain('Backpropagation');
    expect(text).toContain('42%');
    expect(text).toContain('needs work');
  });

  it('MasteryBar shows an unpractised concept as not started, not as a weak score', async () => {
    const f = TestBed.createComponent(MasteryBarComponent);
    f.componentRef.setInput('name', 'Chunking');
    f.componentRef.setInput('mastery', 0.3);
    f.componentRef.setInput('attempts', 0);
    await f.whenStable();
    const text = (f.nativeElement as HTMLElement).textContent ?? '';
    expect(text).toContain('not started yet');
    expect(text).not.toContain('30%');
    expect(text).not.toContain('needs work');
  });

  it('MasteryBar labels strong concepts', async () => {
    const f = TestBed.createComponent(MasteryBarComponent);
    f.componentRef.setInput('name', 'Gradient descent');
    f.componentRef.setInput('mastery', 0.82);
    await f.whenStable();
    expect((f.nativeElement as HTMLElement).textContent).toContain('strong');
  });

  it('MasteryChange reads "42% to 48% (+6)"', async () => {
    const f = TestBed.createComponent(MasteryChangeComponent);
    f.componentRef.setInput('name', 'Backpropagation');
    f.componentRef.setInput('before', 0.42);
    f.componentRef.setInput('after', 0.48);
    await f.whenStable();
    const text = ((f.nativeElement as HTMLElement).textContent ?? '').replace(/\s+/g, ' ');
    expect(text).toContain('Backpropagation mastery');
    expect(text).toContain('42% to 48%');
    expect(text).toContain('+6');
  });

  it('ErrorState shows the friendly message and reference ID, and emits retry', async () => {
    const f = TestBed.createComponent(ErrorStateComponent);
    f.componentRef.setInput('error', new ApiError({ status: 503, code: 'LLM_UNAVAILABLE', referenceId: '7F3A-91C2' }));
    let retried = false;
    f.componentInstance.retry.subscribe(() => (retried = true));
    await f.whenStable();
    const el = f.nativeElement as HTMLElement;
    expect(el.textContent).toContain('The tutor is unavailable right now');
    expect(el.textContent).toContain('7F3A-91C2');
    expect(el.querySelector('[role="alert"]')).not.toBeNull();
    (Array.from(el.querySelectorAll('button')).find((b) => b.textContent?.includes('Try again')) as HTMLButtonElement).click();
    expect(retried).toBe(true);
  });

  it('QuestionCard labels answers with text after reveal', async () => {
    const f = TestBed.createComponent(QuestionCardComponent);
    f.componentRef.setInput('question', Q);
    f.componentRef.setInput('reveal', { selectedOptionId: 'c', correctOptionId: 'b', isCorrect: false });
    await f.whenStable();
    const labels = Array.from((f.nativeElement as HTMLElement).querySelectorAll('label.opt')).map((l) => (l.textContent ?? '').replace(/\s+/g, ' '));
    expect(labels[1]).toContain('Correct answer');
    expect(labels[2]).toContain('Your answer');
    expect(labels[0]).not.toContain('answer ·');
    const radios = (f.nativeElement as HTMLElement).querySelectorAll('input[type="radio"]');
    expect(Array.from(radios).every((r) => (r as HTMLInputElement).disabled)).toBe(true);
  });

  it('QuestionCard emits the selected option on submit', async () => {
    const f = TestBed.createComponent(QuestionCardComponent);
    f.componentRef.setInput('question', Q);
    await f.whenStable();
    let answer: unknown = null;
    f.componentInstance.answer.subscribe((a) => (answer = a));
    const radio = (f.nativeElement as HTMLElement).querySelectorAll('input[type="radio"]')[1] as HTMLInputElement;
    radio.click();
    await f.whenStable();
    ((f.nativeElement as HTMLElement).querySelector('button[type="submit"]') as HTMLButtonElement).click();
    expect(answer).toEqual({ selectedOptionId: 'b' });
  });
});
