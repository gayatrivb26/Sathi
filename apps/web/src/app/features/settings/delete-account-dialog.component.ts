import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatDialogModule, MatDialogRef } from '@angular/material/dialog';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { Router } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import { AuthApi } from '../../core/api/auth.api';
import { AuthStore } from '../../core/auth/auth.store';
import { ApiError, toApiError } from '../../core/http/api-error';
import { ReferenceIdComponent } from '../../shared/ui/reference-id/reference-id.component';

/** DELETE /me with password confirmation (contracts.md §5.1). */
@Component({
  selector: 'app-delete-account-dialog',
  imports: [FormsModule, MatDialogModule, MatButtonModule, MatFormFieldModule, MatInputModule, ReferenceIdComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <h2 mat-dialog-title>Delete your account?</h2>
    <form (ngSubmit)="confirm()">
      <mat-dialog-content>
        <p>This permanently deletes your profile, conversations, uploaded notes and progress. Type your password to confirm.</p>
        <mat-form-field class="full">
          <mat-label>Password</mat-label>
          <input matInput type="password" name="password" [(ngModel)]="password" autocomplete="current-password" required cdkFocusInitial />
        </mat-form-field>
        @if (error(); as e) {
          <p class="err" role="alert">{{ e.code === 'AUTH_INVALID_CREDENTIALS' ? 'That password isn’t right.' : e.userMessage }}</p>
          @if (e.status >= 500 || e.status === 0) { <app-reference-id [referenceId]="e.referenceId" /> }
        }
      </mat-dialog-content>
      <mat-dialog-actions align="end">
        <button matButton="text" type="button" mat-dialog-close>Cancel</button>
        <button matButton="filled" class="btn-danger" type="submit" [disabled]="!password || busy()">{{ busy() ? 'Deleting…' : 'Delete everything' }}</button>
      </mat-dialog-actions>
    </form>
  `,
  styles: `
    .err {
      color: var(--danger);
      font-weight: 600;
    }
  `,
})
export class DeleteAccountDialogComponent {
  private readonly api = inject(AuthApi);
  private readonly auth = inject(AuthStore);
  private readonly router = inject(Router);
  private readonly ref = inject(MatDialogRef<DeleteAccountDialogComponent>);
  password = '';
  readonly busy = signal(false);
  readonly error = signal<ApiError | null>(null);

  async confirm(): Promise<void> {
    if (!this.password) return;
    this.busy.set(true);
    this.error.set(null);
    try {
      await firstValueFrom(this.api.deleteMe(this.password));
      this.ref.close(true);
      this.auth.set(null);
      await firstValueFrom(this.api.csrf()).catch(() => undefined);
      await this.router.navigate(['/auth/sign-in'], { queryParams: { deleted: '1' } });
    } catch (e) {
      this.error.set(toApiError(e));
    } finally {
      this.busy.set(false);
    }
  }
}
