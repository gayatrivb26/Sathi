import { ChangeDetectionStrategy, Component, input, model, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatSlideToggleModule } from '@angular/material/slide-toggle';
import { CourseUpsert, CourseVisibility } from '../../core/models/api.models';
import { IconComponent } from '../../shared/ui/icon/icon.component';

export const slugify = (s: string) =>
  s
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);

export const VISIBILITY_TEXT: Record<CourseVisibility, { title: string; text: string }> = {
  public: { title: 'Public', text: 'Any signed-in student can find this course and enrol themselves.' },
  private: { title: 'Private', text: 'Only students in one of your classes can see it. Share a class code or invite them by email.' },
};

export function emptyCourse(): CourseUpsert {
  return { title: '', slug: '', description: '', isPublished: false, visibility: 'private' };
}

/** Title, auto-slug (editable), description, visibility and publish — shared by "New course" and Settings. */
@Component({
  selector: 'app-course-form',
  imports: [FormsModule, MatFormFieldModule, MatInputModule, MatSlideToggleModule, IconComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="fields">
      <mat-form-field>
        <mat-label>Title</mat-label>
        <input matInput [name]="idp() + 'title'" [ngModel]="value().title" (ngModelChange)="setTitle($event)" required maxlength="120" cdkFocusInitial />
        @if (errors()['title']; as e) { <mat-hint class="err">{{ e }}</mat-hint> }
      </mat-form-field>
      <mat-form-field>
        <mat-label>URL slug</mat-label>
        <input matInput [name]="idp() + 'slug'" [ngModel]="value().slug" (ngModelChange)="setSlug($event)" required maxlength="80" spellcheck="false" />
        @if (errors()['slug']; as e) {
          <mat-hint class="err">{{ e }}</mat-hint>
        } @else {
          <mat-hint>Lower-case words and dashes{{ autoSlug() ? '. Filled in from the title until you edit it.' : '. Changing it changes the course’s web address.' }}</mat-hint>
        }
      </mat-form-field>
      <mat-form-field>
        <mat-label>Description</mat-label>
        <textarea matInput [name]="idp() + 'desc'" rows="3" [ngModel]="value().description" (ngModelChange)="patch({ description: $event })" maxlength="600"></textarea>
        <mat-hint>One or two sentences students see on the course card.</mat-hint>
      </mat-form-field>

      <fieldset class="vis">
        <legend>Who can see it</legend>
        @for (v of visibilities; track v) {
          <label class="opt" [class.on]="value().visibility === v">
            <input type="radio" [name]="idp() + 'visibility'" [value]="v" [checked]="value().visibility === v" (change)="patch({ visibility: v })" />
            <app-icon [name]="v === 'public' ? 'globe' : 'lock'" [size]="18" />
            <span>
              <strong>{{ text[v].title }}</strong>
              <span class="muted small">{{ text[v].text }}</span>
            </span>
          </label>
        }
      </fieldset>

      <div class="pub">
        <mat-slide-toggle [checked]="value().isPublished" (change)="patch({ isPublished: $event.checked })">
          {{ value().isPublished ? 'Published' : 'Draft' }}
        </mat-slide-toggle>
        <p class="muted small">{{ value().isPublished ? 'Students who can see it may start learning.' : 'Only instructors can see a draft. Publish when it’s ready.' }}</p>
      </div>
    </div>
  `,
  styles: `
    .fields {
      display: flex;
      flex-direction: column;
      gap: 12px;
    }
    .err {
      color: var(--danger);
      font-weight: 600;
    }
    .vis {
      border: 0;
      margin: 4px 0 0;
      padding: 0;
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 10px;
      @media (max-width: 559.98px) {
        grid-template-columns: 1fr;
      }
      legend {
        font-weight: 600;
        margin-bottom: 8px;
        padding: 0;
      }
    }
    .opt {
      display: flex;
      gap: 10px;
      align-items: flex-start;
      padding: 12px 14px;
      border: 2px solid var(--border);
      border-radius: 14px;
      cursor: pointer;
      > span {
        display: flex;
        flex-direction: column;
        gap: 2px;
      }
      input {
        width: 18px;
        height: 18px;
        margin: 2px 0 0;
        accent-color: var(--primary);
      }
      app-icon {
        margin-top: 1px;
        color: var(--muted);
      }
      &.on {
        border-color: var(--primary);
        background: var(--primary-soft);
        app-icon {
          color: var(--primary-soft-ink);
        }
      }
      &:has(input:focus-visible) {
        outline: 3px solid var(--focus-ring);
        outline-offset: 2px;
      }
    }
    .pub p {
      margin: 4px 0 0;
    }
  `,
})
export class CourseFormComponent {
  readonly value = model.required<CourseUpsert>();
  /** First error per field, from a VALIDATION_FAILED response. */
  readonly errors = input<Record<string, string>>({});
  /** Keeps the slug in sync with the title until the instructor edits the slug. */
  readonly autoSlug = input(true);
  readonly idp = input('cf-');

  readonly visibilities: CourseVisibility[] = ['public', 'private'];
  readonly text = VISIBILITY_TEXT;
  private readonly slugEdited = signal(false);

  patch(p: Partial<CourseUpsert>): void {
    this.value.update((v) => ({ ...v, ...p }));
  }
  setTitle(title: string): void {
    const follow = this.autoSlug() && !this.slugEdited();
    this.patch(follow ? { title, slug: slugify(title) } : { title });
  }
  setSlug(slug: string): void {
    this.slugEdited.set(true);
    this.patch({ slug: slug.toLowerCase().replace(/\s+/g, '-') });
  }
}
