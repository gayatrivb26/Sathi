import { computed, effect, inject, Injectable, signal, untracked } from '@angular/core';
import { of } from 'rxjs';
import { InstructorApi } from '../../core/api/staff.api';
import { AuthStore } from '../../core/auth/auth.store';
import { ClassSummary, InstructorCourse } from '../../core/models/api.models';
import { createLoader } from '../../core/platform/loader';

const PICK_KEY = 'sathi.teach.course';

/** Shared state for the Teach area: the instructor's courses, the selected one and its classes. */
@Injectable()
export class TeachContext {
  private readonly api = inject(InstructorApi);
  private readonly auth = inject(AuthStore);
  readonly courses = createLoader(() => this.api.courses());
  private readonly picked = signal<string | null>(readPick());
  readonly pendingReviews = signal<number | null>(null);

  readonly courseId = computed(() => {
    const list = this.courses.data() ?? [];
    const pick = this.picked();
    if (pick && list.some((c) => c.id === pick)) return pick;
    const active = this.auth.activeCourseId();
    return list.find((c) => c.id === active)?.id ?? list[0]?.id ?? null;
  });
  readonly course = computed<InstructorCourse | null>(() => this.courses.data()?.find((c) => c.id === this.courseId()) ?? null);
  /** Owners and Admins manage co-instructors and can delete the course. */
  readonly canManage = computed(() => {
    const r = this.course()?.myRole;
    return r === 'owner' || r === 'admin';
  });

  /** Classes of the selected course (Classes tab, and the class filter on insights and grading). */
  readonly classes = createLoader<ClassSummary[]>(() => {
    const id = this.courseId();
    return id ? this.api.classes(id) : of([]);
  }, { immediate: false });
  readonly activeClasses = computed(() => (this.classes.data() ?? []).filter((c) => !c.archivedAt));

  constructor() {
    effect(() => {
      this.courseId();
      untracked(() => this.classes.load());
    });
  }

  select(id: string): void {
    this.picked.set(id);
    try {
      localStorage.setItem(PICK_KEY, id);
    } catch {
      /* per-device convenience only */
    }
  }

  /** Adds or replaces a course in the list (after create/update). */
  upsert(course: InstructorCourse): void {
    const list = this.courses.data() ?? [];
    if (list.some((c) => c.id === course.id)) this.courses.update((l) => l.map((c) => (c.id === course.id ? course : c)));
    else this.courses.set([...list, course]);
  }

  remove(id: string): void {
    this.courses.update((l) => l.filter((c) => c.id !== id));
    if (this.picked() === id) this.picked.set(null);
  }

  /** Keeps the class count on the course card in step with the Classes tab. */
  setClasses(list: ClassSummary[]): void {
    this.classes.set(list);
    const c = this.course();
    if (c) this.upsert({ ...c, classCount: list.filter((x) => !x.archivedAt).length });
  }
}

function readPick(): string | null {
  try {
    return localStorage.getItem(PICK_KEY);
  } catch {
    return null;
  }
}
