import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import { pct } from './mastery-bar.component';

/** "Backpropagation mastery 42% to 48%" — before/after bar with the gain highlighted. */
@Component({
  selector: 'app-mastery-change',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="mc">
      <div class="label">
        <span class="name">{{ name() }} mastery</span>
        <span class="value num">
          {{ beforePct() }}% to <strong>{{ afterPct() }}%</strong>
          <span class="delta" [class.up]="delta() > 0" [class.down]="delta() < 0">
            ({{ delta() > 0 ? '+' : delta() < 0 ? '−' : '±' }}{{ abs() }})
          </span>
        </span>
      </div>
      <div class="bar" aria-hidden="true">
        <div class="base" [style.width.%]="lowPct()"></div>
        <div class="gain" [class.loss]="delta() < 0" [style.left.%]="lowPct()" [style.width.%]="abs()"></div>
      </div>
    </div>
  `,
  styles: `
    .label {
      display: flex;
      justify-content: space-between;
      gap: 12px;
      font-size: 0.875rem;
      color: var(--muted);
      margin-bottom: 6px;
      flex-wrap: wrap;
    }
    strong {
      color: var(--ink);
    }
    .delta.up {
      color: var(--mint-ink);
      font-weight: 600;
    }
    .delta.down {
      color: var(--amber-ink);
      font-weight: 600;
    }
    .bar {
      height: 10px;
    }
    .base {
      position: absolute;
      inset: 0 auto 0 0;
      background: var(--amber-bar);
      border-radius: inherit;
      transition: width 0.6s ease;
    }
    .gain {
      position: absolute;
      top: 0;
      bottom: 0;
      background: repeating-linear-gradient(135deg, var(--mint-bar) 0 6px, color-mix(in srgb, var(--mint-bar) 70%, white) 6px 12px);
      border-radius: 0 999px 999px 0;
      transition:
        width 0.6s ease 0.2s,
        left 0.6s ease;
      &.loss {
        background: repeating-linear-gradient(135deg, var(--track) 0 6px, var(--amber-soft) 6px 12px);
        outline: 1px dashed var(--amber-bar);
      }
    }
  `,
})
export class MasteryChangeComponent {
  readonly name = input.required<string>();
  readonly before = input.required<number>();
  readonly after = input.required<number>();

  readonly beforePct = computed(() => pct(this.before()));
  readonly afterPct = computed(() => pct(this.after()));
  readonly delta = computed(() => this.afterPct() - this.beforePct());
  readonly abs = computed(() => Math.abs(this.delta()));
  readonly lowPct = computed(() => Math.min(this.beforePct(), this.afterPct()));
}
