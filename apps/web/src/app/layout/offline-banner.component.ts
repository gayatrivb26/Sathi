import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { OnlineService } from '../core/platform/online.service';
import { IconComponent } from '../shared/ui/icon/icon.component';

@Component({
  selector: 'app-offline-banner',
  imports: [IconComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="wrap" role="status" aria-live="polite">
      @if (!online()) {
        <div class="banner">
          <app-icon name="wifi-off" [size]="18" />
          <span><strong>You’re offline.</strong> We’ll reconnect automatically. Things you’ve already opened stay readable.</span>
        </div>
      }
    </div>
  `,
  styles: `
    .banner {
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 10px var(--gutter);
      background: var(--amber-soft);
      color: var(--ink);
      border-bottom: 1px solid var(--amber-bar);
      font-size: 0.9rem;
      @media (max-width: 719.98px) {
        padding: 10px 16px;
      }
    }
    app-icon {
      color: var(--amber-ink);
    }
  `,
})
export class OfflineBannerComponent {
  readonly online = inject(OnlineService).online;
}
