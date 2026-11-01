import { ChangeDetectionStrategy, Component, computed, effect, inject, signal, untracked } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatDialog } from '@angular/material/dialog';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatSelectModule } from '@angular/material/select';
import { RouterLink } from '@angular/router';
import { firstValueFrom, of } from 'rxjs';
import { LearningApi } from '../../core/api/learning.api';
import { InstructorApi } from '../../core/api/staff.api';
import { Notifier } from '../../core/errors/notifier.service';
import { CourseDetail } from '../../core/models/api.models';
import { createLoader } from '../../core/platform/loader';
import { confirmDialog } from '../../shared/ui/dialog/confirm-dialog.component';
import { IconComponent } from '../../shared/ui/icon/icon.component';
import { MarkdownViewComponent } from '../../shared/ui/markdown/markdown-view.component';
import { EmptyStateComponent } from '../../shared/ui/states/empty-state.component';
import { ErrorStateComponent } from '../../shared/ui/states/error-state.component';
import { SkeletonComponent } from '../../shared/ui/states/skeleton.component';
import { TeachContext } from './teach-context.service';

type Selection = { kind: 'course' } | { kind: 'concepts' } | { kind: 'lesson'; id: string; moduleId: string };

interface LessonForm {
  id: string;
  moduleId: string;
  title: string;
  summary: string;
  estimatedMinutes: number;
  position: number;
  conceptIds: string[];
  objectives: string[];
  contentMarkdown: string;
}

const slugify = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

@Component({
  selector: 'app-course-editor',
  imports: [FormsModule, MatButtonModule, MatFormFieldModule, MatInputModule, MatSelectModule, RouterLink, IconComponent, MarkdownViewComponent, SkeletonComponent, ErrorStateComponent, EmptyStateComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './course-editor.component.html',
  styleUrl: './course-editor.component.scss',
})
export default class CourseEditorComponent {
  private readonly api = inject(InstructorApi);
  private readonly learning = inject(LearningApi);
  private readonly notifier = inject(Notifier);
  private readonly dialog = inject(MatDialog);
  readonly ctx = inject(TeachContext);

  readonly structure = createLoader<CourseDetail | null>(() => {
    const id = this.ctx.courseId();
    return id ? this.learning.course(id) : of(null);
  }, { immediate: false });

  readonly selection = signal<Selection>({ kind: 'course' });
  readonly lesson = signal<LessonForm | null>(null);
  readonly lessonLoading = signal(false);
  readonly dirty = signal(false);
  readonly saving = signal(false);
  readonly view = signal<'write' | 'preview'>('write');

  // new concept form
  readonly nName = signal('');
  readonly nDesc = signal('');

  readonly concepts = computed(() => this.structure.data()?.concepts ?? []);
  readonly lessonCount = computed(() => (this.structure.data()?.modules ?? []).reduce((n, m) => n + m.lessons.length, 0));

  constructor() {
    effect(() => {
      this.ctx.courseId();
      untracked(() => {
        this.selection.set({ kind: 'course' });
        this.lesson.set(null);
        this.structure.load();
      });
    });
  }

  isLesson(id: string): boolean {
    const s = this.selection();
    return s.kind === 'lesson' && s.id === id;
  }

  async selectLesson(id: string, moduleId: string): Promise<void> {
    if (!(await this.confirmDiscard())) return;
    this.selection.set({ kind: 'lesson', id, moduleId });
    this.lessonLoading.set(true);
    this.dirty.set(false);
    try {
      const l = await firstValueFrom(this.learning.lesson(id));
      this.lesson.set({ id: l.id, moduleId, title: l.title, summary: l.summary, estimatedMinutes: l.estimatedMinutes, position: l.position, conceptIds: l.concepts.map((c) => c.id), objectives: [...l.objectives], contentMarkdown: l.contentMarkdown });
    } catch {
      this.notifier.error('We couldn’t open that lesson.');
      this.selection.set({ kind: 'course' });
    } finally {
      this.lessonLoading.set(false);
    }
  }

  async select(kind: 'course' | 'concepts'): Promise<void> {
    if (!(await this.confirmDiscard())) return;
    this.selection.set({ kind });
    this.lesson.set(null);
    this.dirty.set(false);
  }

  private async confirmDiscard(): Promise<boolean> {
    if (!this.dirty()) return true;
    const ok = await firstValueFrom(confirmDialog(this.dialog, { title: 'Discard unsaved changes?', message: 'Your edits to this lesson haven’t been saved.', confirmText: 'Discard' }));
    return !!ok;
  }

  patchLesson(patch: Partial<LessonForm>): void {
    this.lesson.update((l) => (l ? { ...l, ...patch } : l));
    this.dirty.set(true);
  }
  setObjective(i: number, text: string): void {
    const l = this.lesson();
    if (!l) return;
    const objectives = [...l.objectives];
    objectives[i] = text;
    this.patchLesson({ objectives });
  }
  addObjective(): void {
    const l = this.lesson();
    if (l) this.patchLesson({ objectives: [...l.objectives, ''] });
  }
  removeObjective(i: number): void {
    const l = this.lesson();
    if (l) this.patchLesson({ objectives: l.objectives.filter((_, idx) => idx !== i) });
  }

  async saveLesson(): Promise<void> {
    const l = this.lesson();
    if (!l || !l.title.trim()) return;
    this.saving.set(true);
    try {
      await firstValueFrom(
        this.api.updateLesson(l.id, { title: l.title.trim(), summary: l.summary, contentMarkdown: l.contentMarkdown, estimatedMinutes: l.estimatedMinutes, position: l.position, conceptIds: l.conceptIds, objectives: l.objectives.map((o) => o.trim()).filter(Boolean) }),
      );
      this.dirty.set(false);
      this.notifier.success('Lesson saved. The tutor will use the new version in a minute or two.');
      this.structure.update((c) => (c ? { ...c, modules: c.modules.map((m) => ({ ...m, lessons: m.lessons.map((x) => (x.id === l.id ? { ...x, title: l.title, estimatedMinutes: l.estimatedMinutes } : x)) })) } : c));
    } catch {
      /* toast shown */
    } finally {
      this.saving.set(false);
    }
  }

  async addLesson(moduleId: string): Promise<void> {
    const mod = this.structure.data()?.modules.find((m) => m.id === moduleId);
    const position = (mod?.lessons.length ?? 0) + 1;
    try {
      const created = await firstValueFrom(this.api.createLesson(moduleId, { title: 'Untitled lesson', summary: '', contentMarkdown: '## New lesson\n\nStart writing here. Use `$...$` for inline maths and `$$...$$` for display maths.', estimatedMinutes: 10, position, conceptIds: [], objectives: [] }));
      this.structure.load();
      await this.selectLesson(created.id, moduleId);
    } catch {
      /* toast shown */
    }
  }

  async deleteLesson(): Promise<void> {
    const l = this.lesson();
    if (!l) return;
    const ok = await firstValueFrom(confirmDialog(this.dialog, { title: `Delete “${l.title}”?`, message: 'Students lose their progress on this lesson and the tutor stops citing it.', confirmText: 'Delete lesson', danger: true }));
    if (!ok) return;
    await firstValueFrom(this.api.deleteLesson(l.id)).catch(() => undefined);
    this.dirty.set(false);
    this.lesson.set(null);
    this.selection.set({ kind: 'course' });
    this.structure.load();
  }

  async addModule(): Promise<void> {
    const id = this.ctx.courseId();
    if (!id) return;
    const position = (this.structure.data()?.modules.length ?? 0) + 1;
    try {
      await firstValueFrom(this.api.createModule(id, { title: `Module ${position}`, summary: 'Describe this module.', position }));
      this.structure.load();
      this.notifier.success('Module added.');
    } catch {
      /* toast shown */
    }
  }

  async deleteModule(id: string, title: string): Promise<void> {
    const ok = await firstValueFrom(confirmDialog(this.dialog, { title: `Delete module “${title}”?`, message: 'All lessons in this module are deleted too.', confirmText: 'Delete module', danger: true }));
    if (!ok) return;
    await firstValueFrom(this.api.deleteModule(id)).catch(() => undefined);
    this.structure.load();
  }

  async addConcept(): Promise<void> {
    const id = this.ctx.courseId();
    const name = this.nName().trim();
    if (!id || !name) return;
    try {
      const c = await firstValueFrom(this.api.createConcept(id, { name, slug: slugify(name), description: this.nDesc().trim(), prerequisiteIds: [] }));
      this.structure.update((s) => (s ? { ...s, concepts: [...s.concepts, c] } : s));
      this.nName.set('');
      this.nDesc.set('');
      this.notifier.success(`Concept “${c.name}” added.`);
    } catch {
      /* toast shown */
    }
  }

  async saveConcept(id: string, name: string, description: string, slug: string): Promise<void> {
    try {
      const c = await firstValueFrom(this.api.updateConcept(id, { name, description, slug, prerequisiteIds: [] }));
      this.structure.update((s) => (s ? { ...s, concepts: s.concepts.map((x) => (x.id === id ? c : x)) } : s));
      this.notifier.success('Concept saved.');
    } catch {
      /* toast shown */
    }
  }
}
