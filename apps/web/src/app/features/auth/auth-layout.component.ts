import { ChangeDetectionStrategy, Component } from '@angular/core';
import { RouterOutlet } from '@angular/router';
import { IconComponent } from '../../shared/ui/icon/icon.component';
import { LogoComponent } from '../../shared/ui/logo/logo.component';
import { OfflineBannerComponent } from '../../layout/offline-banner.component';

@Component({
  selector: 'app-auth-layout',
  imports: [RouterOutlet, LogoComponent, IconComponent, OfflineBannerComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="auth">
      <aside class="brand" aria-label="About Sathi">
        <app-logo [onDark]="true" />
        <div class="pitch">
          <h2>Learn with a companion that shows its sources.</h2>
          <ul>
            <li><span class="dot"><app-icon name="sparkles" [size]="18" /></span> Explanations at your level — simpler or deeper on demand.</li>
            <li><span class="dot"><app-icon name="book" [size]="18" /></span> Every answer cites your course, your notes or the web.</li>
            <li><span class="dot"><app-icon name="target" [size]="18" /></span> Practice that adapts to what you still need to learn.</li>
          </ul>
        </div>
        <p class="foot">Your notes stay private to you.</p>
        <div class="orb one" aria-hidden="true"></div>
        <div class="orb two" aria-hidden="true"></div>
      </aside>
      <main class="panel" id="main-content" tabindex="-1">
        <app-offline-banner />
        <div class="mobile-logo"><app-logo /></div>
        <div class="card form-card">
          <router-outlet />
        </div>
      </main>
    </div>
  `,
  styles: `
    .auth {
      display: grid;
      grid-template-columns: minmax(340px, 0.9fr) 1.1fr;
      min-height: 100vh;
    }
    .brand {
      position: relative;
      overflow: hidden;
      display: flex;
      flex-direction: column;
      justify-content: space-between;
      padding: 40px 48px;
      background: #12192b;
      color: #dfe3f0;
    }
    .pitch {
      position: relative;
      z-index: 1;
      max-width: 420px;
      h2 {
        color: #fff;
        font-size: clamp(1.6rem, 1.2rem + 1.4vw, 2.3rem);
        line-height: 1.15;
        margin-bottom: 28px;
      }
      ul {
        list-style: none;
        margin: 0;
        padding: 0;
        display: flex;
        flex-direction: column;
        gap: 16px;
      }
      li {
        display: flex;
        gap: 12px;
        align-items: flex-start;
        line-height: 1.45;
      }
    }
    .dot {
      display: grid;
      place-items: center;
      flex: none;
      width: 34px;
      height: 34px;
      border-radius: 11px;
      background: rgba(255, 181, 71, 0.16);
      color: #ffb547;
    }
    .foot {
      position: relative;
      z-index: 1;
      color: #8d96b3;
      font-size: 0.875rem;
    }
    .orb {
      position: absolute;
      border-radius: 50%;
      filter: blur(2px);
      &.one {
        width: 420px;
        height: 420px;
        right: -180px;
        top: -120px;
        background: radial-gradient(circle at 30% 30%, rgba(106, 63, 224, 0.55), transparent 65%);
      }
      &.two {
        width: 360px;
        height: 360px;
        left: -140px;
        bottom: -160px;
        background: radial-gradient(circle at 60% 40%, rgba(255, 181, 71, 0.28), transparent 65%);
      }
    }
    .panel {
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      padding: 40px 24px;
      outline: none;
    }
    app-offline-banner {
      align-self: stretch;
      margin: -40px -24px 24px;
    }
    .form-card {
      width: 100%;
      max-width: 440px;
      padding: 32px;
    }
    .mobile-logo {
      display: none;
    }
    @media (max-width: 879.98px) {
      .auth {
        grid-template-columns: 1fr;
      }
      .brand {
        display: none;
      }
      .panel {
        justify-content: flex-start;
        padding: 28px 16px;
      }
      .mobile-logo {
        display: block;
        margin-bottom: 20px;
      }
      .form-card {
        padding: 24px 20px;
      }
    }
  `,
})
export class AuthLayoutComponent {}
