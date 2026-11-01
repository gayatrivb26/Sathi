import { expect, test } from '@playwright/test';
import { resolve } from 'node:path';
import {
  adminCredentials, Api, DEMO_INSTRUCTOR, DEMO_STUDENT, expectAccessible, linkFromEmail, PASSWORD, pathOf,
  registerVerifiedStudent, settle, signIn, signOut, uniqueEmail,
} from './support';

const SAMPLES = resolve(__dirname, '../../content/samples');

test.describe('J1 · register, verify, onboarding', () => {
  test('a new adult registers, verifies through the e-mail link, picks a course and level, and takes the check', async ({ page }) => {
    const email = uniqueEmail('meena');
    await page.goto('/auth/register');
    await page.getByLabel('Your name').fill('Meena Joshi');
    await page.getByLabel('Email').first().fill(email);
    await page.getByLabel('Date of birth').fill('1999-04-12');
    await page.getByLabel('Password', { exact: true }).fill(PASSWORD);
    await page.getByRole('button', { name: 'Create account' }).click();
    await expect(page).toHaveURL(/\/auth\/check-email/);

    // Signing in before verifying is refused with a friendly message.
    await signInExpectingAlert(page, email, PASSWORD, /verify|confirm/i);

    await page.goto(pathOf(await linkFromEmail(email, /\/auth\/verify-email\?/)));
    await expect(page.getByRole('heading', { name: /verified/i })).toBeVisible();

    await signIn(page, email, PASSWORD, /\/onboarding$/);
    await page.getByRole('button', { name: /AI Engineering/ }).click();
    await page.getByRole('button', { name: 'Continue' }).click();
    await page.getByRole('button', { name: /Beginner/ }).click();
    await page.getByRole('button', { name: 'Continue' }).click();
    await page.getByRole('button', { name: 'Start the check' }).click();
    await expect(page.getByText(/Question 1 of \d+/)).toBeVisible();
    await page.getByRole('radio').first().check();
    await page.getByRole('button', { name: 'Check answer' }).click();
    await page.getByRole('button', { name: /Next question/ }).click();
    await page.getByRole('button', { name: 'Skip the rest of the check' }).click();
    await expect(page.getByRole('heading', { name: /starting point/ })).toBeVisible();
    await page.getByRole('button', { name: 'Go to my home' }).click();
    await expect(page).toHaveURL(/\/home$/);
    await expect(page.getByRole('heading', { name: /Meena/ })).toBeVisible();
  });
});

test.describe('J2 · home', () => {
  test('the demo student sees continue-lesson, revision and mastery', async ({ page }) => {
    await signIn(page, DEMO_STUDENT.email, DEMO_STUDENT.password);
    await settle(page);
    await expect(page.getByText(/Lesson \d+ of 7/)).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Revision due today' })).toBeVisible();
    await expect(page.getByText(/needs work/).first()).toBeVisible();
    await expectAccessible(page, 'home');
  });
});

test.describe('J3 · tutor', () => {
  test('streams a cited answer from the course, with feedback and a visible New conversation button', async ({ page }) => {
    await signIn(page, DEMO_STUDENT.email, DEMO_STUDENT.password);
    await page.goto('/tutor');
    await expect(page.getByRole('switch', { name: /Search the web/ })).toHaveAttribute('aria-checked', 'false');
    await page.getByLabel('Ask the tutor').fill('Why do we divide by the square root of d_k in scaled dot-product attention?');
    await page.keyboard.press('Enter');
    await expect(page.getByRole('button', { name: 'Simpler' }).first()).toBeVisible({ timeout: 60_000 });
    await expect(page.locator('.answer .cite-chip').first()).toBeVisible();
    await expect(page.getByRole('complementary', { name: 'Sources used' })).toContainText('Course');
    await page.getByRole('button', { name: 'Helpful', exact: true }).first().click();
    await expect(page.getByRole('button', { name: 'Helpful', exact: true }).first()).toHaveAttribute('aria-pressed', 'true');

    await page.getByRole('button', { name: 'New conversation' }).click();
    await expect(page.getByRole('heading', { name: 'What would you like to understand?' })).toBeVisible();
  });

  test('another student cannot open this student’s conversation (isolation)', async () => {
    const owner = await Api.signedIn(DEMO_STUDENT.email, DEMO_STUDENT.password);
    const courses = await owner.get<{ id: string; slug: string }[]>('/api/v1/courses');
    const courseId = courses.find((c) => c.slug === 'ai-engineering')!.id;
    const conv = await owner.post<{ id: string }>('/api/v1/conversations', { courseId }, 201);
    const other = await registerVerifiedStudent('Other Student');
    const intruder = await Api.signedIn(other.email, other.password);
    expect(await intruder.status('GET', `/api/v1/conversations/${conv.id}`)).toBe(404);
    expect(await intruder.status('DELETE', `/api/v1/conversations/${conv.id}`)).toBe(404);
    await owner.dispose();
    await intruder.dispose();
  });
});

test.describe('J4 + J8 · notes and reference lookup', () => {
  test('uploads notes, a scanned PDF fails with a reference ID, and an admin looks it up', async ({ page }) => {
    const student = await registerVerifiedStudent('Notes Student');
    await signIn(page, student.email, student.password);
    await page.goto('/notes');
    await settle(page);

    await page.setInputFiles('#file-input', { name: 'Week 5 notes.md', mimeType: 'text/markdown', buffer: Buffer.from('# Attention\n\nSoftmax turns scores into weights. Dividing by the square root of d_k keeps dot products in range.\n') });
    const good = page.locator('li.file', { hasText: 'Week 5 notes.md' });
    await expect(good).toContainText(/Ready · \d+ passage/, { timeout: 60_000 });

    await page.setInputFiles('#file-input', resolve(SAMPLES, 'Scanned handout.pdf'));
    const scan = page.locator('li.file', { hasText: 'Scanned handout.pdf' });
    await expect(scan).toContainText('Could not read text', { timeout: 60_000 });
    const reference = (await scan.innerText()).match(/[0-9A-F]{4}-[0-9A-F]{4}/)?.[0];
    expect(reference).toBeTruthy();
    await expectAccessible(page, 'notes');
    await signOut(page);

    const admin = adminCredentials();
    await signIn(page, admin.email, admin.password);
    await page.goto('/admin');
    await page.getByLabel('Reference, trace or run ID').fill(reference!);
    await page.getByRole('button', { name: 'Look up' }).click();
    await expect(page.getByText('INGEST_NO_TEXT').first()).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Steps' })).toBeVisible();
  });
});

test.describe('J5 · practice', () => {
  test('answers a question with instant feedback; unpractised topics are not shown as 30 %', async ({ page }) => {
    const student = await registerVerifiedStudent('Practice Student');
    const api = await Api.signedIn(student.email, student.password);
    const courseId = (await api.get<{ id: string; slug: string }[]>('/api/v1/courses')).find((c) => c.slug === 'ai-engineering')!.id;
    await api.post(`/api/v1/courses/${courseId}/enroll`, {}, 200);
    await api.dispose();

    await signIn(page, student.email, student.password);
    await page.goto('/practice');
    await settle(page);
    await expect(page.getByText('Not practised yet').first()).toBeVisible();
    await expect(page.getByText('30%')).toHaveCount(0);

    await page.getByRole('button', { name: 'Practise Backpropagation' }).click();
    await expect(page.getByText(/Question 1 of \d+/)).toBeVisible();
    await page.getByRole('radio').first().check();
    await page.getByRole('button', { name: 'Check answer' }).click();
    await expect(page.locator('label.opt.correct')).toContainText('Correct answer');
    await expect(page.getByText(/Backpropagation mastery/)).toBeVisible();
    await expectAccessible(page, 'practice feedback');
  });
});

test.describe('J6 · revision', () => {
  test('the revision page loads the schedule', async ({ page }) => {
    await signIn(page, DEMO_STUDENT.email, DEMO_STUDENT.password);
    await page.goto('/revision');
    await settle(page);
    await expect(page.getByRole('heading', { name: /due|caught up/i }).first()).toBeVisible();
  });
});

test.describe('J7 · courses, classes and sharing', () => {
  test('an instructor creates a private course and a class; only students who join with the code can open it', async ({ page }) => {
    const title = `E2E Robotics ${Date.now().toString(36)}`;
    const className = 'Saturday group';

    await signIn(page, DEMO_INSTRUCTOR.email, DEMO_INSTRUCTOR.password);
    await page.goto('/teach/content');
    await settle(page);
    await page.getByRole('button', { name: 'New course' }).first().click();
    const dialog = page.getByRole('dialog', { name: 'New course' });
    await dialog.getByLabel('Title').fill(title);
    await dialog.getByRole('radio', { name: /Private/ }).check();
    await dialog.getByRole('switch', { name: 'Draft' }).click(); // publish
    await dialog.getByRole('button', { name: 'Create course' }).click();
    await expect(page.getByText(`“${title}” created.`)).toBeVisible();

    await page.getByRole('link', { name: /Classes/ }).click();
    await page.getByRole('button', { name: 'New class' }).click();
    await page.getByLabel('Class name').fill(className);
    await page.getByRole('button', { name: 'Create class' }).click();
    const code = (await page.locator('.join-code.big').innerText()).trim();
    expect(code).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
    await expectAccessible(page, 'teach classes');
    await signOut(page);

    // A student who has not joined cannot see the private course.
    const outsider = await registerVerifiedStudent('Outsider');
    const outsiderApi = await Api.signedIn(outsider.email, outsider.password);
    const visible = await outsiderApi.get<{ title: string }[]>('/api/v1/courses');
    expect(visible.map((c) => c.title)).not.toContain(title);
    await outsiderApi.dispose();

    // A student joins with the code and gets the course.
    const member = await registerVerifiedStudent('Club Member');
    await signIn(page, member.email, member.password);
    await page.goto(`/join?code=${code}`);
    await page.getByRole('button', { name: 'Join class' }).click();
    await expect(page.getByRole('heading', { name: `You’ve joined ${className}` })).toBeVisible();
    const memberApi = await Api.signedIn(member.email, member.password);
    expect((await memberApi.get<{ title: string }[]>('/api/v1/courses')).map((c) => c.title)).toContain(title);
    await memberApi.dispose();
  });

  test('instructors see the grading queue and class insights; students cannot open Teach', async ({ page }) => {
    await signIn(page, DEMO_INSTRUCTOR.email, DEMO_INSTRUCTOR.password);
    await page.goto('/teach/grading');
    await settle(page);
    await expect(page.getByRole('heading', { name: /grading|review/i }).first()).toBeVisible();
    await page.goto('/teach/insights');
    await settle(page);
    await expect(page.getByText('Students enrolled')).toBeVisible();
    await signOut(page);

    await signIn(page, DEMO_STUDENT.email, DEMO_STUDENT.password);
    await page.goto('/teach');
    await expect(page).toHaveURL(/\/home$/);
  });
});

test.describe('Roles', () => {
  test('an admin makes a student an instructor, and the new instructor sees Teach after signing in', async ({ page }) => {
    const user = await registerVerifiedStudent('Rahul Nair');
    const admin = adminCredentials();
    await signIn(page, admin.email, admin.password);
    await expect(page.getByRole('link', { name: /Hangfire jobs/ })).toHaveAttribute('target', '_blank');
    await page.goto('/admin/users');
    await settle(page);
    await page.getByLabel('Search by name or email').fill(user.email);
    await page.getByRole('button', { name: `Manage ${user.displayName}` }).click();
    const drawer = page.getByRole('dialog', { name: user.displayName });
    await drawer.getByRole('checkbox', { name: 'Instructor' }).check();
    await drawer.getByRole('button', { name: 'Save roles' }).click();
    await expect(page.getByText(`Roles saved for ${user.displayName}.`)).toBeVisible();
    await page.keyboard.press('Escape');
    await signOut(page);

    await signIn(page, user.email, user.password);
    await expect(page.getByRole('link', { name: 'Teach' }).first()).toBeVisible();
  });

  test('self-registration never grants staff roles, and students cannot reach admin APIs or Hangfire', async ({ page }) => {
    const user = await registerVerifiedStudent('Plain Student');
    const api = await Api.signedIn(user.email, user.password);
    const me = await api.get<{ roles: string[] }>('/api/v1/auth/me');
    expect(me.roles).toEqual(['Student']);
    expect(await api.status('GET', '/api/v1/admin/users')).toBe(403);
    expect(await api.status('GET', '/api/v1/instructor/courses')).toBe(403);
    await api.dispose();

    await signIn(page, user.email, user.password);
    const res = await page.goto('/hangfire');
    expect(res?.status()).not.toBe(200);
  });

  test('the Hangfire dashboard is available to admins with smaller graphs and an auto-refresh toggle', async ({ page }) => {
    const admin = adminCredentials();
    await signIn(page, admin.email, admin.password);
    await page.goto('/hangfire');
    await expect(page).toHaveTitle(/Sathi jobs/);
    await page.goto('/hangfire/jobs/succeeded');
    await expect(page.getByText(/Auto-refresh/)).toBeVisible();
  });
});

test.describe('Under-18 learners (DPDP)', () => {
  test('a minor needs a guardian’s approval before signing in', async ({ page }) => {
    const email = uniqueEmail('tanvi');
    const guardian = uniqueEmail('guardian');
    await page.goto('/auth/register');
    await page.getByLabel('Your name').fill('Tanvi Rao');
    await page.getByLabel('Email').first().fill(email);
    await page.getByLabel('Date of birth').fill('2012-05-01');
    await page.getByLabel('Parent or guardian’s email').fill(guardian);
    await page.getByLabel('Password', { exact: true }).fill(PASSWORD);
    await page.getByRole('button', { name: 'Create account' }).click();
    await expect(page).toHaveURL(/\/auth\/check-email/);

    await page.goto(pathOf(await linkFromEmail(email, /\/auth\/verify-email\?/)));
    await expect(page.getByRole('heading', { name: /verified/i })).toBeVisible();
    await signInExpectingAlert(page, email, PASSWORD, /parent or guardian/i);

    await page.goto(pathOf(await linkFromEmail(guardian, /\/consent\//)));
    await expect(page.getByRole('heading', { name: /Tanvi/ }).first()).toBeVisible();
    await expectAccessible(page, 'guardian consent');
    await page.getByRole('button', { name: 'I approve' }).click();
    await expect(page.getByRole('heading', { name: /can start learning/ })).toBeVisible();

    await signIn(page, email, PASSWORD, /\/onboarding$/);
  });
});

async function signInExpectingAlert(page: import('@playwright/test').Page, email: string, password: string, message: RegExp): Promise<void> {
  await page.goto('/auth/sign-in');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByRole('alert').first()).toContainText(message);
}
