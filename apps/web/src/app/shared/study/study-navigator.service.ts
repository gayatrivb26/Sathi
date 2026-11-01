import { inject, Injectable, signal } from '@angular/core';
import { Router } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import { LearningApi } from '../../core/api/learning.api';
import { StudyNextItem } from '../../core/models/api.models';
import { IconName } from '../ui/icon/icons';

export const STUDY_ICON: Record<StudyNextItem['type'], IconName> = {
  lesson: 'book',
  concept_practice: 'target',
  quiz: 'check-circle',
  revision: 'repeat',
};
export const STUDY_LABEL: Record<StudyNextItem['type'], string> = {
  lesson: 'Lesson',
  concept_practice: 'Practice',
  quiz: 'Quiz',
  revision: 'Revision',
};

/** Opens a "study next" suggestion: lesson, practice session, lesson-check quiz or revision. */
@Injectable({ providedIn: 'root' })
export class StudyNavigator {
  private readonly api = inject(LearningApi);
  private readonly router = inject(Router);
  readonly busyId = signal<string | null>(null);

  async open(item: StudyNextItem, courseId: string): Promise<void> {
    switch (item.type) {
      case 'lesson':
        await this.router.navigate(['/lessons', item.targetId]);
        return;
      case 'revision':
        await this.router.navigate(['/revision']);
        return;
      case 'concept_practice':
      case 'quiz': {
        this.busyId.set(item.targetId);
        try {
          const body = item.type === 'quiz' ? { courseId, lessonId: item.targetId } : { courseId, conceptId: item.targetId };
          const attempt = await firstValueFrom(this.api.startPractice(body));
          await this.router.navigate(['/practice', attempt.attemptId]);
        } catch {
          /* the error interceptor already showed a toast with the reference ID */
        } finally {
          this.busyId.set(null);
        }
      }
    }
  }
}
