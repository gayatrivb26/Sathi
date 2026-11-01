import AxeBuilder from '@axe-core/playwright';
import { APIRequestContext, expect, Page, request } from '@playwright/test';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export const BASE_URL = process.env['BASE_URL'] ?? 'http://localhost:8080';
export const MAILPIT_URL = process.env['MAILPIT_URL'] ?? 'http://localhost:8025';

export const DEMO_STUDENT = { email: 'demo@sathi.local', password: 'Demo!12345' };
export const DEMO_INSTRUCTOR = { email: 'instructor@sathi.local', password: 'Teach!12345' };
export const PASSWORD = 'Learning2026x';

/** SEED_ADMIN_* from the environment, else from the repo-root .env (never printed). */
export function adminCredentials(): { email: string; password: string } {
  let email = process.env['SATHI_ADMIN_EMAIL'];
  let password = process.env['SATHI_ADMIN_PASSWORD'];
  const envFile = resolve(__dirname, '../../.env');
  if ((!email || !password) && existsSync(envFile)) {
    for (const line of readFileSync(envFile, 'utf8').split(/\r?\n/)) {
      const m = /^(SEED_ADMIN_EMAIL|SEED_ADMIN_PASSWORD)=(.*)$/.exec(line);
      if (m?.[1] === 'SEED_ADMIN_EMAIL') email ??= m[2].replace(/^"|"$/g, '');
      if (m?.[1] === 'SEED_ADMIN_PASSWORD') password ??= m[2].replace(/^"|"$/g, '');
    }
  }
  if (!email || !password) throw new Error('Set SATHI_ADMIN_EMAIL/SATHI_ADMIN_PASSWORD or provide SEED_ADMIN_* in .env');
  return { email, password };
}

/** A unique, valid address for this run. */
export function uniqueEmail(prefix: string): string {
  return `${prefix}.${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}@example.com`;
}

/** Signs in through the real form and waits until the app has left the auth pages. */
export async function signIn(page: Page, email: string, password: string, expectUrl: RegExp = /\/(home|onboarding)(\?|$)/): Promise<void> {
  await page.goto('/auth/sign-in');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page).toHaveURL(expectUrl);
}

export async function signOut(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Sign out' }).first().click();
  await expect(page).toHaveURL(/\/auth\/sign-in/);
}

/** WCAG 2.2 AA scan; fails on serious/critical violations. */
export async function expectAccessible(page: Page, context: string): Promise<void> {
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
    .exclude('.cdk-overlay-container')
    .analyze();
  const serious = results.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
  expect(serious, `${context}: ${serious.map((v) => v.id).join(', ')}`).toEqual([]);
}

export async function settle(page: Page): Promise<void> {
  await page.waitForLoadState('networkidle').catch(() => undefined);
  await expect(page.locator('.skeleton')).toHaveCount(0, { timeout: 20_000 }).catch(() => undefined);
}

// ------------------------------------------------------------------ API client (test setup only)

/** A cookie-session API client that behaves like the browser (CSRF cookie → X-XSRF-TOKEN header). */
export class Api {
  private constructor(readonly ctx: APIRequestContext) {}

  static async anonymous(): Promise<Api> {
    const api = new Api(await request.newContext({ baseURL: BASE_URL }));
    await api.ctx.get('/api/v1/auth/csrf');
    return api;
  }

  static async signedIn(email: string, password: string): Promise<Api> {
    const api = await Api.anonymous();
    await api.post('/api/v1/auth/login', { email, password, rememberMe: false }, 200);
    await api.ctx.get('/api/v1/auth/csrf');
    return api;
  }

  private async xsrf(): Promise<string> {
    const state = await this.ctx.storageState();
    return state.cookies.find((c) => c.name === 'XSRF-TOKEN')?.value ?? '';
  }

  async get<T = unknown>(path: string, status = 200): Promise<T> {
    const res = await this.ctx.get(path);
    expect(res.status(), `GET ${path}: ${await res.text()}`).toBe(status);
    return (res.status() === 204 ? undefined : await res.json()) as T;
  }

  async post<T = unknown>(path: string, body: unknown, status?: number): Promise<T> {
    const res = await this.ctx.post(path, {
      data: body,
      headers: { 'X-XSRF-TOKEN': await this.xsrf(), 'Idempotency-Key': `e2e-${Date.now()}-${Math.random()}` },
    });
    if (status !== undefined) expect(res.status(), `POST ${path}: ${await res.text()}`).toBe(status);
    const text = await res.text();
    return (text ? JSON.parse(text) : undefined) as T;
  }

  async status(method: 'GET' | 'DELETE', path: string): Promise<number> {
    const res = method === 'GET' ? await this.ctx.get(path) : await this.ctx.delete(path, { headers: { 'X-XSRF-TOKEN': await this.xsrf() } });
    return res.status();
  }

  async dispose(): Promise<void> {
    await this.ctx.dispose();
  }
}

// ------------------------------------------------------------------ Mailpit

interface MailpitSearch { messages: { ID: string; Subject: string }[] }

/** Polls Mailpit for the newest e-mail to `to` and returns the first link matching `pattern`. */
export async function linkFromEmail(to: string, pattern: RegExp, subjectContains?: string): Promise<string> {
  const deadline = Date.now() + 30_000;
  const ctx = await request.newContext({ baseURL: MAILPIT_URL });
  try {
    while (Date.now() < deadline) {
      const res = await ctx.get(`/api/v1/search?query=${encodeURIComponent(`to:"${to}"`)}`);
      if (res.ok()) {
        const { messages } = (await res.json()) as MailpitSearch;
        for (const m of messages ?? []) {
          if (subjectContains && !m.Subject.toLowerCase().includes(subjectContains.toLowerCase())) continue;
          const msg = (await (await ctx.get(`/api/v1/message/${m.ID}`)).json()) as { Text?: string; HTML?: string };
          const body = `${msg.Text ?? ''}\n${msg.HTML ?? ''}`.replace(/&amp;/g, '&');
          const hit = body.match(new RegExp(`https?://[^\\s"'<>)]*${pattern.source}[^\\s"'<>)]*`));
          if (hit) return hit[0];
        }
      }
      await new Promise((r) => setTimeout(r, 1000));
    }
  } finally {
    await ctx.dispose();
  }
  throw new Error(`No e-mail to ${to} with a link matching ${pattern}`);
}

/** Path + query of an absolute link (the app's base URL in e-mails may differ from BASE_URL). */
export function pathOf(link: string): string {
  const u = new URL(link);
  return u.pathname + u.search;
}

/** Registers an adult through the API and verifies the e-mail through the Mailpit link. */
export async function registerVerifiedStudent(displayName: string, email = uniqueEmail('student')): Promise<{ email: string; password: string; displayName: string }> {
  const api = await Api.anonymous();
  await api.post('/api/v1/auth/register', { email, password: PASSWORD, displayName, dateOfBirth: '1998-03-14' }, 202);
  const link = new URL(await linkFromEmail(email, /\/auth\/verify-email\?/));
  await api.post('/api/v1/auth/verify-email', { userId: link.searchParams.get('userId'), token: link.searchParams.get('token') }, 204);
  await api.dispose();
  return { email, password: PASSWORD, displayName };
}
