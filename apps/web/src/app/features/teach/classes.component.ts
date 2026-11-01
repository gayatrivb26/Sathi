import { ChangeDetectionStrategy, Component, computed, effect, inject, signal, untracked } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { firstValueFrom } from 'rxjs';
import { InstructorApi } from '../../core/api/staff.api';
import { formatJoinCode } from '../../core/classes/join-code';
import { Notifier } from '../../core/errors/notifier.service';
import { ApiError, toApiError } from '../../core/http/api-error';
import { ClassSummary } from '../../core/models/api.models';
import { IconComponent } from '../../shared/ui/icon/icon.component';
import { EmptyStateComponent } from '../../shared/ui/states/empty-state.component';
import { ErrorStateComponent } from '../../shared/ui/states/error-state.component';
import { SkeletonComponent } from '../../shared/ui/states/skeleton.component';
import { ClassDetailComponent } from './class-detail.component';
import { TeachContext } from './teach-context.service';

/** Teach → Classes: how a course reaches students — join codes, links and email invites (contracts.md §11.1). */
@Component({
  selector: 'app-teach-classes',
  imports: [FormsModule, MatButtonModule, MatFormFieldModule, MatInputModule, IconComponent, SkeletonComponent, ErrorStateComponent, EmptyStateComponent, ClassDetailComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <p class="intro muted">
      @if (ctx.course()?.visibility === 'private') {
        This course is <strong>private</strong>: students only see it after joining one of its classes.
      } @else {
        This course is <strong>public</strong>: any student can enrol, and classes group them so you can follow their progress together.
      }
      Share a class code or link, or invite students by email.
    </p>
    @switch (ctx.classes.status()) {
      @case ('loading') { <div class="layout"><app-skeleton [lines]="5" /><app-skeleton [lines]="8" /></div> }
      @case ('error') { <app-error-state [error]="ctx.classes.error()" title="We couldn’t load the classes" (retry)="ctx.classes.load()" /> }
      @default {
        <div class="layout">
          <section class="card list" aria-labelledby="cl-h">
            <div class="card-title">
              <h2 id="cl-h">Classes</h2>
              <button matButton="filled" type="button" (click)="creating.set(!creating())" [attr.aria-expanded]="creating()" aria-controls="new-class"><app-icon name="plus" [size]="16" /> New class</button>
            </div>
            @if (creating()) {
              <form id="new-class" class="new" (ngSubmit)="create()" novalidate>
                <mat-form-field subscriptSizing="dynamic">
                  <mat-label>Class name</mat-label>
                  <input matInput name="cname" [ngModel]="name()" (ngModelChange)="name.set($event); createError.set(null)" maxlength="80" placeholder="e.g. Monday evening batch" autocomplete="off" />
                </mat-form-field>
                <mat-form-field subscriptSizing="dynamic">
                  <mat-label>Description (optional)</mat-label>
                  <input matInput name="cdesc" [ngModel]="desc()" (ngModelChange)="desc.set($event)" maxlength="200" autocomplete="off" />
                </mat-form-field>
                @if (createError(); as e) {
                  <div class="inline-alert" role="alert"><app-icon name="alert" [size]="18" /><div><p>{{ e.userMessage }}</p></div></div>
                }
                <div class="row">
                  <button matButton="filled" type="submit" [disabled]="busy()">{{ busy() ? 'Creating…' : 'Create class' }}</button>
                  <button matButton="text" type="button" (click)="creating.set(false)">Cancel</button>
                </div>
              </form>
            }
            <ul class="classes" role="list">
              @for (c of active(); track c.id) {
                <li>
                  <button type="button" class="cls" [class.on]="c.id === selectedId()" (click)="select(c.id)" [attr.aria-current]="c.id === selectedId() ? 'true' : null">
                    <span class="nm">{{ c.name }}</span>
                    <span class="meta">
                      <span class="join-code">{{ code(c) }}</span>
                      <span>· {{ c.memberCount }} student{{ c.memberCount === 1 ? '' : 's' }}</span>
                      @if (c.pendingInvites) { <span>· {{ c.pendingInvites }} invited</span> }
                    </span>
                    <span class="pill" [class.mint]="c.joinEnabled" [class.neutral]="!c.joinEnabled">{{ c.joinEnabled ? 'Joining on' : 'Joining off' }}</span>
                  </button>
                </li>
              } @empty {
                @if (!creating()) {
                  <li><app-empty-state [plain]="true" icon="classes" title="No classes yet" text="Create a class to get a join code you can share with students." /></li>
                }
              }
            </ul>
            @if (archived().length) {
              <details class="arch">
                <summary>Archived ({{ archived().length }})</summary>
                <ul class="classes" role="list">
                  @for (c of archived(); track c.id) {
                    <li>
                      <button type="button" class="cls archived" [class.on]="c.id === selectedId()" (click)="select(c.id)" [attr.aria-current]="c.id === selectedId() ? 'true' : null">
                        <span class="nm">{{ c.name }}</span>
                        <span class="meta"><span>{{ c.memberCount }} student{{ c.memberCount === 1 ? '' : 's' }} · archived</span></span>
                      </button>
                    </li>
                  }
                </ul>
              </details>
            }
          </section>

          <div class="detail" id="class-detail" tabindex="-1">
            @if (selected(); as c) {
              <app-class-detail [cls]="c" [courseTitle]="ctx.course()?.title ?? ''" (changed)="onChanged($event)" />
            } @else if (active().length || archived().length) {
              <div class="card hint"><p class="muted">Choose a class to see its join code, students and invites.</p></div>
            }
          </div>
        </div>
      }
    }
  `,
  styles: `
    .intro {
      margin: -6px 0 16px;
      max-width: 80ch;
    }
    .layout {
      display: grid;
      grid-template-columns: 320px minmax(0, 1fr);
      gap: 22px;
      align-items: start;
      @media (max-width: 1023.98px) {
        grid-template-columns: minmax(0, 1fr);
      }
    }
    .list {
      padding: 18px;
    }
    .new {
      display: flex;
      flex-direction: column;
      gap: 10px;
      padding: 12px;
      margin-bottom: 12px;
      border-radius: 14px;
      background: var(--surface-2);
    }
    .row {
      display: flex;
      gap: 8px;
      flex-wrap: wrap;
    }
    .classes {
      list-style: none;
      margin: 0;
      padding: 0;
      display: flex;
      flex-direction: column;
      gap: 6px;
    }
    .cls {
      width: 100%;
      display: flex;
      flex-direction: column;
      align-items: flex-start;
      gap: 4px;
      min-height: 44px;
      padding: 12px 14px;
      border: 1px solid var(--border);
      border-radius: 14px;
      background: var(--surface);
      text-align: left;
      cursor: pointer;
      &:hover {
        border-color: var(--primary-ink);
      }
      &.on {
        border-color: var(--primary);
        background: var(--primary-soft);
        box-shadow: inset 3px 0 0 var(--primary);
      }
      &.archived {
        opacity: 0.85;
      }
    }
    .nm {
      font-weight: 700;
    }
    .meta {
      display: flex;
      flex-wrap: wrap;
      gap: 4px;
      font-size: 0.85rem;
      color: var(--muted);
    }
    .pill {
      min-height: 24px;
      font-size: 0.75rem;
      padding: 2px 10px;
    }
    .arch {
      margin-top: 14px;
      summary {
        min-height: 44px;
        display: flex;
        align-items: center;
        cursor: pointer;
        font-weight: 600;
        color: var(--muted);
      }
    }
    .detail {
      outline: none;
      min-width: 0;
    }
  `,
})
export default class ClassesComponent {
  readonly ctx = inject(TeachContext);
  private readonly api = inject(InstructorApi);
  private readonly notifier = inject(Notifier);

  readonly selectedId = signal<string | null>(null);
  readonly creating = signal(false);
  readonly name = signal('');
  readonly desc = signal('');
  readonly busy = signal(false);
  readonly createError = signal<ApiError | null>(null);

  readonly active = computed(() => (this.ctx.classes.data() ?? []).filter((c) => !c.archivedAt));
  readonly archived = computed(() => (this.ctx.classes.data() ?? []).filter((c) => !!c.archivedAt));
  readonly selected = computed(() => {
    const all = this.ctx.classes.data() ?? [];
    return all.find((c) => c.id === this.selectedId()) ?? (window.matchMedia?.('(min-width: 1024px)').matches ? (this.active()[0] ?? null) : null);
  });

  constructor() {
    effect(() => {
      this.ctx.courseId();
      untracked(() => {
        this.selectedId.set(null);
        this.creating.set(false);
      });
    });
  }

  code(c: ClassSummary): string {
    return formatJoinCode(c.joinCode);
  }

  select(id: string): void {
    this.selectedId.set(id);
    if (!window.matchMedia?.('(min-width: 1024px)').matches) {
      setTimeout(() => {
        const el = document.getElementById('class-detail');
        el?.scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'start' });
        el?.focus({ preventScroll: true });
      });
    }
  }

  async create(): Promise<void> {
    const courseId = this.ctx.courseId();
    const name = this.name().trim();
    if (!courseId) return;
    if (!name) {
      this.createError.set(new ApiError({ status: 400, code: 'VALIDATION_FAILED', detail: 'Give the class a name, like “Monday evening batch”.' }));
      return;
    }
    this.busy.set(true);
    this.createError.set(null);
    try {
      const created = await firstValueFrom(this.api.createClass(courseId, { name, ...(this.desc().trim() ? { description: this.desc().trim() } : {}) }));
      this.ctx.setClasses([created, ...(this.ctx.classes.data() ?? [])]);
      this.name.set('');
      this.desc.set('');
      this.creating.set(false);
      this.select(created.id);
      this.notifier.success(`“${created.name}” created. Share its code ${formatJoinCode(created.joinCode)} with your students.`);
    } catch (e) {
      const err = toApiError(e);
      this.createError.set(err.fieldErrors['name']?.[0] ? new ApiError({ status: 400, code: err.code, detail: err.fieldErrors['name'][0] }) : err);
    } finally {
      this.busy.set(false);
    }
  }

  onChanged(c: ClassSummary): void {
    this.ctx.setClasses((this.ctx.classes.data() ?? []).map((x) => (x.id === c.id ? c : x)));
  }
}
