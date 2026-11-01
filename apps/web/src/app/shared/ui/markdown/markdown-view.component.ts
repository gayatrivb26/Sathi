import { ChangeDetectionStrategy, Component, computed, inject, input, output } from '@angular/core';
import { DomSanitizer, SafeHtml } from '@angular/platform-browser';
import { MarkdownService } from '../../../core/markdown/markdown.service';
import { Citation } from '../../../core/models/api.models';

/**
 * Renders Markdown + KaTeX + citation chips. HTML is sanitised by DOMPurify in MarkdownService
 * before it is trusted here (Angular's sanitiser would strip KaTeX's inline styles).
 */
@Component({
  selector: 'app-markdown',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `<div class="prose" [class.streaming]="streaming()" [innerHTML]="html()"></div>`,
  host: { '(click)': 'onClick($event)' },
  styles: `
    :host {
      display: block;
    }
    .streaming > :last-child::after {
      content: '';
      display: inline-block;
      width: 0.55em;
      height: 1.1em;
      margin-left: 3px;
      vertical-align: -0.18em;
      background: var(--primary);
      border-radius: 2px;
      animation: blink 1s steps(2, start) infinite;
    }
    .streaming:empty::after {
      content: '';
      display: inline-block;
      width: 0.55em;
      height: 1.1em;
      background: var(--primary);
      border-radius: 2px;
      animation: blink 1s steps(2, start) infinite;
    }
    @keyframes blink {
      to {
        visibility: hidden;
      }
    }
  `,
})
export class MarkdownViewComponent {
  private readonly md = inject(MarkdownService);
  private readonly sanitizer = inject(DomSanitizer);

  readonly markdown = input<string>('');
  readonly citations = input<Citation[] | 'any' | false>(false);
  readonly streaming = input(false);
  readonly citeClick = output<number>();

  readonly html = computed<SafeHtml>(() =>
    this.sanitizer.bypassSecurityTrustHtml(this.md.render(this.markdown(), { citations: this.citations() })),
  );

  onClick(ev: MouseEvent): void {
    const target = (ev.target as HTMLElement | null)?.closest<HTMLElement>('[data-cite]');
    if (!target) return;
    ev.preventDefault();
    this.citeClick.emit(Number(target.dataset['cite']));
  }
}
