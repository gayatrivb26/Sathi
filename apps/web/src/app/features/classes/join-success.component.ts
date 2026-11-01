import { ChangeDetectionStrategy, Component, inject, input, signal } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { Router } from '@angular/router';
import { AuthStore } from '../../core/auth/auth.store';
import { JoinClassResult } from '../../core/models/api.models';
import { IconComponent } from '../../shared/ui/icon/icon.component';

/** "You're in" after joining by code or invite: switch to the course, or go to onboarding if new. */
@Component({
  selector: 'app-join-success',
  imports: [MatButtonModule, IconComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="card done" role="status" aria-live="polite">
      <span class="badge" aria-hidden="true"><app-icon name="check-circle" [size]="30" /></span>
      <h1 tabindex="-1" id="join-done-h">You’ve joined {{ result().className }}</h1>
      <p class="lede">You now have access to <strong>{{ result().course.title }}</strong>. Your teacher can see your progress in this class.</p>
      <div class="actions">
        <button matButton="filled" type="button" (click)="start()" [disabled]="busy()">
          {{ busy() ? 'Opening…' : auth.needsOnboarding() ? 'Set up and start learning' : 'Start learning' }} <app-icon name="arrow-right" [size]="18" />
        </button>
      </div>
    </div>
  `,
  styles: `
    .done {
      display: flex;
      flex-direction: column;
      align-items: flex-start;
      gap: 10px;
      padding: 28px;
    }
    .badge {
      display: grid;
      place-items: center;
      width: 60px;
      height: 60px;
      border-radius: 20px;
      background: var(--mint-soft);
      color: var(--mint-ink);
    }
    h1 {
      font-size: 1.5rem;
      outline: none;
    }
    .lede {
      color: var(--muted);
    }
    .actions {
      margin-top: 8px;
    }
  `,
})
export class JoinSuccessComponent {
  readonly auth = inject(AuthStore);
  private readonly router = inject(Router);
  readonly result = input.required<JoinClassResult>();
  readonly busy = signal(false);

  constructor() {
    setTimeout(() => document.getElementById('join-done-h')?.focus());
  }

  async start(): Promise<void> {
    this.busy.set(true);
    try {
      const me = await this.auth.refresh();
      if (this.auth.needsOnboarding()) {
        await this.router.navigate(['/onboarding']);
        return;
      }
      if (me && me.preferences.activeCourseId !== this.result().course.id) {
        await this.auth.updatePreferences({ activeCourseId: this.result().course.id }).catch(() => undefined);
      }
      await this.router.navigate(['/home']);
    } finally {
      this.busy.set(false);
    }
  }
}
