import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import { RouterLink } from '@angular/router';
import { domainOf, sourceTypeLabel } from '../../core/markdown/markdown.service';
import { AnswerBasis, Citation, SourceType } from '../../core/models/api.models';
import { IconComponent } from '../../shared/ui/icon/icon.component';
import { IconName } from '../../shared/ui/icon/icons';

const TYPE_ICON: Record<SourceType, IconName> = { course: 'book', upload: 'file', web: 'globe' };
const BASIS_TEXT: Record<AnswerBasis, string> = { course: 'your course', upload: 'your notes', web: 'the web', general: 'general knowledge' };

export function basisSentence(basis: AnswerBasis[]): string {
  if (!basis.length) return '';
  const parts = basis.map((b) => BASIS_TEXT[b]);
  const list = parts.length > 1 ? `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}` : parts[0];
  return `Answered from: ${list}`;
}

/** Sources for one answer, labelled by type with icon + text (never colour alone). */
@Component({
  selector: 'app-source-list',
  imports: [RouterLink, IconComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (basis().length) {
      <p class="basis"><app-icon name="info" [size]="15" /> {{ basisText() }}</p>
    }
    <ol class="sources">
      @for (c of sorted(); track c.index) {
        <li [id]="idPrefix() + c.index" tabindex="-1" class="src" [class.hl]="highlight() === c.index" [attr.data-type]="c.sourceType">
          <span class="num" aria-hidden="true">{{ c.index }}</span>
          <div class="body">
            <p class="type">
              <app-icon [name]="icon[c.sourceType]" [size]="14" />
              <span>{{ label(c.sourceType) }}</span>
              @if (c.sourceType === 'web' && c.url) { <span class="domain">· {{ domain(c.url) }}</span> }
            </p>
            <p class="title">
              <span class="sr-only">Source {{ c.index }}: </span>
              @if (c.sourceType === 'web' && c.url) {
                <a [href]="c.url" target="_blank" rel="noopener noreferrer">{{ c.title }} <app-icon name="external" [size]="13" /><span class="sr-only"> (opens in a new tab)</span></a>
              } @else if (c.sourceType === 'course' && c.lessonId) {
                <a [routerLink]="['/lessons', c.lessonId]">{{ c.title }}</a>
              } @else {
                {{ c.title }}
              }
            </p>
            @if (c.page) { <p class="where">Page {{ c.page }}</p> }
            @if (c.snippet) { <p class="snippet">“{{ c.snippet }}”</p> }
          </div>
        </li>
      }
    </ol>
  `,
  styles: `
    .basis {
      display: flex;
      align-items: center;
      gap: 6px;
      font-size: 0.85rem;
      font-weight: 600;
      color: var(--muted);
      margin-bottom: 12px;
    }
    .sources {
      list-style: none;
      margin: 0;
      padding: 0;
      display: flex;
      flex-direction: column;
      gap: 10px;
    }
    .src {
      display: flex;
      gap: 12px;
      padding: 12px;
      border-radius: 14px;
      border: 1px solid var(--border);
      background: var(--surface);
      transition:
        background 0.3s,
        border-color 0.3s,
        box-shadow 0.3s;
      &.hl {
        border-color: var(--primary);
        box-shadow: 0 0 0 3px color-mix(in srgb, var(--primary) 22%, transparent);
      }
      &[data-type='web'] {
        border-style: dashed;
        border-color: color-mix(in srgb, var(--web) 55%, var(--border));
        .num {
          background: var(--web);
        }
        .type {
          color: var(--web);
        }
      }
      &[data-type='upload'] {
        .num {
          background: var(--upload);
        }
        .type {
          color: var(--upload);
        }
      }
    }
    .num {
      display: grid;
      place-items: center;
      flex: none;
      width: 26px;
      height: 22px;
      border-radius: 7px;
      background: var(--primary);
      color: var(--surface);
      font-size: 0.75rem;
      font-weight: 700;
    }
    .body {
      min-width: 0;
      display: flex;
      flex-direction: column;
      gap: 2px;
    }
    .type {
      display: flex;
      align-items: center;
      gap: 5px;
      font-size: 0.75rem;
      font-weight: 700;
      letter-spacing: 0.04em;
      text-transform: uppercase;
      color: var(--primary-ink);
    }
    .domain {
      text-transform: none;
      letter-spacing: 0;
      font-weight: 600;
    }
    .title {
      font-weight: 700;
      overflow-wrap: anywhere;
      a {
        color: var(--ink);
        text-decoration-color: var(--border-input);
        &:hover {
          color: var(--primary-ink);
        }
      }
    }
    .where {
      font-size: 0.85rem;
      color: var(--muted);
    }
    .snippet {
      margin-top: 4px;
      font-size: 0.85rem;
      color: var(--muted);
      display: -webkit-box;
      -webkit-line-clamp: 3;
      -webkit-box-orient: vertical;
      overflow: hidden;
    }
  `,
})
export class SourceListComponent {
  readonly citations = input<Citation[]>([]);
  readonly basis = input<AnswerBasis[]>([]);
  readonly highlight = input<number | null>(null);
  readonly idPrefix = input('src-');

  readonly icon = TYPE_ICON;
  readonly sorted = computed(() => [...this.citations()].sort((a, b) => a.index - b.index));
  readonly basisText = computed(() => basisSentence(this.basis()));

  label(t: SourceType): string {
    return sourceTypeLabel(t);
  }
  domain(url: string): string {
    return domainOf(url);
  }
}
