import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatDialogModule, MatDialogRef } from '@angular/material/dialog';
import { firstValueFrom } from 'rxjs';
import { InstructorApi } from '../../core/api/staff.api';
import { ApiError, toApiError } from '../../core/http/api-error';
import { CourseUpsert, InstructorCourse } from '../../core/models/api.models';
import { IconComponent } from '../../shared/ui/icon/icon.component';
import { CourseFormComponent, emptyCourse, slugify } from './course-form.component';

/** "New course" dialog. Closes with the created course; the creator becomes its owner (§11.1). */
@Component({
  selector: 'app-new-course-dialog',
  imports: [FormsModule, MatDialogModule, MatButtonModule, IconComponent, CourseFormComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <form (ngSubmit)="create()" novalidate>
      <h2 mat-dialog-title>New course</h2>
      <mat-dialog-content>
        <p class="muted small intro">You’ll be its owner. Add modules, lessons and classes next — nothing is visible to students until you publish.</p>
        <app-course-form [(value)]="course" [errors]="errors()" idp="nc-" />
        @if (error(); as e) {
          <div class="inline-alert" role="alert"><app-icon name="alert" [size]="18" /><div><p>{{ e.userMessage }}</p></div></div>
        }
      </mat-dialog-content>
      <mat-dialog-actions align="end">
        <button matButton="text" type="button" mat-dialog-close>Cancel</button>
        <button matButton="filled" type="submit" [disabled]="busy()">{{ busy() ? 'Creating…' : 'Create course' }}</button>
      </mat-dialog-actions>
    </form>
  `,
  styles: `
    .intro {
      margin-bottom: 14px;
    }
    .inline-alert {
      margin-top: 12px;
    }
  `,
})
export class NewCourseDialogComponent {
  private readonly api = inject(InstructorApi);
  private readonly ref = inject<MatDialogRef<NewCourseDialogComponent, InstructorCourse>>(MatDialogRef);
  readonly course = signal<CourseUpsert>(emptyCourse());
  readonly errors = signal<Record<string, string>>({});
  readonly error = signal<ApiError | null>(null);
  readonly busy = signal(false);

  async create(): Promise<void> {
    const c = this.course();
    const errors: Record<string, string> = {};
    if (!c.title.trim()) errors['title'] = 'Give the course a title.';
    const slug = slugify(c.slug || c.title);
    if (!slug) errors['slug'] = 'Add a URL slug, like intro-to-ml.';
    this.errors.set(errors);
    if (Object.keys(errors).length) return;
    this.busy.set(true);
    this.error.set(null);
    try {
      const created = await firstValueFrom(this.api.createCourse({ ...c, title: c.title.trim(), slug, description: c.description.trim() }));
      this.ref.close(created);
    } catch (e) {
      const err = toApiError(e);
      const fields = Object.fromEntries(Object.entries(err.fieldErrors).map(([k, v]) => [k.charAt(0).toLowerCase() + k.slice(1), v[0]]));
      this.errors.set(fields);
      if (!Object.keys(fields).length) this.error.set(err);
    } finally {
      this.busy.set(false);
    }
  }
}
