import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatDialog } from '@angular/material/dialog';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatSelectModule } from '@angular/material/select';
import { Router, RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';
import { Notifier } from '../../core/errors/notifier.service';
import { InstructorCourse } from '../../core/models/api.models';
import { IconComponent } from '../../shared/ui/icon/icon.component';
import { IconName } from '../../shared/ui/icon/icons';
import { EmptyStateComponent } from '../../shared/ui/states/empty-state.component';
import { ErrorStateComponent } from '../../shared/ui/states/error-state.component';
import { SkeletonComponent } from '../../shared/ui/states/skeleton.component';
import { NewCourseDialogComponent } from './new-course-dialog.component';
import { TeachContext } from './teach-context.service';

@Component({
  selector: 'app-teach-layout',
  imports: [RouterOutlet, RouterLink, RouterLinkActive, MatButtonModule, MatFormFieldModule, MatSelectModule, IconComponent, ErrorStateComponent, SkeletonComponent, EmptyStateComponent],
  providers: [TeachContext],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="page">
      <header class="page-head">
        <div>
          <p class="eyebrow">Instructor</p>
          <h1>Teach</h1>
        </div>
        <div class="switcher">
          @if (ctx.courses.data()?.length) {
            <mat-form-field class="course-pick" subscriptSizing="dynamic">
              <mat-label>Course</mat-label>
              <mat-select [value]="ctx.courseId()" (valueChange)="ctx.select($event)">
                @for (c of ctx.courses.data(); track c.id) {
                  <mat-option [value]="c.id">{{ c.title }}{{ c.isPublished ? '' : ' (draft)' }}{{ c.visibility === 'private' ? ' · private' : '' }}</mat-option>
                }
              </mat-select>
            </mat-form-field>
          }
          <button matButton="filled" type="button" class="new" (click)="newCourse()"><app-icon name="plus" [size]="18" /> New course</button>
        </div>
      </header>

      @if (ctx.course(); as c) {
        <div class="badges" aria-label="Course status">
          <span class="pill" [class.neutral]="c.visibility === 'public'"><app-icon [name]="c.visibility === 'private' ? 'lock' : 'globe'" [size]="13" /> {{ c.visibility === 'private' ? 'Private — class members only' : 'Public — any student can enrol' }}</span>
          <span class="pill" [class.mint]="c.isPublished" [class.amber]="!c.isPublished">{{ c.isPublished ? 'Published' : 'Draft' }}</span>
          <span class="pill neutral"><app-icon name="users" [size]="13" /> {{ c.studentCount }} student{{ c.studentCount === 1 ? '' : 's' }}</span>
          <span class="pill neutral"><app-icon name="classes" [size]="13" /> {{ c.classCount }} class{{ c.classCount === 1 ? '' : 'es' }}</span>
          <span class="pill neutral">Your role: {{ roleLabel(c) }}</span>
        </div>
      }

      @switch (ctx.courses.status()) {
        @case ('loading') { <app-skeleton [lines]="6" /> }
        @case ('error') { <app-error-state [error]="ctx.courses.error()" title="We couldn’t load your courses" (retry)="ctx.courses.load()" /> }
        @default {
          @if (ctx.courses.data()?.length) {
            <nav class="tabs-nav" aria-label="Teach sections">
              @for (t of tabs; track t.path) {
                <a [routerLink]="t.path" routerLinkActive="active" ariaCurrentWhenActive="page"><app-icon [name]="t.icon" [size]="18" /> {{ t.label }}</a>
              }
            </nav>
            <router-outlet />
          } @else {
            <app-empty-state icon="teach" title="Create your first course" text="Start with a title — you can add modules, lessons, concepts and classes after. Nothing is visible to students until you publish.">
              <button matButton="filled" type="button" (click)="newCourse()"><app-icon name="plus" [size]="18" /> New course</button>
            </app-empty-state>
          }
        }
      }
    </div>
  `,
  styles: `
    .switcher {
      display: flex;
      align-items: center;
      gap: 12px;
      flex-wrap: wrap;
    }
    .course-pick {
      min-width: 280px;
      @media (max-width: 559.98px) {
        min-width: 0;
        width: 100%;
      }
    }
    .new {
      min-height: 48px;
    }
    .badges {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
      margin: -10px 0 18px;
    }
  `,
})
export class TeachLayoutComponent {
  readonly ctx = inject(TeachContext);
  private readonly dialog = inject(MatDialog);
  private readonly router = inject(Router);
  private readonly notifier = inject(Notifier);
  readonly tabs: { path: string; label: string; icon: IconName }[] = [
    { path: 'content', label: 'Content', icon: 'book' },
    { path: 'classes', label: 'Classes', icon: 'classes' },
    { path: 'questions', label: 'Question bank', icon: 'layers' },
    { path: 'grading', label: 'Grading review', icon: 'check-circle' },
    { path: 'insights', label: 'Class insights', icon: 'chart' },
    { path: 'settings', label: 'Settings', icon: 'settings' },
  ];

  roleLabel(c: InstructorCourse): string {
    return { owner: 'Owner', instructor: 'Instructor', admin: 'Admin' }[c.myRole];
  }

  newCourse(): void {
    this.dialog
      .open<NewCourseDialogComponent, void, InstructorCourse>(NewCourseDialogComponent, { width: '600px', maxWidth: 'calc(100vw - 32px)', autoFocus: 'first-tabbable' })
      .afterClosed()
      .subscribe((created) => {
        if (!created) return;
        this.ctx.upsert(created);
        this.ctx.select(created.id);
        this.notifier.success(`“${created.title}” created. Add your first module.`);
        void this.router.navigate(['/teach/content']);
      });
  }
}
