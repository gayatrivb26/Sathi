import { DatePipe, DecimalPipe } from '@angular/common';
import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { AdminApi } from '../../core/api/staff.api';
import { createLoader } from '../../core/platform/loader';
import { ErrorStateComponent } from '../../shared/ui/states/error-state.component';
import { SkeletonComponent } from '../../shared/ui/states/skeleton.component';

@Component({
  selector: 'app-usage',
  imports: [DatePipe, DecimalPipe, SkeletonComponent, ErrorStateComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @switch (usage.status()) {
      @case ('loading') { <app-skeleton [lines]="6" /> }
      @case ('error') { <app-error-state [error]="usage.error()" title="We couldn’t load usage" (retry)="usage.load()" /> }
      @default {
        @if (usage.data(); as u) {
          <ul class="kpis" role="list">
            <li class="card"><span class="v num">{{ u.activeUsers }}</span><span class="l">Active users (7 days)</span></li>
            <li class="card"><span class="v num">{{ totals().chat | number }}</span><span class="l">Tutor messages</span></li>
            <li class="card"><span class="v num">{{ totals().web | number }}</span><span class="l">Web searches</span></li>
            <li class="card"><span class="v num">{{ '$' + (totals().cost | number: '1.2-2') }}</span><span class="l">Estimated LLM cost</span></li>
          </ul>
          <section class="card" aria-labelledby="daily-h">
            <h2 id="daily-h" class="card-title">Daily tutor messages</h2>
            <ol class="bars" aria-hidden="true">
              @for (d of u.days; track d.date) {
                <li><span class="bv num">{{ d.chatMessages }}</span><span class="b" [style.height.%]="(d.chatMessages / maxChat()) * 100"></span><span class="bl">{{ d.date | date: 'EEE' }}</span></li>
              }
            </ol>
            <div class="table-wrap">
              <table>
                <caption class="sr-only">Usage per day</caption>
                <thead><tr><th scope="col">Day</th><th scope="col">Messages</th><th scope="col">Web searches</th><th scope="col">Uploads</th><th scope="col">Tokens in / out</th><th scope="col">Cost</th></tr></thead>
                <tbody>
                  @for (d of u.days; track d.date) {
                    <tr>
                      <td>{{ d.date | date: 'EEE d MMM' }}</td>
                      <td class="num">{{ d.chatMessages }}</td>
                      <td class="num">{{ d.webSearches }}</td>
                      <td class="num">{{ d.uploads }}</td>
                      <td class="num">{{ d.inputTokens | number }} / {{ d.outputTokens | number }}</td>
                      <td class="num">{{ '$' + (d.costUsd | number: '1.2-2') }}</td>
                    </tr>
                  }
                </tbody>
              </table>
            </div>
          </section>
        }
      }
    }
  `,
  styles: `
    .kpis {
      list-style: none;
      margin: 0 0 22px;
      padding: 0;
      display: grid;
      grid-template-columns: repeat(4, minmax(0, 1fr));
      gap: 16px;
      @media (max-width: 899.98px) {
        grid-template-columns: repeat(2, minmax(0, 1fr));
      }
      li {
        display: flex;
        flex-direction: column;
        gap: 4px;
      }
    }
    .v {
      font-family: var(--font-head);
      font-size: 1.7rem;
      font-weight: 700;
    }
    .l {
      color: var(--muted);
      font-size: 0.875rem;
    }
    .bars {
      list-style: none;
      margin: 0 0 18px;
      padding: 0;
      display: flex;
      align-items: flex-end;
      gap: 12px;
      height: 160px;
      li {
        flex: 1;
        height: 100%;
        display: flex;
        flex-direction: column;
        justify-content: flex-end;
        align-items: center;
        gap: 6px;
      }
    }
    .b {
      width: 100%;
      max-width: 48px;
      border-radius: 8px 8px 0 0;
      background: linear-gradient(180deg, var(--primary), color-mix(in srgb, var(--primary) 70%, var(--surface)));
    }
    .bv {
      font-size: 0.75rem;
      font-weight: 700;
    }
    .bl {
      font-size: 0.75rem;
      color: var(--muted);
    }
    .table-wrap {
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
      padding: 8px 10px;
      border-bottom: 1px solid var(--border);
      white-space: nowrap;
    }
    td {
      padding: 8px 10px;
      border-bottom: 1px solid var(--border);
      white-space: nowrap;
    }
  `,
})
export default class UsageComponent {
  private readonly api = inject(AdminApi);
  readonly usage = createLoader(() => this.api.usage(7));
  readonly totals = computed(() => {
    const days = this.usage.data()?.days ?? [];
    return days.reduce((t, d) => ({ chat: t.chat + d.chatMessages, web: t.web + d.webSearches, cost: t.cost + d.costUsd }), { chat: 0, web: 0, cost: 0 });
  });
  readonly maxChat = computed(() => Math.max(1, ...(this.usage.data()?.days ?? []).map((d) => d.chatMessages)));
}
