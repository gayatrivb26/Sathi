import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { RouterOutlet } from '@angular/router';
import { OnlineService } from './core/platform/online.service';
import { ThemeService } from './core/platform/theme.service';

@Component({
  selector: 'app-root',
  imports: [RouterOutlet],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `<router-outlet />`,
})
export class App {
  constructor() {
    // Eagerly create app-wide services that react to the environment.
    inject(ThemeService);
    inject(OnlineService);
  }
}
