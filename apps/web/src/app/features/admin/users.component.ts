import { DatePipe } from '@angular/common';
import { ChangeDetectionStrategy, Component, computed, DestroyRef, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatSelectModule } from '@angular/material/select';
import { RouterLink } from '@angular/router';
import { AdminApi } from '../../core/api/staff.api';
import { AdminUser, Role } from '../../core/models/api.models';
import { createLoader } from '../../core/platform/loader';
import { IconComponent } from '../../shared/ui/icon/icon.component';
import { EmptyStateComponent } from '../../shared/ui/states/empty-state.component';
import { ErrorStateComponent } from '../../shared/ui/states/error-state.component';
import { SkeletonComponent } from '../../shared/ui/states/skeleton.component';
import { statusPills } from './roles';
import { UserDrawerComponent } from './user-drawer.component';

const PAGE = 20;

/** Admin → Users (contracts.md §11.2): search, filter, page, open a person to change roles or lock. */
@Component({
  selector: 'app-admin-users',
  imports: [DatePipe, FormsModule, RouterLink, MatButtonModule, MatFormFieldModule, MatInputModule, MatSelectModule, IconComponent, SkeletonComponent, ErrorStateComponent, EmptyStateComponent, UserDrawerComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <section class="how card" aria-labelledby="how-h">
      <span class="how-icon" aria-hidden="true"><app-icon name="shield" [size]="22" /></span>
      <div>
        <h2 id="how-h">How roles work</h2>
        <ul>
          <li>Everyone signs up as a <strong>Student</strong> — nobody picks their own role.</li>
          <li>Admins grant <strong>Instructor</strong> or <strong>Admin</strong> here, or send a <a routerLink="../staff-invites">staff invite</a> to someone new.</li>
          <li>Instructors only manage courses they’ve been added to. Admins can manage everything.</li>
          <li>Role changes and locks reach the person’s open sessions within about a minute.</li>
        </ul>
      </div>
    </section>

    <form class="filters" role="search" (ngSubmit)="apply()">
      <mat-form-field class="q">
        <mat-label>Search by name or email</mat-label>
        <app-icon matPrefix name="search" [size]="18" class="pre" />
        <input matInput name="q" [ngModel]="query()" (ngModelChange)="onQuery($event)" autocomplete="off" />
      </mat-form-field>
      <mat-form-field>
        <mat-label>Role</mat-label>
        <mat-select [value]="role()" (valueChange)="role.set($event); apply()">
          <mat-option value="">All roles</mat-option>
          <mat-option value="Student">Student</mat-option>
          <mat-option value="Instructor">Instructor</mat-option>
          <mat-option value="Admin">Admin</mat-option>
        </mat-select>
      </mat-form-field>
      <mat-form-field>
        <mat-label>Status</mat-label>
        <mat-select [value]="status()" (valueChange)="status.set($event); apply()">
          <mat-option value="">Any status</mat-option>
          <mat-option value="active">Active</mat-option>
          <mat-option value="pending_guardian">Waiting for guardian</mat-option>
          <mat-option value="deleted">Deleted</mat-option>
        </mat-select>
      </mat-form-field>
    </form>

    @switch (users.status()) {
      @case ('loading') { <app-skeleton [lines]="8" /> }
      @case ('error') { <app-error-state [error]="users.error()" title="We couldn’t load users" (retry)="users.load()" /> }
      @default {
        @if (users.data(); as page) {
          @if (page.items.length) {
            <div class="card list-card">
              <ul class="people" role="list" aria-label="Users">
                @for (u of page.items; track u.id) {
                  <li>
                    <span class="avatar" aria-hidden="true">{{ initials(u.displayName) }}</span>
                    <span class="who">
                      <span class="nm">{{ u.displayName }}</span>
                      <span class="em">{{ u.email }}</span>
                    </span>
                    <span class="roles">
                      @for (r of u.roles; track r) { <span class="pill" [class.neutral]="r === 'Student'">{{ r }}</span> }
                    </span>
                    <span class="status">
                      @for (s of pills(u); track s.label) { <span class="pill" [class]="s.tone">{{ s.label }}</span> }
                    </span>
                    <span class="seen muted small">{{ u.lastActiveAt ? 'Active ' + (u.lastActiveAt | date: 'd MMM') : 'Never signed in' }}</span>
                    <button matButton="outlined" type="button" (click)="openUser(u.id)" [attr.aria-label]="'Manage ' + u.displayName">Manage</button>
                  </li>
                }
              </ul>
            </div>
            <nav class="pager" aria-label="Pages of users">
              <button matButton="outlined" type="button" (click)="prev()" [disabled]="cursors().length === 0"><app-icon name="chevron-left" [size]="18" /> Previous</button>
              <span class="muted small num" aria-live="polite">Showing {{ from() }}–{{ from() + page.items.length - 1 }}</span>
              <button matButton="outlined" type="button" (click)="next()" [disabled]="!page.nextCursor">Next <app-icon name="chevron-right" [size]="18" /></button>
            </nav>
          } @else {
            <app-empty-state icon="users" title="No one matches" text="Try a different name, email, role or status." />
          }
        }
      }
    }

    @if (openId(); as id) {
      <app-user-drawer [userId]="id" (closed)="openId.set(null)" (changed)="onChanged($event)" />
    }
  `,
  styles: `
    .how {
      display: flex;
      gap: 16px;
      align-items: flex-start;
      margin-bottom: 18px;
      background: var(--surface-2);
      h2 {
        font-size: 1.05rem;
        margin-bottom: 6px;
      }
      ul {
        margin: 0;
        padding-left: 18px;
        display: flex;
        flex-direction: column;
        gap: 4px;
        color: var(--muted);
        strong {
          color: var(--ink);
        }
      }
    }
    .how-icon {
      display: grid;
      place-items: center;
      flex: none;
      width: 44px;
      height: 44px;
      border-radius: 14px;
      background: var(--primary-soft);
      color: var(--primary-ink);
    }
    .filters {
      display: grid;
      grid-template-columns: minmax(0, 2fr) minmax(0, 1fr) minmax(0, 1fr);
      gap: 12px;
      margin-bottom: 14px;
      @media (max-width: 719.98px) {
        grid-template-columns: 1fr 1fr;
        .q {
          grid-column: 1 / -1;
        }
      }
    }
    .pre {
      margin: 0 6px 0 12px;
      color: var(--muted);
    }
    .list-card {
      padding: 6px 18px;
    }
    .people {
      list-style: none;
      margin: 0;
      padding: 0;
      li {
        display: grid;
        grid-template-columns: 40px minmax(0, 1.6fr) minmax(0, 1fr) minmax(0, 1.2fr) 110px auto;
        align-items: center;
        gap: 12px;
        padding: 12px 0;
        border-bottom: 1px solid var(--border);
        &:last-child {
          border-bottom: 0;
        }
        @media (max-width: 959.98px) {
          grid-template-columns: 40px minmax(0, 1fr) auto;
          .roles,
          .status,
          .seen {
            grid-column: 2 / 3;
          }
          button {
            grid-row: 1;
            grid-column: 3;
          }
        }
      }
    }
    .avatar {
      display: grid;
      place-items: center;
      width: 40px;
      height: 40px;
      border-radius: 50%;
      background: var(--primary-soft);
      color: var(--primary-soft-ink);
      font-weight: 700;
      font-size: 0.85rem;
    }
    .who {
      display: flex;
      flex-direction: column;
      min-width: 0;
    }
    .nm {
      font-weight: 600;
    }
    .em {
      font-size: 0.85rem;
      color: var(--muted);
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .roles,
    .status {
      display: flex;
      flex-wrap: wrap;
      gap: 4px;
    }
    .pager {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      margin-top: 14px;
    }
  `,
})
export default class UsersComponent {
  private readonly api = inject(AdminApi);

  readonly query = signal('');
  readonly role = signal<Role | ''>('');
  readonly status = signal('');
  /** Cursors of the pages before the current one (cursor paging has no "previous"). */
  readonly cursors = signal<(string | null)[]>([]);
  private readonly cursor = signal<string | null>(null);
  readonly openId = signal<string | null>(null);
  readonly from = computed(() => this.cursors().length * PAGE + 1);
  private debounce: ReturnType<typeof setTimeout> | null = null;

  readonly users = createLoader(() => this.api.users({ query: this.query().trim(), role: this.role(), status: this.status(), cursor: this.cursor(), limit: PAGE }));
  readonly pills = statusPills;

  constructor() {
    inject(DestroyRef).onDestroy(() => this.debounce && clearTimeout(this.debounce));
  }

  onQuery(v: string): void {
    this.query.set(v);
    if (this.debounce) clearTimeout(this.debounce);
    this.debounce = setTimeout(() => this.apply(), 300);
  }
  apply(): void {
    this.cursors.set([]);
    this.cursor.set(null);
    this.users.load();
  }
  next(): void {
    const n = this.users.data()?.nextCursor;
    if (!n) return;
    this.cursors.update((c) => [...c, this.cursor()]);
    this.cursor.set(n);
    this.users.load();
  }
  prev(): void {
    const stack = this.cursors();
    if (!stack.length) return;
    this.cursor.set(stack[stack.length - 1]);
    this.cursors.set(stack.slice(0, -1));
    this.users.load();
  }
  openUser(id: string): void {
    this.openId.set(id);
  }
  onChanged(u: AdminUser): void {
    this.users.update((p) => ({ ...p, items: p.items.map((x) => (x.id === u.id ? { ...x, ...u } : x)) }));
  }
  initials(name: string): string {
    return name
      .split(/\s+/)
      .map((p) => p[0])
      .slice(0, 2)
      .join('')
      .toUpperCase();
  }
}
