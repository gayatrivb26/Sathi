import { TestBed } from '@angular/core/testing';
import { Citation } from '../models/api.models';
import { domainOf, extractMath, MarkdownService } from './markdown.service';

const CITES: Citation[] = [
  { index: 1, sourceType: 'upload', title: 'Lecture 3 notes.pdf', documentId: 'd1', lessonId: null, page: 12, url: null, snippet: '' },
  { index: 2, sourceType: 'web', title: 'Attention Is All You Need', documentId: null, lessonId: null, page: null, url: 'https://arxiv.org/abs/1706.03762', snippet: '' },
];

function dom(html: string): HTMLElement {
  const div = document.createElement('div');
  div.innerHTML = html;
  return div;
}

describe('MarkdownService', () => {
  let md: MarkdownService;
  beforeEach(() => {
    md = TestBed.inject(MarkdownService);
  });

  describe('citations', () => {
    it('renders [n] markers as numbered chip buttons with accessible labels', () => {
      const el = dom(md.render('Scores stay stable [1]. See the paper [2].', { citations: CITES }));
      const chips = el.querySelectorAll('button.cite-chip');
      expect(chips.length).toBe(2);
      expect(chips[0].textContent).toBe('1');
      expect(chips[0].getAttribute('data-cite')).toBe('1');
      expect(chips[0].getAttribute('aria-label')).toBe('Source 1, Your notes: Lecture 3 notes.pdf, page 12');
      expect(chips[1].getAttribute('data-type')).toBe('web');
      expect(chips[1].getAttribute('aria-label')).toContain('Web');
      expect(chips[0].getAttribute('type')).toBe('button');
    });

    it('splits grouped markers like [1, 2]', () => {
      const el = dom(md.render('Both agree [1, 2].', { citations: CITES }));
      expect(el.querySelectorAll('.cite-chip').length).toBe(2);
    });

    it('leaves unknown citation numbers as plain text', () => {
      const el = dom(md.render('Unknown [7] marker.', { citations: CITES }));
      expect(el.querySelectorAll('.cite-chip').length).toBe(0);
      expect(el.textContent).toContain('[7]');
    });

    it('renders any marker while streaming ("any") with a generic label', () => {
      const el = dom(md.render('Streaming [3]', { citations: 'any' }));
      expect(el.querySelector('.cite-chip')?.getAttribute('aria-label')).toBe('Source 3');
    });

    it('does not touch markers inside code', () => {
      const el = dom(md.render('Use `arr[1]` and\n\n```\nx[2]\n```', { citations: CITES }));
      expect(el.querySelectorAll('.cite-chip').length).toBe(0);
      expect(el.querySelector('code')?.textContent).toBe('arr[1]');
    });

    it('does not render chips when citations are disabled (lessons)', () => {
      expect(dom(md.render('Plain [1]')).querySelectorAll('.cite-chip').length).toBe(0);
    });
  });

  describe('sanitising', () => {
    it('removes scripts and event handlers', () => {
      const el = dom(md.render('Hi <script>alert(1)</script><img src=x onerror="alert(1)"> <b onclick="x()">b</b>'));
      expect(el.querySelector('script')).toBeNull();
      expect(el.innerHTML).not.toContain('onerror');
      expect(el.innerHTML).not.toContain('onclick');
    });

    it('removes javascript: links and iframes', () => {
      const el = dom(md.render('[click](javascript:alert(1)) <iframe src="https://evil"></iframe>'));
      expect(el.querySelector('iframe')).toBeNull();
      expect(el.querySelector('a')?.getAttribute('href') ?? '').not.toContain('javascript');
    });

    it('strips injected buttons and inline styles so only our chips are interactive', () => {
      const el = dom(md.render('<button data-cite="1" onclick="steal()">1</button> <span style="position:fixed">x</span>', { citations: CITES }));
      expect(el.querySelectorAll('button').length).toBe(0);
      expect(el.querySelector('[style]')).toBeNull();
    });

    it('opens external links in a new tab safely', () => {
      const a = dom(md.render('[paper](https://arxiv.org/abs/1706.03762)')).querySelector('a')!;
      expect(a.getAttribute('target')).toBe('_blank');
      expect(a.getAttribute('rel')).toBe('noopener noreferrer');
    });
  });

  describe('math', () => {
    it('renders inline and display TeX with KaTeX', () => {
      const el = dom(md.render('Inline $\\sqrt{d_k}$ and\n\n$$\\frac{QK^\\top}{\\sqrt{d_k}}$$'));
      expect(el.querySelector('.math-inline .katex')).not.toBeNull();
      expect(el.querySelector('.math-display .katex-display')).not.toBeNull();
    });

    it('keeps underscores inside math away from Markdown emphasis', () => {
      const el = dom(md.render('$a_i b_i$ and $c_j$'));
      expect(el.querySelector('em')).toBeNull();
      expect(el.querySelectorAll('.katex').length).toBe(2);
    });

    it('does not treat currency as math', () => {
      const { math } = extractMath('It costs $5 and $10 today.');
      expect(math.length).toBe(0);
    });

    it('does not render math inside code blocks', () => {
      const { math } = extractMath('`$x$` and\n```\n$$y$$\n```');
      expect(math.length).toBe(0);
    });

    it('shows invalid TeX as an error instead of throwing', () => {
      expect(() => md.render('$\\frac{$')).not.toThrow();
    });
  });

  it('extracts the domain for web sources', () => {
    expect(domainOf('https://www.example.org/a/b')).toBe('example.org');
    expect(domainOf('not a url')).toBe('');
  });
});
