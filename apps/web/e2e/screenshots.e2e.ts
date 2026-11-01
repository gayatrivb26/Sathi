import { expect, Page, test } from '@playwright/test';
import { DESKTOP, PHONE, settle, signIn } from './helpers';

/**
 * Visual tour: captures every main screen at desktop (1440×900) and phone (390×844) widths
 * into e2e/screenshots/. Run with: npx playwright test screenshots
 */
const DIR = 'e2e/screenshots';

async function shoot(page: Page, name: string, fullPage = true): Promise<void> {
  await settle(page);
  await page.waitForTimeout(400); // let transitions finish
  const w = page.viewportSize()?.width ?? 0;
  await page.screenshot({ path: `${DIR}/${name}-${w < 720 ? 'phone' : 'desktop'}.png`, fullPage });
}

for (const [label, size] of [
  ['desktop', DESKTOP],
  ['phone', PHONE],
] as const) {
  test.describe(`screens @ ${label}`, () => {
    test.use({ viewport: size });

    test('auth screens', async ({ page }) => {
      await page.goto('/auth/sign-in');
      await expect(page.getByRole('heading', { name: 'Welcome back' })).toBeVisible();
      await shoot(page, 'sign-in');
      await page.goto('/auth/register');
      await page.getByLabel('Password', { exact: true }).fill('abc');
      await shoot(page, 'register');
      await page.goto('/auth/check-email?email=student%40example.com');
      await shoot(page, 'check-email');
      await page.goto('/auth/reset-password?email=student%40example.com&token=t');
      await shoot(page, 'reset-password');
    });

    test('onboarding', async ({ page }) => {
      await signIn(page, 'new@sathi.dev', /\/onboarding$/);
      await page.getByRole('button', { name: /AI Engineering/ }).click();
      await shoot(page, 'onboarding-course');
      await page.getByRole('button', { name: 'Continue' }).click();
      await expect(page.getByRole('heading', { name: /How should Sathi explain/ })).toBeVisible();
      await shoot(page, 'onboarding-level');
      await page.getByRole('button', { name: 'Continue' }).click();
      await page.getByRole('button', { name: 'Start the check' }).click();
      await expect(page.getByText(/Question 1 of/)).toBeVisible();
      await page.locator('label.opt').nth(1).click();
      await page.getByRole('button', { name: 'Check answer' }).click();
      await expect(page.getByRole('button', { name: /Next question/ })).toBeVisible();
      await shoot(page, 'onboarding-quiz');
      await page.getByRole('button', { name: 'Skip the rest of the check' }).click();
      await expect(page.getByRole('heading', { name: 'Here’s your starting point' })).toBeVisible();
      await shoot(page, 'onboarding-results');
    });

    test('student screens', async ({ page }) => {
      await signIn(page);
      await shoot(page, 'home');
      await page.goto('/course');
      await shoot(page, 'course');
      await page.goto('/lessons/les-attention');
      await expect(page.getByRole('heading', { name: 'Attention mechanisms', level: 1 })).toBeVisible();
      await shoot(page, 'lesson', false);
      await page.goto('/progress');
      await shoot(page, 'progress');
      await page.goto('/revision');
      await shoot(page, 'revision');
      await page.goto('/notes');
      await shoot(page, 'notes');
      await page.goto('/settings');
      await shoot(page, 'settings');
      await page.goto('/practice');
      await shoot(page, 'practice-picker');
    });

    test('tutor', async ({ page }) => {
      await signIn(page);
      await page.goto('/tutor?lessonId=les-attention');
      await shoot(page, 'tutor-empty', false);
      await page.getByRole('switch', { name: /Search the web/ }).click();
      await page.getByLabel('Ask the tutor').fill('Why do we divide by the square root of d in attention?');
      await page.keyboard.press('Enter');
      await expect(page.getByRole('button', { name: 'Simpler' })).toBeVisible({ timeout: 30_000 });
      await shoot(page, 'tutor-answer', false);
    });

    test('practice', async ({ page }) => {
      await signIn(page);
      await page.goto('/practice');
      await page.getByRole('button', { name: 'Practise Backpropagation' }).click();
      await expect(page.getByText('Question 1 of')).toBeVisible();
      await page.getByRole('radio', { name: /Weights are updated before gradients exist/ }).check();
      await page.getByRole('button', { name: 'Check answer' }).click();
      await expect(page.getByRole('heading', { name: 'Why B' })).toBeVisible();
      await shoot(page, 'practice-answer');
    });

    test('dark theme home', async ({ page }) => {
      await page.emulateMedia({ colorScheme: 'dark' });
      await signIn(page);
      await shoot(page, 'home-dark');
      await page.goto('/notes');
      await shoot(page, 'notes-dark');
    });

    test('instructor screens', async ({ page }) => {
      await signIn(page, 'instructor@sathi.dev');
      await page.goto('/teach/content');
      await page.getByRole('button', { name: 'Attention mechanisms' }).click();
      await expect(page.getByRole('heading', { name: 'Edit lesson' })).toBeVisible();
      await shoot(page, 'teach-content', false);
      await page.goto('/teach/questions');
      await shoot(page, 'teach-questions', false);
      await page.goto('/teach/grading');
      await shoot(page, 'teach-grading', false);
      await page.goto('/teach/insights');
      await shoot(page, 'teach-insights');
    });

    test('release 2: tutor composer, stop and history', async ({ page }) => {
      await signIn(page);
      await page.goto('/tutor');
      await page.getByLabel('Ask the tutor').fill(['Can you compare attention and convolution?', 'I want: the intuition,', 'the maths for one head,', 'and when each one is the better choice.'].join('\n'));
      await shoot(page, 'r2-tutor-composer', false);
      await page.getByLabel('Ask the tutor').fill('This will be slow');
      await page.keyboard.press('Enter');
      await expect(page.getByText('Writing your answer…')).toBeVisible();
      await page.getByRole('button', { name: 'Stop' }).click();
      await expect(page.getByText('You stopped this answer.')).toBeVisible();
      await shoot(page, 'r2-tutor-stopped', false);
      await page.getByRole('button', { name: /History/ }).click();
      await page.getByRole('dialog').getByRole('button', { name: 'Load older conversations' }).click();
      await expect(page.getByRole('dialog').getByText('KV cache', { exact: true })).toBeVisible();
      await shoot(page, 'r2-tutor-history', false);
      await page.getByRole('dialog').getByRole('button', { name: /^What is a mixture of experts/ }).click();
      await expect(page.getByText('This answer was interrupted. Try again.')).toBeVisible();
      await shoot(page, 'r2-tutor-interrupted', false);
    });

    test('release 2: student classes and practice', async ({ page }) => {
      await signIn(page);
      await page.goto('/practice');
      await shoot(page, 'r2-practice-picker');
      await page.goto('/join?code=DEEP-LAB7');
      await shoot(page, 'r2-join');
      await page.getByRole('button', { name: 'Join class' }).click();
      await expect(page.getByRole('heading', { name: /You’ve joined/ })).toBeVisible();
      await shoot(page, 'r2-join-done');
      await page.goto('/settings');
      await shoot(page, 'r2-settings');
      await page.goto('/home');
      await shoot(page, 'r2-home');
    });

    test('release 2: invites, consent and minors', async ({ page }) => {
      await page.goto('/join/demo-class-invite');
      await expect(page.getByRole('heading', { name: 'Join Monday cohort' })).toBeVisible();
      await shoot(page, 'r2-class-invite');
      await page.goto('/auth/register?staffInvite=demo-staff-invite');
      await expect(page.getByText('You’re invited to teach on Sathi')).toBeVisible();
      await shoot(page, 'r2-register-staff-invite');
      await page.goto('/auth/register');
      await page.getByLabel('Date of birth').fill('2012-05-01');
      await expect(page.getByText('A parent or guardian needs to approve')).toBeVisible();
      await shoot(page, 'r2-register-minor');
      await page.goto('/auth/check-email?email=tanvi%40example.in&guardian=1');
      await shoot(page, 'r2-check-email-guardian');
      await page.goto('/consent/demo-consent');
      await expect(page.getByRole('heading', { name: /would like to learn with Sathi/ })).toBeVisible();
      await shoot(page, 'r2-consent');
      await page.getByRole('button', { name: 'I approve' }).click();
      await expect(page.getByRole('button', { name: 'Withdraw consent' })).toBeVisible();
      await shoot(page, 'r2-consent-granted');
    });

    test('release 2: teach courses and classes', async ({ page }) => {
      await signIn(page, 'instructor@sathi.dev');
      await page.goto('/teach/classes');
      await page.getByRole('button', { name: /^Monday cohort/ }).click();
      await expect(page.locator('.join-code.big')).toBeVisible();
      await shoot(page, 'r2-teach-classes');
      await page.goto('/teach/settings');
      await expect(page.getByRole('heading', { name: 'Co-instructors' })).toBeVisible();
      await shoot(page, 'r2-teach-settings');
      await page.getByRole('button', { name: 'New course' }).first().click();
      await page.getByRole('dialog').getByLabel('Title').fill('Robotics Club');
      await shoot(page, 'r2-teach-new-course', false);
    });

    test('release 2: admin users and staff invites', async ({ page }) => {
      await signIn(page, 'admin@sathi.dev');
      await page.goto('/admin/users');
      await shoot(page, 'r2-admin-users');
      await page.getByLabel('Search by name or email').fill('rahul');
      await page.getByRole('button', { name: 'Manage Rahul Nair' }).click();
      await expect(page.getByRole('dialog', { name: 'Rahul Nair' }).getByRole('checkbox', { name: 'Instructor' })).toBeVisible();
      await shoot(page, 'r2-admin-user-drawer', false);
      await page.keyboard.press('Escape');
      await page.goto('/admin/staff-invites');
      await shoot(page, 'r2-admin-staff-invites');
    });

    test('admin screens', async ({ page }) => {
      await signIn(page, 'admin@sathi.dev');
      await page.goto('/admin/lookup/7F3A-91C2');
      await expect(page.getByText('INGEST_NO_TEXT').first()).toBeVisible();
      await shoot(page, 'admin-run');
      await page.goto('/admin/runs');
      await shoot(page, 'admin-runs');
      await page.goto('/admin/usage');
      await shoot(page, 'admin-usage');
      await page.goto('/no-such-page');
      await shoot(page, 'not-found');
    });
  });
}
