import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';

/** Loading placeholder: a card of shimmering lines. Announces "Loading" to screen readers once. */
@Component({
  selector: 'app-skeleton',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="sk" [class.card]="card()" role="status" [attr.aria-label]="label()">
      @if (heading()) {
        <span class="skeleton head"></span>
      }
      @for (w of widths(); track $index) {
        <span class="skeleton line" [style.width]="w"></span>
      }
    </div>
  `,
  styles: `
    :host {
      display: block;
    }
    .sk {
      display: flex;
      flex-direction: column;
      gap: 12px;
    }
    .head {
      height: 22px;
      width: 45%;
      margin-bottom: 6px;
    }
    .line {
      height: 12px;
    }
  `,
})
export class SkeletonComponent {
  readonly lines = input(3);
  readonly heading = input(true);
  readonly card = input(true);
  readonly label = input('Loading');
  readonly widths = computed(() => Array.from({ length: this.lines() }, (_, i) => `${[92, 78, 64, 85, 55][i % 5]}%`));
}
