import { DatePipe } from '@angular/common';
import { ChangeDetectionStrategy, Component, effect, inject, signal, untracked } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatDialog } from '@angular/material/dialog';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { Router } from '@angular/router';
import { firstValueFrom, of } from 'rxjs';
import { InstructorApi } from '../../core/api/staff.api';
import { AuthStore } from '../../core/auth/auth.store';
import { Notifier } from '../../core/errors/notifier.service';
import { ApiError, toApiError } from '../../core/http/api-error';
import { CourseInstructor, CourseUpsert } from '../../core/models/api.models';
import { createLoader } from '../../core/platform/loader';
import { confirmDialog } from '../../shared/ui/dialog/confirm-dialog.component';
import { IconComponent } from '../../shared/ui/icon/icon.component';
import { ErrorStateComponent } from '../../shared/ui/states/error-state.component';
import { SkeletonComponent } from '../../shared/ui/states/skeleton.component';
import { CourseFormComponent, emptyCourse, slugify } from './course-form.component';
import { TeachContext } from './teach-context.service';

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

/** Teach → Settings: course details, visibility, publishing, co-instructors, delete (contracts.md §11.1). */
@Component({
  selector: 'app-course-settings',
  imports: [DatePipe, FormsModule, MatButtonModule, MatFormFieldModule, MatInputModule, IconComponent, SkeletonComponent, ErrorStateComponent, CourseFormComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (ctx.course(); as course) {
      <div class="grid">
        <section class="card" aria-labelledby="cs-h">
          <h2 id="cs-h" class="card-title">Course settings</h2>
          <form (ngSubmit)="save()" novalidate>
            <app-course-form [(value)]="form" [errors]="errors()" [autoSlug]="false" idp="cs-" />
            @if (saveError(); as e) {
              <div class="inline-alert" role="alert"><app-icon name="alert" [size]="18" /><div><p>{{ e.userMessage }}</p></div></div>
            }
            <div class="row"><button matButton="filled" type="submit" [disabled]="saving()"><app-icon name="save" [size]="16" /> {{ saving() ? 'Saving…' : 'Save settings' }}</button></div>
          </form>
        </section>

        <div class="side">
          <section class="card" aria-labelledby="ci-h">
            <h2 id="ci-h" class="card-title">Co-instructors</h2>
            <p class="muted small">Co-instructors can edit content, run classes and review answers for this course. Only owners and admins can add or remove them.</p>
            @switch (team.status()) {
              @case ('loading') { <app-skeleton [lines]="3" [card]="false" /> }
              @case ('error') { <app-error-state [error]="team.error()" [compact]="true" title="We couldn’t load the instructors" (retry)="team.load()" /> }
              @default {
                <ul class="team" role="list">
                  @for (p of team.data() ?? []; track p.userId) {
                    <li>
                      <span class="avatar" aria-hidden="true">{{ initials(p.displayName) }}</span>
                      <span class="who"><strong>{{ p.displayName }}{{ p.userId === auth.me()?.id ? ' (you)' : '' }}</strong><span class="muted small">{{ p.email }} · since {{ p.addedAt | date: 'MMM y' }}</span></span>
                      <span class="pill" [class.neutral]="p.role !== 'owner'">{{ p.role === 'owner' ? 'Owner' : 'Instructor' }}</span>
                      @if (ctx.canManage()) {
                        <button type="button" class="icon-only" (click)="remove(p)" [attr.aria-label]="'Remove ' + p.displayName + ' from this course'"><app-icon name="user-minus" [size]="18" /></button>
                      }
                    </li>
                  }
                </ul>
              }
            }
            @if (teamError(); as e) {
              <div class="inline-alert" role="alert">
                <app-icon name="alert" [size]="18" />
                <div>
                  <p>{{ e.userMessage }}</p>
                  @if (e.code === 'USER_NOT_INSTRUCTOR' || e.code === 'USER_NOT_FOUND') {
                    <p class="small">An admin can grant the Instructor role in Admin → Users, or send a staff invite that adds them to this course.</p>
                  }
                </div>
              </div>
            }
            @if (ctx.canManage()) {
              <form class="add" (ngSubmit)="add()" novalidate>
                <mat-form-field class="grow" subscriptSizing="dynamic">
                  <mat-label>Instructor’s email</mat-label>
                  <input matInput type="email" name="ci-email" [ngModel]="email()" (ngModelChange)="email.set($event); teamError.set(null)" autocomplete="off" />
                </mat-form-field>
                <button matButton="outlined" type="submit" [disabled]="adding()"><app-icon name="user-plus" [size]="16" /> {{ adding() ? 'Adding…' : 'Add' }}</button>
              </form>
            } @else {
              <p class="small muted"><app-icon name="info" [size]="14" /> Ask the course owner to add or remove instructors.</p>
            }
          </section>

          @if (ctx.canManage()) {
            <section class="card danger" aria-labelledby="dz-h">
              <h2 id="dz-h" class="card-title">Delete course</h2>
              <p class="muted small">Only possible while no students are enrolled. Once students have joined, unpublish the course instead — it disappears for them and their progress is kept.</p>
              @if (deleteError(); as e) {
                <div class="inline-alert" role="alert">
                  <app-icon name="alert" [size]="18" />
                  <div>
                    <p>{{ e.userMessage }}</p>
                    @if (e.code === 'COURSE_HAS_STUDENTS' && course.isPublished) {
                      <button matButton="outlined" type="button" (click)="unpublish()" [disabled]="saving()">Unpublish instead</button>
                    }
                  </div>
                </div>
              }
              <button matButton="outlined" class="btn-danger" type="button" (click)="removeCourse()" [disabled]="deleting()"><app-icon name="trash" [size]="16" /> {{ deleting() ? 'Deleting…' : 'Delete course' }}</button>
            </section>
          }
        </div>
      </div>
    }
  `,
  styles: `
    .grid {
      display: grid;
      grid-template-columns: minmax(0, 1.2fr) minmax(0, 1fr);
      gap: 22px;
      align-items: start;
      @media (max-width: 1099.98px) {
        grid-template-columns: minmax(0, 1fr);
      }
    }
    .side {
      display: flex;
      flex-direction: column;
      gap: 22px;
    }
    form {
      display: flex;
      flex-direction: column;
      gap: 12px;
    }
    .team {
      list-style: none;
      margin: 12px 0;
      padding: 0;
      li {
        display: flex;
        align-items: center;
        gap: 10px;
        padding: 8px 0;
        border-bottom: 1px solid var(--border);
        &:last-child {
          border-bottom: 0;
        }
      }
    }
    .avatar {
      display: grid;
      place-items: center;
      width: 36px;
      height: 36px;
      flex: none;
      border-radius: 50%;
      background: var(--primary-soft);
      color: var(--primary-soft-ink);
      font-weight: 700;
      font-size: 0.8rem;
    }
    .who {
      flex: 1;
      min-width: 0;
      display: flex;
      flex-direction: column;
      overflow-wrap: anywhere;
    }
    .add {
      flex-direction: row;
      align-items: center;
      flex-wrap: wrap;
      margin-top: 12px;
      .grow {
        flex: 1;
        min-width: 200px;
      }
      button {
        min-height: 48px;
      }
    }
    .inline-alert {
      margin: 10px 0;
    }
    .danger {
      border-color: color-mix(in srgb, var(--danger) 35%, var(--border));
      p {
        margin-bottom: 12px;
      }
    }
  `,
})
export default class CourseSettingsComponent {
  readonly ctx = inject(TeachContext);
  readonly auth = inject(AuthStore);
  private readonly api = inject(InstructorApi);
  private readonly dialog = inject(MatDialog);
  private readonly notifier = inject(Notifier);
  private readonly router = inject(Router);

  readonly form = signal<CourseUpsert>(emptyCourse());
  readonly errors = signal<Record<string, string>>({});
  readonly saveError = signal<ApiError | null>(null);
  readonly saving = signal(false);

  readonly team = createLoader<CourseInstructor[]>(() => {
    const id = this.ctx.courseId();
    return id ? this.api.instructors(id) : of([]);
  }, { immediate: false });
  readonly email = signal('');
  readonly adding = signal(false);
  readonly teamError = signal<ApiError | null>(null);
  readonly deleting = signal(false);
  readonly deleteError = signal<ApiError | null>(null);

  constructor() {
    effect(() => {
      const c = this.ctx.course();
      untracked(() => {
        if (c) this.form.set({ title: c.title, slug: c.slug, description: c.description, isPublished: c.isPublished, visibility: c.visibility });
        this.errors.set({});
        this.saveError.set(null);
        this.deleteError.set(null);
        this.teamError.set(null);
      });
    });
    effect(() => {
      this.ctx.courseId();
      untracked(() => this.team.load());
    });
  }

  async save(patch: Partial<CourseUpsert> = {}): Promise<boolean> {
    const id = this.ctx.courseId();
    if (!id) return false;
    const v = { ...this.form(), ...patch };
    const errors: Record<string, string> = {};
    if (!v.title.trim()) errors['title'] = 'Give the course a title.';
    if (!slugify(v.slug)) errors['slug'] = 'Add a URL slug, like intro-to-ml.';
    this.errors.set(errors);
    if (Object.keys(errors).length) return false;
    this.saving.set(true);
    this.saveError.set(null);
    try {
      const updated = await firstValueFrom(this.api.updateCourse(id, { ...v, title: v.title.trim(), slug: slugify(v.slug) }));
      this.ctx.upsert(updated);
      this.notifier.success('Course settings saved.');
      return true;
    } catch (e) {
      const err = toApiError(e);
      const fields = Object.fromEntries(Object.entries(err.fieldErrors).map(([k, m]) => [k.charAt(0).toLowerCase() + k.slice(1), m[0]]));
      this.errors.set(fields);
      if (!Object.keys(fields).length) this.saveError.set(err);
      return false;
    } finally {
      this.saving.set(false);
    }
  }

  async unpublish(): Promise<void> {
    if (await this.save({ isPublished: false })) this.deleteError.set(null);
  }

  async add(): Promise<void> {
    const id = this.ctx.courseId();
    const email = this.email().trim();
    if (!id) return;
    if (!EMAIL.test(email)) {
      this.teamError.set(new ApiError({ status: 400, code: 'VALIDATION_FAILED', detail: 'Enter the instructor’s email address.' }));
      return;
    }
    this.adding.set(true);
    this.teamError.set(null);
    try {
      await firstValueFrom(this.api.addInstructor(id, email));
      this.email.set('');
      this.team.load();
      this.notifier.success(`${email} can now teach this course.`);
    } catch (e) {
      this.teamError.set(toApiError(e));
    } finally {
      this.adding.set(false);
    }
  }

  async remove(p: CourseInstructor): Promise<void> {
    const id = this.ctx.courseId();
    if (!id) return;
    const self = p.userId === this.auth.me()?.id;
    const ok = await firstValueFrom(
      confirmDialog(this.dialog, { title: `Remove ${self ? 'yourself' : p.displayName}?`, message: self ? 'You will lose access to this course in Teach unless you are an admin.' : `${p.displayName} will no longer be able to edit this course or see its classes.`, confirmText: 'Remove', danger: true }),
    );
    if (!ok) return;
    this.teamError.set(null);
    try {
      await firstValueFrom(this.api.removeInstructor(id, p.userId));
      this.team.update((l) => l.filter((x) => x.userId !== p.userId));
      this.notifier.success(`${p.displayName} removed.`);
    } catch (e) {
      this.teamError.set(toApiError(e));
    }
  }

  async removeCourse(): Promise<void> {
    const c = this.ctx.course();
    if (!c) return;
    const ok = await firstValueFrom(confirmDialog(this.dialog, { title: `Delete “${c.title}”?`, message: 'Its modules, lessons, concepts, questions and classes are deleted. This can’t be undone.', confirmText: 'Delete course', danger: true }));
    if (!ok) return;
    this.deleting.set(true);
    this.deleteError.set(null);
    try {
      await firstValueFrom(this.api.deleteCourse(c.id));
      this.ctx.remove(c.id);
      this.notifier.success(`“${c.title}” deleted.`);
      await this.router.navigate(['/teach/content']);
    } catch (e) {
      this.deleteError.set(toApiError(e));
    } finally {
      this.deleting.set(false);
    }
  }

  initials(name: string): string {
    return name
      .split(/\s+/)
      .map((x) => x[0])
      .slice(0, 2)
      .join('')
      .toUpperCase();
  }
}
