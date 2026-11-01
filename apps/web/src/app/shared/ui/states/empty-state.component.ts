import { ChangeDetectionStrategy, Component, input } from '@angular/core';
import { IconComponent } from '../icon/icon.component';
import { IconName } from '../icon/icons';

/** Friendly empty state with an icon, a sentence and projected actions. */
@Component({
  selector: 'app-empty-state',
  imports: [IconComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="empty" [class.plain]="plain()">
      <span class="badge"><app-icon [name]="icon()" [size]="26" /></span>
      <h2>{{ title() }}</h2>
      @if (text()) {
        <p>{{ text() }}</p>
      }
      <div class="actions"><ng-content /></div>
    </div>
  `,
  styles: `
    .empty {
      display: flex;
      flex-direction: column;
      align-items: center;
      text-align: center;
      gap: 8px;
      padding: 36px 20px;
      border-radius: var(--radius);
      background: var(--surface);
      border: 1px dashed var(--border-input);
    }
    .plain {
      border: 0;
      background: none;
      padding: 24px 8px;
    }
    .badge {
      display: grid;
      place-items: center;
      width: 56px;
      height: 56px;
      border-radius: 18px;
      background: var(--primary-soft);
      color: var(--primary-ink);
      margin-bottom: 6px;
    }
    h2 {
      font-size: 1.08rem;
    }
    p {
      color: var(--muted);
      max-width: 44ch;
    }
    .actions:not(:empty) {
      margin-top: 10px;
      display: flex;
      gap: 10px;
      flex-wrap: wrap;
      justify-content: center;
    }
  `,
})
export class EmptyStateComponent {
  readonly icon = input<IconName>('inbox');
  readonly title = input.required<string>();
  readonly text = input<string>('');
  readonly plain = input(false);
}
