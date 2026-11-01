import { DatePipe, DecimalPipe, JsonPipe, KeyValuePipe } from '@angular/common';
import { ChangeDetectionStrategy, Component, computed, effect, inject, input, signal, untracked } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { Router } from '@angular/router';
import { AdminApi } from '../../core/api/staff.api';
import { ApiError, toApiError } from '../../core/http/api-error';
import { normaliseReferenceId } from '../../core/http/trace';
import { AiRunDetail } from '../../core/models/api.models';
import { IconComponent } from '../../shared/ui/icon/icon.component';
import { ErrorStateComponent } from '../../shared/ui/states/error-state.component';
import { SkeletonComponent } from '../../shared/ui/states/skeleton.component';

export function durationMs(start: string | null, end: string | null): number | null {
  if (!start || !end) return null;
  return Math.max(0, Date.parse(end) - Date.parse(start));
}
export function formatMs(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return '—';
  if (ms < 1000) return `${ms} ms`;
  return `${(ms / 1000).toFixed(ms < 10_000 ? 2 : 1)} s`;
}

@Component({
  selector: 'app-run-lookup',
  imports: [DatePipe, DecimalPipe, JsonPipe, KeyValuePipe, FormsModule, MatButtonModule, MatFormFieldModule, MatInputModule, IconComponent, ErrorStateComponent, SkeletonComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './run-lookup.component.html',
  styleUrl: './run-lookup.component.scss',
})
export default class RunLookupComponent {
  private readonly api = inject(AdminApi);
  private readonly router = inject(Router);
  readonly ref = input<string>('');

  query = '';
  readonly loading = signal(false);
  readonly detail = signal<AiRunDetail | null>(null);
  readonly error = signal<ApiError | null>(null);
  readonly formatMs = formatMs;

  readonly totalMs = computed(() => {
    const d = this.detail();
    return d ? (d.run.latencyMs ?? durationMs(d.run.startedAt, d.run.finishedAt)) : null;
  });

  constructor() {
    effect(() => {
      const r = this.ref();
      untracked(() => {
        this.query = r ? normaliseReferenceId(decodeURIComponent(r)) : '';
        if (r) this.fetch(this.query);
        else {
          this.detail.set(null);
          this.error.set(null);
        }
      });
    });
  }

  search(): void {
    const q = normaliseReferenceId(this.query);
    if (!q) return;
    void this.router.navigate(['/admin/lookup', q]);
  }

  private fetch(id: string): void {
    this.loading.set(true);
    this.error.set(null);
    this.detail.set(null);
    this.api.lookup(id).subscribe({
      next: (d) => {
        this.detail.set(d);
        this.loading.set(false);
      },
      error: (e: unknown) => {
        this.error.set(toApiError(e));
        this.loading.set(false);
      },
    });
  }

  retry(): void {
    if (this.query) this.fetch(normaliseReferenceId(this.query));
  }

  stepDuration(s: { startedAt: string; endedAt: string }): string {
    return formatMs(durationMs(s.startedAt, s.endedAt));
  }
  stepWidth(s: { startedAt: string; endedAt: string }): number {
    const total = this.totalMs() || 1;
    return Math.max(2, Math.min(100, ((durationMs(s.startedAt, s.endedAt) ?? 0) / total) * 100));
  }
  stepOffset(s: { startedAt: string }): number {
    const d = this.detail();
    const total = this.totalMs() || 1;
    if (!d) return 0;
    return Math.max(0, Math.min(98, ((Date.parse(s.startedAt) - Date.parse(d.run.startedAt)) / total) * 100));
  }
  isPrimitive(v: unknown): boolean {
    return v === null || ['string', 'number', 'boolean'].includes(typeof v);
  }
  copy(text: string): void {
    void navigator.clipboard?.writeText(text).catch(() => undefined);
  }
}
