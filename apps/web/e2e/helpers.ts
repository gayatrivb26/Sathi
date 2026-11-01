import AxeBuilder from '@axe-core/playwright';
import { expect, Page } from '@playwright/test';

export const DESKTOP = { width: 1440, height: 900 };
export const PHONE = { width: 390, height: 844 };

export type DemoUser = 'asha@sathi.dev' | 'new@sathi.dev' | 'instructor@sathi.dev' | 'admin@sathi.dev';

/** Signs in through the real form (mock API accepts any password except "wrong"). */
export async function signIn(page: Page, email: DemoUser = 'asha@sathi.dev', expectUrl: RegExp = /\/home$/): Promise<void> {
  await page.goto('/auth/sign-in');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password', { exact: true }).fill('demo-password-1');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page).toHaveURL(expectUrl);
}

/** WCAG 2.2 AA scan of the current page. Fails on serious/critical violations. */
export async function expectAccessible(page: Page, context: string): Promise<void> {
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
    .exclude('.cdk-overlay-container')
    .analyze();
  const serious = results.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
  const summary = serious.map((v) => `${v.id}: ${v.help}\n  ${v.nodes.slice(0, 3).map((n) => n.target.join(' ')).join('\n  ')}`).join('\n');
  expect(serious, `${context} — accessibility violations:\n${summary}`).toEqual([]);
}

/** Waits until skeleton placeholders are gone. */
export async function settle(page: Page): Promise<void> {
  await page.locator('#main-content').first().waitFor({ state: 'attached', timeout: 15_000 }).catch(() => undefined);
  await page.waitForTimeout(350); // let the route's first request start
  await expect(page.locator('.skeleton')).toHaveCount(0, { timeout: 15_000 }).catch(() => undefined);
}
