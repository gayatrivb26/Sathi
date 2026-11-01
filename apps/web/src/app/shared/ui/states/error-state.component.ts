import { ChangeDetectionStrategy, Component, computed, inject, input, output } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { ApiError } from '../../../core/http/api-error';
import { OnlineService } from '../../../core/platform/online.service';
import { IconComponent } from '../icon/icon.component';
import { ReferenceIdComponent } from '../reference-id/reference-id.component';

/** Inline error with a friendly message, the reference ID and Retry. Switches to an offline message. */
@Component({
  selector: 'app-error-state',
  imports: [MatButtonModule, IconComponent, ReferenceIdComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="err" role="alert" [class.compact]="compact()">
      <span class="badge" [class.off]="offline()"><app-icon [name]="offline() ? 'wifi-off' : 'alert'" [size]="22" /></span>
      <div class="text">
        <h2 class="title">{{ offline() ? 'You’re offline' : title() }}</h2>
        <p class="msg">{{ offline() ? 'Reconnect to the internet and try again. Nothing you did is lost.' : message() }}</p>
        @if (!offline()) {
          <app-reference-id [referenceId]="error()?.referenceId" />
        }
        @if (retryable()) {
          <div class="actions">
            <button matButton="outlined" type="button" (click)="retry.emit()"><app-icon name="refresh" [size]="18" /> Try again</button>
          </div>
        }
      </div>
    </div>
  `,
  styles: `
    .err {
      display: flex;
      gap: 16px;
      align-items: flex-start;
      padding: 22px;
      border-radius: var(--radius);
      background: var(--surface);
      border: 1px solid var(--border);
      box-shadow: var(--shadow-card);
    }
    .compact {
      padding: 14px 16px;
      box-shadow: none;
      background: var(--danger-soft);
      border-color: transparent;
    }
    .badge {
      display: grid;
      place-items: center;
      flex: none;
      width: 44px;
      height: 44px;
      border-radius: 14px;
      background: var(--danger-soft);
      color: var(--danger);
      &.off {
        background: var(--surface-3);
        color: var(--muted);
      }
    }
    .compact .badge {
      background: var(--surface);
      width: 36px;
      height: 36px;
    }
    .title {
      font-size: 1.05rem;
      margin-bottom: 4px;
    }
    .msg {
      color: var(--muted);
      margin-bottom: 4px;
    }
    .actions {
      margin-top: 12px;
    }
  `,
})
export class ErrorStateComponent {
  private readonly online = inject(OnlineService).online;
  readonly error = input<ApiError | null>(null);
  readonly title = input('We couldn’t load this');
  readonly compact = input(false);
  readonly retryable = input(true);
  readonly retry = output<void>();

  readonly offline = computed(() => !this.online() && (this.error()?.isNetwork ?? true));
  readonly message = computed(() => this.error()?.userMessage ?? 'Something went wrong on our side.');
}
