import { expect, Page, test } from '@playwright/test';
import { expectAccessible, settle, signIn } from './helpers';

async function signOut(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Sign out' }).first().click();
  await expect(page).toHaveURL(/\/auth\/sign-in/);
}

test.describe('R2 · courses and classes', () => {
  test('an instructor creates a course and a class, copies the code, and a student joins with it', async ({ page, context }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await signIn(page, 'instructor@sathi.dev');
    await page.goto('/teach/content');
    await settle(page);

    // New course: the slug follows the title until edited; private + published.
    await page.getByRole('button', { name: 'New course' }).first().click();
    const dialog = page.getByRole('dialog', { name: 'New course' });
    await dialog.getByLabel('Title').fill('Robotics Club');
    await expect(dialog.getByLabel('URL slug')).toHaveValue('robotics-club');
    await dialog.getByRole('radio', { name: /Private/ }).check();
    await dialog.getByRole('switch', { name: 'Draft' }).click();
    await expectAccessible(page, 'new course dialog');
    await dialog.getByRole('button', { name: 'Create course' }).click();
    await expect(page.getByText('“Robotics Club” created.')).toBeVisible();
    await expect(page.getByText('Private — class members only')).toBeVisible();

    // Classes tab: create a class and copy its join code.
    await page.getByRole('link', { name: /Classes/ }).click();
    await page.getByRole('button', { name: 'New class' }).click();
    await page.getByLabel('Class name').fill('Saturday group');
    await page.getByRole('button', { name: 'Create class' }).click();
    const code = (await page.locator('.join-code.big').innerText()).trim();
    expect(code).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
    await page.getByRole('button', { name: 'Copy code' }).click();
    await expect(page.getByText('Code copied.')).toBeVisible();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(code);
    await expect(page.getByText(`/join?code=${code}`)).toBeVisible();
    await expectAccessible(page, 'teach classes');

    // The student joins with the code (same tab: the mock database lives in this tab).
    await signOut(page);
    await signIn(page, 'asha@sathi.dev');
    await page.goto(`/join?code=${code.toLowerCase().replace('-', '')}`);
    await expect(page.getByLabel('Class code')).toHaveValue(code);
    await expectAccessible(page, 'join a class');
    await page.getByRole('button', { name: 'Join class' }).click();
    await expect(page.getByRole('heading', { name: 'You’ve joined Saturday group' })).toBeVisible();
    await expect(page.getByText('Robotics Club')).toBeVisible();

    await page.goto('/settings');
    await expect(page.getByRole('region', { name: 'My classes' }).getByText('Saturday group')).toBeVisible();
  });

  test('a wrong or disabled code explains what to do', async ({ page }) => {
    await signIn(page);
    await page.goto('/join');
    await page.getByLabel('Class code').fill('abcd-ef1');
    await page.getByRole('button', { name: 'Join class' }).click();
    await expect(page.getByText(/no 0, 1, I or O/)).toBeVisible();
    await page.getByLabel('Class code').fill('ZZZZ-ZZZZ');
    await page.getByRole('button', { name: 'Join class' }).click();
    await expect(page.getByRole('alert').filter({ hasText: 'We couldn’t find a class with that code' })).toBeVisible();
    await page.getByLabel('Class code').fill('WKND-B4TC');
    await page.getByRole('button', { name: 'Join class' }).click();
    await expect(page.getByRole('alert').filter({ hasText: 'isn’t accepting new students' })).toBeVisible();
  });

  test('an email invite can be opened signed out and accepted after signing in', async ({ page }) => {
    await page.goto('/join/demo-class-invite');
    await expect(page.getByRole('heading', { name: 'Join Monday cohort' })).toBeVisible();
    await expectAccessible(page, 'class invite');
    await page.getByRole('link', { name: 'Sign in to accept' }).click();
    await page.getByLabel('Email').fill('new@sathi.dev');
    await page.getByLabel('Password', { exact: true }).fill('demo-password-1');
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    await expect(page).toHaveURL(/\/join\/demo-class-invite$/);
    await page.getByRole('button', { name: 'Accept and join' }).click();
    await expect(page.getByRole('heading', { name: 'You’ve joined Monday cohort' })).toBeVisible();
    await page.getByRole('button', { name: /Set up and start learning/ }).click();
    await expect(page).toHaveURL(/\/onboarding$/);
  });
});

test.describe('R2 · roles', () => {
  test('an admin grants the Instructor role and cannot remove their own Admin role', async ({ page }) => {
    await signIn(page, 'admin@sathi.dev');
    await expect(page.getByRole('link', { name: /Hangfire jobs/ })).toHaveAttribute('target', '_blank');
    await page.goto('/admin/users');
    await expect(page.getByRole('heading', { name: 'How roles work' })).toBeVisible();
    await settle(page);
    await expectAccessible(page, 'admin users');

    await page.getByLabel('Search by name or email').fill('rahul');
    const row = page.getByRole('listitem').filter({ hasText: 'rahul@example.in' });
    await expect(row).toBeVisible();
    await row.getByRole('button', { name: 'Manage Rahul Nair' }).click();
    const drawer = page.getByRole('dialog', { name: 'Rahul Nair' });
    await drawer.getByRole('checkbox', { name: 'Instructor' }).check();
    await drawer.getByRole('button', { name: 'Save roles' }).click();
    await expect(page.getByText('Roles saved for Rahul Nair.')).toBeVisible();
    await expect(row.getByText('Instructor')).toBeVisible();
    await expectAccessible(page, 'admin user drawer');
    await page.keyboard.press('Escape');

    await page.getByLabel('Search by name or email').fill('kabir');
    await page.getByRole('button', { name: 'Manage Kabir Rao' }).click();
    const self = page.getByRole('dialog', { name: 'Kabir Rao' });
    await expect(self.getByRole('checkbox', { name: 'Admin' })).toBeDisabled();
    await expect(self.getByText('You can’t remove your own Admin role.')).toBeVisible();
  });

  test('an admin sends a staff invite, and the invitee registers with it', async ({ page }) => {
    await signIn(page, 'admin@sathi.dev');
    await page.goto('/admin/staff-invites');
    await page.getByLabel('Email').fill('lecturer@college.in');
    await page.getByRole('button', { name: 'Send invite' }).click();
    await expect(page.getByText('Invite sent to lecturer@college.in')).toBeVisible();
    await expectAccessible(page, 'staff invites');
    const link = await page.getByRole('link', { name: 'open the invite link' }).getAttribute('href');
    await signOut(page);
    await page.goto(link!);
    await expect(page.getByText('You’re invited to teach on Sathi')).toBeVisible();
    await expect(page.getByText(/l•+@college\.in/).first()).toBeVisible();
  });
});

test.describe('R2 · under-18 learners', () => {
  test('a minor registers with a guardian email, and the guardian approves on the consent page', async ({ page }) => {
    await page.goto('/auth/register');
    await page.getByLabel('Your name').fill('Tanvi Rao');
    await page.getByLabel('Email').first().fill('tanvi@example.in');
    await page.getByLabel('Date of birth').fill('2012-05-01');
    await expect(page.getByText('A parent or guardian needs to approve')).toBeVisible();
    await page.getByLabel('Parent or guardian’s email').fill('tanvi@example.in');
    await page.getByLabel('Password', { exact: true }).fill('learning2026');
    await page.getByRole('button', { name: 'Create account' }).click();
    await expect(page.getByText('Use their own email address, not yours.')).toBeVisible();
    await page.getByLabel('Parent or guardian’s email').fill('mum.rao@example.in');
    await expectAccessible(page, 'register minor');
    await page.getByRole('button', { name: 'Create account' }).click();

    await expect(page).toHaveURL(/\/auth\/check-email\?.*guardian=1/);
    await expect(page.getByRole('heading', { name: /ask your parent or guardian/ })).toBeVisible();
    await page.getByRole('link', { name: 'Open the guardian’s link' }).click();

    await expect(page.getByRole('heading', { name: 'Tanvi would like to learn with Sathi' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'What we never do' })).toBeVisible();
    await expectAccessible(page, 'guardian consent');
    await page.getByRole('button', { name: 'I approve' }).click();
    await expect(page.getByRole('heading', { name: 'Thank you — Tanvi can start learning' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Withdraw consent' })).toBeVisible();
  });

  test('under 8 is refused, and a pending learner sees a friendly sign-in message', async ({ page }) => {
    await page.goto('/auth/register');
    await page.getByLabel('Date of birth').fill('2021-01-01');
    await page.getByLabel('Date of birth').blur();
    await expect(page.getByText('Sathi is for learners aged 8 and over.')).toBeVisible();

    await page.goto('/auth/sign-in');
    await page.getByLabel('Email').fill('tara@sathi.dev');
    await page.getByLabel('Password', { exact: true }).fill('demo-password-1');
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    await expect(page.getByRole('alert')).toContainText('parent or guardian still needs to approve');
    await page.getByRole('button', { name: 'Send the email to my parent or guardian again' }).click();
    await expect(page.getByText('We sent the approval email to your parent or guardian again.')).toBeVisible();
  });
});

test.describe('R2 · tutor and practice fixes', () => {
  test('Stop ends the answer at once, is saved as stopped, and history pages and interruptions work', async ({ page }) => {
    await signIn(page);
    await page.goto('/tutor');
    await expect(page.getByRole('button', { name: 'New conversation' })).toBeDisabled();
    const box = page.getByLabel('Ask the tutor');
    const h0 = (await box.boundingBox())!.height;
    expect(h0).toBeGreaterThanOrEqual(70); // ~3 lines
    await box.fill('line\n'.repeat(20));
    await expect.poll(async () => (await box.boundingBox())!.height).toBeLessThanOrEqual(222);
    expect((await box.boundingBox())!.height).toBeGreaterThan(h0);

    await box.fill('This will be slow');
    await page.keyboard.press('Enter');
    // Wait until the server has started the answer, so the stop is recorded server-side too.
    await expect(page.getByText('Writing your answer…')).toBeVisible();
    await page.getByRole('button', { name: 'Stop' }).click();
    await expect(page.getByText('You stopped this answer.')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Send' })).toBeVisible();
    await expect(box).toBeEnabled();

    // Reloading the conversation shows the server kept it as cancelled.
    await page.waitForTimeout(1200);
    await page.reload();
    await expect(page.getByText('You stopped this answer.')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Ask again' })).toBeVisible();

    // New conversation from the header.
    await page.getByRole('button', { name: 'New conversation' }).click();
    await expect(page.getByRole('heading', { name: 'What would you like to understand?' })).toBeVisible();

    // History: more than 20 conversations load on demand; an interrupted answer is explained.
    await page.getByRole('button', { name: /History/ }).click();
    const drawer = page.getByRole('dialog', { name: 'Your conversations' });
    await drawer.getByRole('button', { name: 'Load older conversations' }).click();
    await expect(drawer.getByText('KV cache', { exact: true })).toBeVisible();
    await drawer.getByRole('button', { name: /^What is a mixture of experts/ }).click();
    await expect(page.getByText('This answer was interrupted. Try again.')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Send' })).toBeVisible();
    await expectAccessible(page, 'tutor interrupted');
  });

  test('practice shows unpractised topics as "Not practised yet", not 30 %', async ({ page }) => {
    await signIn(page);
    await page.goto('/practice');
    await settle(page);
    await expect(page.getByRole('heading', { name: 'Mixed practice · weakest topics first' })).toBeVisible();
    await expect(page.getByText('Not practised yet').first()).toBeVisible();
    await expect(page.getByText('30%')).toHaveCount(0);

    await signOut(page);
    await signIn(page, 'instructor@sathi.dev');
    await page.goto('/practice');
    await settle(page);
    await expect(page.getByRole('heading', { name: 'Mixed practice · topics you haven’t tried yet' })).toBeVisible();
  });
});
