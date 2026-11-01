import { inject, Injectable } from '@angular/core';
import { MatSnackBar } from '@angular/material/snack-bar';
import { ApiError } from '../http/api-error';
import { ToastComponent, ToastData } from '../../shared/ui/toast/toast.component';

/** Friendly toasts. Errors always carry their reference ID. */
@Injectable({ providedIn: 'root' })
export class Notifier {
  private readonly snack = inject(MatSnackBar);

  error(err: ApiError | string, referenceId?: string | null): void {
    const data: ToastData =
      typeof err === 'string'
        ? { kind: 'error', message: err, referenceId: referenceId ?? null }
        : { kind: 'error', message: err.userMessage, referenceId: err.referenceId };
    this.snack.openFromComponent(ToastComponent, {
      data,
      duration: 8000,
      politeness: 'assertive',
      panelClass: 'sathi-toast-panel',
    });
  }

  success(message: string): void {
    this.snack.openFromComponent(ToastComponent, {
      data: { kind: 'success', message, referenceId: null } satisfies ToastData,
      duration: 4000,
      politeness: 'polite',
      panelClass: 'sathi-toast-panel',
    });
  }

  info(message: string): void {
    this.snack.openFromComponent(ToastComponent, {
      data: { kind: 'info', message, referenceId: null } satisfies ToastData,
      duration: 4000,
      politeness: 'polite',
      panelClass: 'sathi-toast-panel',
    });
  }
}
