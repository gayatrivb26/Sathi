import { DatePipe } from '@angular/common';
import { ChangeDetectionStrategy, Component, effect, inject, signal, untracked } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatSelectModule } from '@angular/material/select';
import { RouterLink } from '@angular/router';
import { AdminApi } from '../../core/api/staff.api';
import { createLoader } from '../../core/platform/loader';
import { EmptyStateComponent } from '../../shared/ui/states/empty-state.component';
import { ErrorStateComponent } from '../../shared/ui/states/error-state.component';
import { SkeletonComponent } from '../../shared/ui/states/skeleton.component';
import { formatMs } from './run-lookup.component';

@Component({
  selector: 'app-runs-list',
  imports: [DatePipe, RouterLink, MatButtonModule, MatFormFieldModule, MatSelectModule, SkeletonComponent, ErrorStateComponent, EmptyStateComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="filters">
      <mat-form-field subscriptSizing="dynamic">
        <mat-label>Status</mat-label>
        <mat-select [value]="status()" (valueChange)="status.set($event)">
          <mat-option value="failed">Failed</mat-option>
          <mat-option value="">All</mat-option>
          <mat-option value="succeeded">Succeeded</mat-option>
          <mat-option value="running">Running</mat-option>
        </mat-select>
      </mat-form-field>
      <mat-form-field subscriptSizing="dynamic">
        <mat-label>Type</mat-label>
        <mat-select [value]="type()" (valueChange)="type.set($event)">
          <mat-option value="">All types</mat-option>
          @for (t of types; track t) { <mat-option [value]="t">{{ t.replace('_', ' ') }}</mat-option> }
        </mat-select>
      </mat-form-field>
    </div>
    @switch (runs.status()) {
      @case ('loading') { <app-skeleton [lines]="6" /> }
      @case ('error') { <app-error-state [error]="runs.error()" title="We couldn’t load runs" (retry)="runs.load()" /> }
      @default {
        @if (runs.data()?.items?.length) {
          <div class="card table-card">
            <table>
              <caption class="sr-only">AI runs</caption>
              <thead><tr><th scope="col">Reference</th><th scope="col">Type</th><th scope="col">Status</th><th scope="col">Started</th><th scope="col">Latency</th><th scope="col">Error</th></tr></thead>
              <tbody>
                @for (r of runs.data()!.items; track r.id) {
                  <tr>
                    <td><a class="mono" [routerLink]="['/admin/lookup', r.referenceId]">{{ r.referenceId }}</a></td>
                    <td>{{ r.type.replace('_', ' ') }}</td>
                    <td><span class="st" [class]="r.status">{{ r.status }}</span></td>
                    <td>{{ r.startedAt | date: 'd MMM, HH:mm' }}</td>
                    <td class="num">{{ fmt(r.latencyMs) }}</td>
                    <td class="mono err">{{ r.errorCode ?? '—' }}</td>
                  </tr>
                }
              </tbody>
            </table>
          </div>
        } @else {
          <app-empty-state icon="check-circle" title="No runs match" text="Nothing has failed with these filters. Nice." />
        }
      }
    }
  `,
  styles: `
    .filters {
      display: flex;
      gap: 12px;
      flex-wrap: wrap;
      margin-bottom: 16px;
      mat-form-field {
        width: 200px;
      }
    }
    .table-card {
      padding: 6px 8px;
      overflow-x: auto;
    }
    table {
      width: 100%;
      border-collapse: collapse;
      font-size: 0.9rem;
    }
    th {
      text-align: left;
      color: var(--muted);
      font-size: 0.75rem;
      font-weight: 700;
      padding: 10px 12px;
      border-bottom: 1px solid var(--border);
    }
    td {
      padding: 10px 12px;
      border-bottom: 1px solid var(--border);
      white-space: nowrap;
    }
    tr:last-child td {
      border-bottom: 0;
    }
    .mono {
      font-family: 'JetBrains Mono', Consolas, monospace;
    }
    a.mono {
      display: inline-flex;
      align-items: center;
      min-height: 32px;
      font-weight: 700;
    }
    .st {
      font-weight: 700;
      text-transform: capitalize;
      &.failed {
        color: var(--danger);
      }
      &.succeeded {
        color: var(--mint-ink);
      }
    }
    .err {
      color: var(--danger);
    }
  `,
})
export default class RunsListComponent {
  private readonly api = inject(AdminApi);
  readonly types = ['chat', 'ingestion', 'quiz_generation', 'grading', 'revision_plan', 'evaluation'];
  readonly status = signal('failed');
  readonly type = signal('');
  readonly runs = createLoader(() => this.api.runs(this.status(), this.type()), { immediate: false });
  readonly fmt = formatMs;

  constructor() {
    effect(() => {
      this.status();
      this.type();
      untracked(() => this.runs.load());
    });
  }
}
