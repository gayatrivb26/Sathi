import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { RouterLink } from '@angular/router';
import { LearningApi } from '../../core/api/learning.api';
import { AuthStore } from '../../core/auth/auth.store';
import { createLoader } from '../../core/platform/loader';
import { STUDY_ICON, STUDY_LABEL, StudyNavigator } from '../../shared/study/study-navigator.service';
import { IconComponent } from '../../shared/ui/icon/icon.component';
import { MasteryBarComponent } from '../../shared/ui/mastery/mastery-bar.component';
import { isPractised } from '../../shared/ui/mastery/mastery-labels';
import { EmptyStateComponent } from '../../shared/ui/states/empty-state.component';
import { ErrorStateComponent } from '../../shared/ui/states/error-state.component';
import { SkeletonComponent } from '../../shared/ui/states/skeleton.component';

export function greeting(hour: number): string {
  if (hour < 5) return 'Up late';
  if (hour < 12) return 'Good morning';
  if (hour < 17) return 'Good afternoon';
  return 'Good evening';
}

@Component({
  selector: 'app-home',
  imports: [RouterLink, MatButtonModule, IconComponent, MasteryBarComponent, SkeletonComponent, ErrorStateComponent, EmptyStateComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './home.component.html',
  styleUrl: './home.component.scss',
})
export default class HomeComponent {
  private readonly api = inject(LearningApi);
  readonly auth = inject(AuthStore);
  readonly study = inject(StudyNavigator);
  readonly home = createLoader(() => this.api.home(this.auth.activeCourseId()));
  readonly greeting = greeting(new Date().getHours());
  readonly icon = STUDY_ICON;
  readonly label = STUDY_LABEL;

  readonly noCourse = computed(() => this.home.error()?.code === 'NOT_FOUND');
  /** Only practised topics have a real score; untried ones are counted, not shown as 30 %. */
  readonly masteryTop = computed(() => (this.home.data()?.mastery ?? []).filter(isPractised).slice(0, 6));
  readonly untriedCount = computed(() => (this.home.data()?.mastery ?? []).filter((m) => !isPractised(m)).length);
}
