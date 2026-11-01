import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';

export function masteryTone(m: number): 'strong' | 'ok' | 'weak' {
  if (m >= 0.75) return 'strong';
  if (m >= 0.5) return 'ok';
  return 'weak';
}

export function pct(m: number | null | undefined): number {
  return Math.round(Math.max(0, Math.min(1, m ?? 0)) * 100);
}

/** Concept mastery bar. The state is in the text ("42% · needs work", "not started yet"), not only in the colour. */
@Component({
  selector: 'app-mastery-bar',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="mb" [class]="'mb tone-' + tone()">
      <div class="label">
        <span class="name">{{ name() }}</span>
        <span class="value num">
          @if (notStarted()) {
            <span class="ns">not started yet</span>
          } @else {
          {{ percent() }}%
          @if (needsWork()) {
            <span class="nw">· needs work</span>
          } @else if (tone() === 'strong') {
            <span class="strong-tag">· strong</span>
          }
          }
        </span>
      </div>
      <div class="bar" aria-hidden="true"><div class="fill" [style.width.%]="notStarted() ? 0 : percent()"></div></div>
    </div>
  `,
  styles: `
    .label {
      display: flex;
      justify-content: space-between;
      align-items: baseline;
      gap: 12px;
      margin-bottom: 6px;
    }
    .name {
      font-weight: 500;
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .value {
      color: var(--muted);
      font-size: 0.875rem;
      white-space: nowrap;
    }
    .nw {
      color: var(--amber-ink);
      font-weight: 600;
    }
    .ns {
      font-style: italic;
    }
    .strong-tag {
      color: var(--mint-ink);
      font-weight: 600;
    }
    .tone-strong .fill {
      background: var(--mint-bar);
    }
    .tone-ok .fill {
      background: var(--primary);
    }
    .tone-weak .fill {
      background: var(--amber-bar);
    }
  `,
})
export class MasteryBarComponent {
  readonly name = input.required<string>();
  readonly mastery = input.required<number>();
  readonly needsWorkInput = input<boolean | undefined>(undefined, { alias: 'needsWork' });
  /** Practice attempts so far; 0 means the value is only the starting estimate, so it is not shown as a score. */
  readonly attempts = input<number | undefined>(undefined);

  readonly notStarted = computed(() => this.attempts() === 0);

  readonly percent = computed(() => pct(this.mastery()));
  readonly tone = computed(() => masteryTone(this.mastery()));
  readonly needsWork = computed(() => this.needsWorkInput() ?? this.mastery() < 0.5);
}
