import { ChangeDetectionStrategy, Component, input, signal } from '@angular/core';
import { IconComponent } from '../icon/icon.component';

/** "Reference 7F3A-91C2 · quote it if you contact support" with a copy button. */
@Component({
  selector: 'app-reference-id',
  imports: [IconComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (referenceId(); as ref) {
      <span class="ref">
        <span>Reference <strong class="code">{{ ref }}</strong>@if (hint()) {<span class="hint"> · quote it if you contact support</span>}</span>
        <button type="button" class="copy" (click)="copy(ref)" [attr.aria-label]="copied() ? 'Reference copied' : 'Copy reference ' + ref">
          <app-icon [name]="copied() ? 'check' : 'copy'" [size]="16" />
        </button>
        <span class="sr-only" aria-live="polite">{{ copied() ? 'Copied' : '' }}</span>
      </span>
    }
  `,
  styles: `
    .ref {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      flex-wrap: wrap;
      font-size: 0.875rem;
      color: var(--muted);
    }
    .code {
      font-family: 'JetBrains Mono', Consolas, monospace;
      color: var(--ink);
      letter-spacing: 0.04em;
    }
    .copy {
      display: inline-grid;
      place-items: center;
      width: 44px;
      height: 44px;
      margin: -12px -8px -12px -4px;
      border: 0;
      background: none;
      color: var(--muted);
      border-radius: 10px;
      cursor: pointer;
      &:hover {
        color: var(--primary-ink);
      }
    }
  `,
})
export class ReferenceIdComponent {
  readonly referenceId = input<string | null | undefined>(null);
  readonly hint = input(true);
  readonly copied = signal(false);

  copy(ref: string): void {
    void navigator.clipboard?.writeText(ref).catch(() => undefined);
    this.copied.set(true);
    setTimeout(() => this.copied.set(false), 2000);
  }
}
