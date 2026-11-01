import { Directive, effect, ElementRef, inject, input } from '@angular/core';

export interface AutosizeMetrics {
  scrollHeight: number;
  lineHeight: number;
  paddingY: number;
  borderY: number;
  minRows: number;
  maxHeight: number;
}

/**
 * Height for an auto-growing textarea: at least `minRows` lines, grows with the content,
 * then stops at `maxHeight` and scrolls.
 */
export function autosizeHeight(m: AutosizeMetrics): { height: number; scroll: boolean } {
  const min = Math.round(m.minRows * m.lineHeight + m.paddingY + m.borderY);
  const content = Math.round(m.scrollHeight + m.borderY);
  const max = Math.max(min, m.maxHeight);
  return { height: Math.min(Math.max(content, min), max), scroll: content > max };
}

/**
 * `<textarea [appAutosize]="value">` — starts at `minRows` lines and grows up to `maxHeight` px.
 * Pass the bound value so programmatic changes (e.g. clearing after Send) resize it too.
 */
@Directive({
  selector: 'textarea[appAutosize]',
  host: { '(input)': 'resize()', '[attr.rows]': 'minRows()' },
})
export class AutosizeDirective {
  private readonly el = inject<ElementRef<HTMLTextAreaElement>>(ElementRef).nativeElement;
  readonly value = input<string | null | undefined>('', { alias: 'appAutosize' });
  readonly minRows = input(3);
  readonly maxHeight = input(220);

  constructor() {
    effect(() => {
      this.value();
      // ngModel writes the DOM value asynchronously; measure after it lands.
      setTimeout(() => this.resize());
    });
  }

  resize(): void {
    const el = this.el;
    const cs = getComputedStyle(el);
    const px = (v: string) => Number.parseFloat(v) || 0;
    const fontSize = px(cs.fontSize) || 16;
    const lineHeight = cs.lineHeight === 'normal' || !px(cs.lineHeight) ? fontSize * 1.45 : px(cs.lineHeight);
    el.style.height = 'auto';
    const { height, scroll } = autosizeHeight({
      scrollHeight: el.scrollHeight,
      lineHeight,
      paddingY: px(cs.paddingTop) + px(cs.paddingBottom),
      borderY: px(cs.borderTopWidth) + px(cs.borderBottomWidth),
      minRows: this.minRows(),
      maxHeight: this.maxHeight(),
    });
    el.style.height = `${height}px`;
    el.style.overflowY = scroll ? 'auto' : 'hidden';
  }
}
