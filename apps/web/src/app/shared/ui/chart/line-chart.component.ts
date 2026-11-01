import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';

export interface ChartPoint {
  label: string; // x-axis label (e.g. "12 Oct")
  value: number; // 0..1
}

/** Lightweight SVG line chart for 0..1 values, with an accessible data table alternative. */
@Component({
  selector: 'app-line-chart',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <figure class="chart">
      <svg [attr.viewBox]="'0 0 ' + W + ' ' + H" role="img" [attr.aria-label]="summary()">
        <defs>
          <linearGradient [attr.id]="gradId" x1="0" x2="0" y1="0" y2="1">
            <stop offset="0%" stop-color="var(--primary)" stop-opacity="0.28" />
            <stop offset="100%" stop-color="var(--primary)" stop-opacity="0" />
          </linearGradient>
        </defs>
        @for (g of grid; track g) {
          <line [attr.x1]="PAD_L" [attr.x2]="W - PAD_R" [attr.y1]="y(g)" [attr.y2]="y(g)" class="grid" />
          <text [attr.x]="PAD_L - 8" [attr.y]="y(g) + 4" class="axis" text-anchor="end">{{ g * 100 }}%</text>
        }
        @if (points().length > 1) {
          <path [attr.d]="area()" [attr.fill]="'url(#' + gradId + ')'" />
          <path [attr.d]="line()" class="line" />
        }
        @for (p of coords(); track $index) {
          <circle [attr.cx]="p.x" [attr.cy]="p.y" r="4" class="dot" />
          @if (showLabel($index)) {
            <text [attr.x]="p.x" [attr.y]="H - 6" class="axis" text-anchor="middle">{{ p.label }}</text>
          }
        }
      </svg>
      <figcaption class="sr-only">
        <table>
          <caption>{{ caption() }}</caption>
          <thead><tr><th scope="col">Date</th><th scope="col">Value</th></tr></thead>
          <tbody>
            @for (p of points(); track $index) {
              <tr><td>{{ p.label }}</td><td>{{ round(p.value) }}%</td></tr>
            }
          </tbody>
        </table>
      </figcaption>
    </figure>
  `,
  styles: `
    .chart {
      margin: 0;
    }
    svg {
      width: 100%;
      height: auto;
      overflow: visible;
    }
    .grid {
      stroke: var(--border);
      stroke-width: 1;
      vector-effect: non-scaling-stroke;
    }
    .axis {
      fill: var(--muted);
      font-size: 11px;
      font-family: var(--font-body);
    }
    .line {
      fill: none;
      stroke: var(--primary);
      stroke-width: 3;
      stroke-linejoin: round;
      stroke-linecap: round;
      vector-effect: non-scaling-stroke;
    }
    .dot {
      fill: var(--surface);
      stroke: var(--primary);
      stroke-width: 2.5;
      vector-effect: non-scaling-stroke;
    }
  `,
})
export class LineChartComponent {
  readonly points = input<ChartPoint[]>([]);
  readonly caption = input('Average mastery over time');

  readonly W = 640;
  readonly H = 220;
  readonly PAD_L = 44;
  readonly PAD_R = 12;
  readonly PAD_T = 12;
  readonly PAD_B = 28;
  readonly grid = [0, 0.25, 0.5, 0.75, 1];
  readonly gradId = `lc-grad-${Math.random().toString(36).slice(2, 8)}`;

  y(v: number): number {
    return this.PAD_T + (1 - v) * (this.H - this.PAD_T - this.PAD_B);
  }

  readonly coords = computed(() => {
    const pts = this.points();
    const n = Math.max(pts.length - 1, 1);
    const span = this.W - this.PAD_L - this.PAD_R;
    return pts.map((p, i) => ({ x: this.PAD_L + (pts.length === 1 ? span / 2 : (i / n) * span), y: this.y(p.value), label: p.label }));
  });
  readonly line = computed(() => this.coords().map((c, i) => `${i ? 'L' : 'M'}${c.x.toFixed(1)},${c.y.toFixed(1)}`).join(' '));
  readonly area = computed(() => {
    const c = this.coords();
    if (!c.length) return '';
    const base = this.y(0);
    return `${this.line()} L${c[c.length - 1].x.toFixed(1)},${base} L${c[0].x.toFixed(1)},${base} Z`;
  });
  readonly summary = computed(() => {
    const p = this.points();
    if (!p.length) return `${this.caption()}: no data yet`;
    return `${this.caption()}: from ${this.round(p[0].value)}% on ${p[0].label} to ${this.round(p[p.length - 1].value)}% on ${p[p.length - 1].label}`;
  });

  showLabel(i: number): boolean {
    const n = this.points().length;
    const step = Math.ceil(n / 6);
    return i % step === 0 || i === n - 1;
  }

  round(v: number): number {
    return Math.round(v * 100);
  }
}
