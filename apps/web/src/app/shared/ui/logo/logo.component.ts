import { ChangeDetectionStrategy, Component, input } from '@angular/core';

/** Sathi wordmark: two companion circles ("sathi" = companion) + name. */
@Component({
  selector: 'app-logo',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <span class="logo" [class.on-dark]="onDark()">
      <svg viewBox="0 0 32 32" width="30" height="30" aria-hidden="true" focusable="false">
        <rect width="32" height="32" rx="10" fill="#4B3FE4" />
        <circle cx="13" cy="16" r="7" fill="none" stroke="#fff" stroke-width="2.6" />
        <circle cx="20" cy="16" r="7" fill="#FFB547" fill-opacity="0.95" />
        <path d="M16.5 10.2a7 7 0 0 1 0 11.6a7 7 0 0 1 0-11.6z" fill="#12192B" fill-opacity="0.18" />
      </svg>
      @if (showName()) {
        <span class="name">Sathi</span>
      }
    </span>
  `,
  styles: `
    .logo {
      display: inline-flex;
      align-items: center;
      gap: 10px;
      font-family: var(--font-head);
      font-weight: 700;
      font-size: 1.3rem;
      letter-spacing: -0.01em;
      color: var(--ink);
    }
    .on-dark {
      color: #fff;
    }
  `,
})
export class LogoComponent {
  readonly onDark = input(false);
  readonly showName = input(true);
}
