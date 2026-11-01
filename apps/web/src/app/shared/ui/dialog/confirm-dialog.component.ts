import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MAT_DIALOG_DATA, MatDialog, MatDialogModule } from '@angular/material/dialog';
import { Observable } from 'rxjs';

export interface ConfirmData {
  title: string;
  message: string;
  confirmText: string;
  cancelText?: string;
  danger?: boolean;
}

@Component({
  selector: 'app-confirm-dialog',
  imports: [MatDialogModule, MatButtonModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <h2 mat-dialog-title>{{ data.title }}</h2>
    <mat-dialog-content>
      <p>{{ data.message }}</p>
    </mat-dialog-content>
    <mat-dialog-actions align="end">
      <button matButton="text" type="button" [mat-dialog-close]="false" cdkFocusInitial>{{ data.cancelText ?? 'Cancel' }}</button>
      <button matButton="filled" type="button" [class.btn-danger]="data.danger" [mat-dialog-close]="true">{{ data.confirmText }}</button>
    </mat-dialog-actions>
  `,
})
export class ConfirmDialogComponent {
  readonly data = inject<ConfirmData>(MAT_DIALOG_DATA);
}

export function confirmDialog(dialog: MatDialog, data: ConfirmData): Observable<boolean | undefined> {
  return dialog.open<ConfirmDialogComponent, ConfirmData, boolean>(ConfirmDialogComponent, { data, width: '440px', maxWidth: 'calc(100vw - 32px)' }).afterClosed();
}
