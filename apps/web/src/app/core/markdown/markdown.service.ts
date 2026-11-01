import { Injectable } from '@angular/core';
import DOMPurify from 'dompurify';
import katex from 'katex';
import { Marked } from 'marked';
import { Citation, SourceType } from '../models/api.models';

export interface RenderOptions {
  /**
   * How to treat `[n]` markers:
   * - `undefined`/`false`: leave as text (lessons).
   * - `'any'`: every marker becomes a chip (while streaming, before citation events arrive).
   * - `Citation[]`: only markers with a matching citation become chips; others stay text.
   */
  citations?: false | 'any' | Citation[];
}

const MATH_TOKEN = /%%MATH(\d+)%%/g;
const CITE_RE = /\[(\d{1,2}(?:\s*,\s*\d{1,2})*)\]/g;
const SKIP_TAGS = new Set(['CODE', 'PRE', 'A', 'BUTTON', 'SCRIPT', 'STYLE']);

const TYPE_LABEL: Record<SourceType, string> = { course: 'Course', upload: 'Your notes', web: 'Web' };

export function sourceTypeLabel(type: SourceType): string {
  return TYPE_LABEL[type];
}

export function domainOf(url: string | null): string {
  if (!url) return '';
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

/**
 * Extracts TeX (`$$…$$`, `\[…\]`, `$…$`, `\(…\)`) outside code spans/blocks and replaces it with
 * tokens, so Markdown can't mangle `_` and `*` inside formulas.
 */
export function extractMath(src: string): { text: string; math: { tex: string; display: boolean }[] } {
  const math: { tex: string; display: boolean }[] = [];
  // Split into code and non-code segments: fenced blocks, then inline code spans.
  const parts = src.split(/(```[\s\S]*?(?:```|$)|~~~[\s\S]*?(?:~~~|$)|`[^`\n]*`)/g);
  const out = parts.map((part, i) => {
    if (i % 2 === 1) return part; // code: untouched
    let s = part.replace(/\$\$([\s\S]+?)\$\$|\\\[([\s\S]+?)\\\]/g, (_m, a: string | undefined, b: string | undefined) => {
      math.push({ tex: (a ?? b ?? '').trim(), display: true });
      return `\n\n%%MATH${math.length - 1}%%\n\n`;
    });
    s = s.replace(/\\\((.+?)\\\)|(^|[^\\$\w])\$(?!\s)([^$\n]+?)(?<!\s)\$(?![\w$])/g, (_m, paren: string | undefined, pre: string | undefined, dollar: string | undefined) => {
      if (paren !== undefined) {
        math.push({ tex: paren, display: false });
        return `%%MATH${math.length - 1}%%`;
      }
      math.push({ tex: dollar ?? '', display: false });
      return `${pre ?? ''}%%MATH${math.length - 1}%%`;
    });
    return s;
  });
  return { text: out.join(''), math };
}

function renderTex(tex: string, display: boolean): string {
  return katex.renderToString(tex, {
    displayMode: display,
    throwOnError: false,
    output: 'htmlAndMathml',
    trust: false,
    strict: 'ignore',
  });
}

/** Markdown → sanitised HTML with KaTeX math and accessible citation chips. */
@Injectable({ providedIn: 'root' })
export class MarkdownService {
  private readonly marked = new Marked({ gfm: true, breaks: false, async: false });

  render(markdown: string, options: RenderOptions = {}): string {
    const { text, math } = extractMath(markdown ?? '');
    const rawHtml = this.marked.parse(text, { async: false }) as string;
    const fragment = DOMPurify.sanitize(rawHtml, {
      USE_PROFILES: { html: true },
      FORBID_TAGS: ['style', 'form', 'input', 'button', 'textarea', 'select', 'iframe', 'object', 'embed'],
      FORBID_ATTR: ['style', 'class', 'id'],
      RETURN_DOM_FRAGMENT: true,
    }) as DocumentFragment;

    const container = document.createElement('div');
    container.appendChild(fragment);
    this.decorateLinks(container);
    this.walkText(container, (node) => this.replaceTokens(node, math, options));
    return container.innerHTML;
  }

  private decorateLinks(root: HTMLElement): void {
    root.querySelectorAll('a[href]').forEach((a) => {
      const href = a.getAttribute('href') ?? '';
      if (/^https?:\/\//i.test(href)) {
        a.setAttribute('target', '_blank');
        a.setAttribute('rel', 'noopener noreferrer');
      }
    });
  }

  private walkText(root: Node, visit: (n: Text) => void): void {
    const texts: Text[] = [];
    const walk = (node: Node) => {
      for (const child of Array.from(node.childNodes)) {
        if (child.nodeType === Node.TEXT_NODE) texts.push(child as Text);
        else if (child.nodeType === Node.ELEMENT_NODE && !SKIP_TAGS.has((child as Element).tagName)) walk(child);
      }
    };
    walk(root);
    texts.forEach(visit);
  }

  private replaceTokens(node: Text, math: { tex: string; display: boolean }[], options: RenderOptions): void {
    const value = node.nodeValue ?? '';
    const wantCites = !!options.citations;
    if (!value.includes('%%MATH') && !(wantCites && value.includes('['))) return;

    const pattern = new RegExp(`${MATH_TOKEN.source}|${CITE_RE.source}`, 'g');
    const frag = document.createDocumentFragment();
    let last = 0;
    let changed = false;
    for (const m of value.matchAll(pattern)) {
      const idx = m.index ?? 0;
      if (m[1] !== undefined) {
        const item = math[Number(m[1])];
        if (!item) continue;
        frag.append(value.slice(last, idx));
        // Always a <span> (KaTeX output is spans) so it stays valid inside <p>; CSS makes display math a block.
        const holder = document.createElement('span');
        holder.className = item.display ? 'math-display' : 'math-inline';
        holder.innerHTML = renderTex(item.tex, item.display); // KaTeX output (trust: false) — safe
        frag.append(holder);
        last = idx + m[0].length;
        changed = true;
      } else if (m[2] !== undefined && wantCites) {
        const numbers = m[2].split(',').map((n) => Number(n.trim()));
        const chips = numbers.map((n) => this.chip(n, options.citations as 'any' | Citation[]));
        if (chips.some((c) => c === null)) continue; // unknown citation → keep the text as-is
        frag.append(value.slice(last, idx));
        chips.forEach((c) => frag.append(c as HTMLElement));
        last = idx + m[0].length;
        changed = true;
      }
    }
    if (!changed) return;
    frag.append(value.slice(last));
    node.replaceWith(frag);
  }

  private chip(n: number, citations: 'any' | Citation[]): HTMLElement | null {
    let label = `Source ${n}`;
    let type: SourceType | null = null;
    if (citations !== 'any') {
      const c = citations.find((x) => x.index === n);
      if (!c) return null;
      type = c.sourceType;
      label = `Source ${n}, ${sourceTypeLabel(c.sourceType)}: ${c.title}${c.page ? `, page ${c.page}` : ''}`;
    }
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'cite-chip';
    btn.setAttribute('data-cite', String(n));
    if (type) btn.setAttribute('data-type', type);
    btn.setAttribute('aria-label', label);
    btn.setAttribute('title', label);
    btn.textContent = String(n);
    return btn;
  }
}
