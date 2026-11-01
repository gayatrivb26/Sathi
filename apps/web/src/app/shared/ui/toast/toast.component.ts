import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { MAT_SNACK_BAR_DATA, MatSnackBarRef } from '@angular/material/snack-bar';
import { IconComponent } from '../icon/icon.component';
import { IconName } from '../icon/icons';

export interface ToastData {
  kind: 'error' | 'success' | 'info';
  message: string;
  referenceId: string | null;
}

@Component({
  selector: 'app-toast',
  imports: [IconComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="toast" [class]="data.kind">
      <app-icon [name]="icon" [size]="20" />
      <div class="body">
        <p>{{ data.message }}</p>
        @if (data.referenceId) {
          <p class="ref">Reference <strong>{{ data.referenceId }}</strong> · quote it if you contact support</p>
        }
      </div>
      <button type="button" class="close" (click)="ref.dismiss()" aria-label="Dismiss notification">✕</button>
    </div>
  `,
  styles: `
    .toast {
      display: flex;
      align-items: flex-start;
      gap: 12px;
      color: #fff;
    }
    app-icon {
      margin-top: 2px;
    }
    .error app-icon {
      color: #ffb4a9;
    }
    .success app-icon {
      color: #7ee2c4;
    }
    .info app-icon {
      color: #c9c4ff;
    }
    .body {
      flex: 1;
      font-size: 0.9375rem;
    }
    .ref {
      margin-top: 4px;
      font-size: 0.8125rem;
      opacity: 0.85;
      strong {
        font-family: Consolas, monospace;
        letter-spacing: 0.04em;
      }
    }
    .close {
      width: 44px;
      height: 44px;
      margin: -10px -10px -10px 0;
      border: 0;
      background: none;
      color: #fff;
      cursor: pointer;
      border-radius: 10px;
      font-size: 1rem;
    }
  `,
})
export class ToastComponent {
  readonly data = inject<ToastData>(MAT_SNACK_BAR_DATA);
  readonly ref = inject(MatSnackBarRef);
  readonly icon: IconName = this.data.kind === 'error' ? 'alert' : this.data.kind === 'success' ? 'check-circle' : 'info';
}
