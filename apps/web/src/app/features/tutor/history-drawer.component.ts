import { A11yModule } from '@angular/cdk/a11y';
import { DatePipe } from '@angular/common';
import { ChangeDetectionStrategy, Component, inject, input, output, signal } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatDialog } from '@angular/material/dialog';
import { TutorApi } from '../../core/api/tutor.api';
import { ApiError, toApiError } from '../../core/http/api-error';
import { createLoader } from '../../core/platform/loader';
import { confirmDialog } from '../../shared/ui/dialog/confirm-dialog.component';
import { IconComponent } from '../../shared/ui/icon/icon.component';
import { EmptyStateComponent } from '../../shared/ui/states/empty-state.component';
import { ErrorStateComponent } from '../../shared/ui/states/error-state.component';
import { SkeletonComponent } from '../../shared/ui/states/skeleton.component';

/** Slide-over list of past conversations. Focus is trapped while open; Esc closes. */
@Component({
  selector: 'app-history-drawer',
  imports: [A11yModule, DatePipe, MatButtonModule, IconComponent, SkeletonComponent, ErrorStateComponent, EmptyStateComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { '(document:keydown.escape)': 'closed.emit()' },
  template: `
    <div class="scrim" (click)="closed.emit()" aria-hidden="true"></div>
    <aside class="drawer" role="dialog" aria-modal="true" aria-labelledby="hist-h" cdkTrapFocus [cdkTrapFocusAutoCapture]="true">
      <header>
        <h2 id="hist-h">Your conversations</h2>
        <button type="button" class="x" (click)="closed.emit()" aria-label="Close conversations"><app-icon name="x" [size]="20" /></button>
      </header>
      <button matButton="filled" type="button" class="new" (click)="newChat.emit()"><app-icon name="plus" [size]="18" /> New conversation</button>
      @switch (list.status()) {
        @case ('loading') { <app-skeleton [lines]="5" [heading]="false" [card]="false" /> }
        @case ('error') { <app-error-state [error]="list.error()" [compact]="true" title="We couldn’t load your history" (retry)="list.load()" /> }
        @default {
          <ul class="items">
            @for (c of list.data()?.items ?? []; track c.id) {
              <li [class.current]="c.id === currentId()">
                <button type="button" class="open" (click)="pick.emit(c.id)" [attr.aria-current]="c.id === currentId() ? 'true' : null">
                  <span class="t">{{ c.title }}</span>
                  <span class="p">{{ c.lastMessagePreview }}</span>
                  <span class="d">{{ c.updatedAt | date: 'd MMM, HH:mm' }}</span>
                </button>
                <button type="button" class="del" (click)="remove(c.id, c.title)" [attr.aria-label]="'Delete conversation: ' + c.title"><app-icon name="trash" [size]="17" /></button>
              </li>
            } @empty {
              <app-empty-state [plain]="true" icon="tutor" title="No conversations yet" text="Ask your first question — it’ll be saved here." />
            }
          </ul>
          @if (moreError(); as e) {
            <app-error-state [error]="e" [compact]="true" title="We couldn’t load more conversations" (retry)="loadMore()" />
          } @else if (list.data()?.nextCursor) {
            <button matButton="outlined" type="button" class="more" (click)="loadMore()" [disabled]="loadingMore()">
              @if (loadingMore()) { <app-icon name="loader" [size]="16" class="spin" /> Loading… } @else { Load older conversations }
            </button>
          } @else if ((list.data()?.items?.length ?? 0) > 0) {
            <p class="end muted small">That’s everything.</p>
          }
          <p class="sr-only" role="status">{{ moreStatus() }}</p>
        }
      }
    </aside>
  `,
  styles: `
    .scrim {
      position: fixed;
      inset: 0;
      background: rgba(10, 14, 28, 0.45);
      z-index: 90;
      animation: fade 0.15s ease;
    }
    .drawer {
      position: fixed;
      top: 0;
      bottom: 0;
      right: 0;
      width: min(400px, 100vw);
      z-index: 91;
      display: flex;
      flex-direction: column;
      gap: 14px;
      padding: 20px;
      background: var(--surface);
      box-shadow: var(--shadow-pop);
      overflow-y: auto;
      animation: slide 0.2s ease;
    }
    header {
      display: flex;
      align-items: center;
      justify-content: space-between;
    }
    .x,
    .del {
      display: grid;
      place-items: center;
      width: 44px;
      height: 44px;
      border: 0;
      border-radius: 12px;
      background: none;
      color: var(--muted);
      cursor: pointer;
      &:hover {
        background: var(--surface-3);
        color: var(--ink);
      }
    }
    .new,
    .more {
      width: 100%;
      flex: none;
    }
    .end {
      text-align: center;
    }
    .items {
      list-style: none;
      margin: 0;
      padding: 0;
      display: flex;
      flex-direction: column;
      gap: 4px;
    }
    li {
      display: flex;
      align-items: center;
      border-radius: 14px;
      &:hover,
      &.current {
        background: var(--surface-2);
      }
      &.current {
        box-shadow: inset 3px 0 0 var(--primary);
      }
    }
    .open {
      flex: 1;
      min-width: 0;
      display: flex;
      flex-direction: column;
      gap: 2px;
      padding: 10px 12px;
      border: 0;
      background: none;
      text-align: left;
      cursor: pointer;
      border-radius: 14px;
    }
    .t {
      font-weight: 700;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .p {
      font-size: 0.85rem;
      color: var(--muted);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .d {
      font-size: 0.75rem;
      color: var(--muted);
    }
    @keyframes slide {
      from {
        transform: translateX(30px);
        opacity: 0;
      }
    }
    @keyframes fade {
      from {
        opacity: 0;
      }
    }
  `,
})
export class HistoryDrawerComponent {
  private readonly api = inject(TutorApi);
  private readonly dialog = inject(MatDialog);
  readonly courseId = input<string | null>(null);
  readonly currentId = input<string | null>(null);
  readonly closed = output<void>();
  readonly pick = output<string>();
  readonly newChat = output<void>();
  readonly deleted = output<string>();

  readonly list = createLoader(() => this.api.conversations(this.courseId()));
  readonly loadingMore = signal(false);
  readonly moreError = signal<ApiError | null>(null);
  readonly moreStatus = signal('');

  /** Cursor paging (§11.5): appends the next page of 20. */
  loadMore(): void {
    const cursor = this.list.data()?.nextCursor;
    if (!cursor || this.loadingMore()) return;
    this.loadingMore.set(true);
    this.moreError.set(null);
    this.api.conversations(this.courseId(), cursor).subscribe({
      next: (page) => {
        const known = new Set((this.list.data()?.items ?? []).map((c) => c.id));
        const fresh = page.items.filter((c) => !known.has(c.id));
        this.list.update((p) => ({ items: [...p.items, ...fresh], nextCursor: page.nextCursor }));
        this.moreStatus.set(`Loaded ${fresh.length} more conversation${fresh.length === 1 ? '' : 's'}.`);
        this.loadingMore.set(false);
      },
      error: (e: unknown) => {
        this.moreError.set(toApiError(e));
        this.loadingMore.set(false);
      },
    });
  }

  remove(id: string, title: string): void {
    confirmDialog(this.dialog, { title: 'Delete this conversation?', message: `“${title}” will be removed from your history. This can’t be undone.`, confirmText: 'Delete', danger: true }).subscribe((ok) => {
      if (!ok) return;
      this.api.delete(id).subscribe(() => {
        this.list.update((p) => ({ ...p, items: p.items.filter((x) => x.id !== id) }));
        this.deleted.emit(id);
      });
    });
  }
}
