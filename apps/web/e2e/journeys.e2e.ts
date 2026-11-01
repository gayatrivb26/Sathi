import { expect, test } from '@playwright/test';
import { expectAccessible, settle, signIn } from './helpers';

test.describe('J1 · register, verify, onboarding with diagnostic', () => {
  test('a new student registers, verifies email, picks a course and level, and takes the quick check', async ({ page }) => {
    await page.goto('/auth/register');
    await expectAccessible(page, 'register');
    await page.getByLabel('Your name').fill('Meena Joshi');
    await page.getByLabel('Email').fill('meena@example.com');
    await page.getByLabel('Date of birth').fill('1999-04-12');
    const password = page.getByLabel('Password', { exact: true });
    await password.fill('short');
    await expect(page.getByText('At least 10 characters')).toBeVisible();
    await password.fill('learning2026');
    await page.getByRole('button', { name: 'Create account' }).click();

    await expect(page).toHaveURL(/\/auth\/check-email/);
    await expect(page.getByRole('heading', { name: 'Check your email' })).toBeVisible();
    await page.getByRole('link', { name: 'Open the verification link' }).click();
    await expect(page.getByRole('heading', { name: 'You’re verified' })).toBeVisible();
    await page.getByRole('link', { name: 'Sign in' }).click();

    await page.getByLabel('Email').fill('meena@example.com');
    await page.getByLabel('Password', { exact: true }).fill('learning2026');
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    await expect(page).toHaveURL(/\/onboarding$/);

    // Step 1 — course
    await page.getByRole('button', { name: /AI Engineering/ }).click();
    await expect(page.getByRole('button', { name: /AI Engineering/ })).toHaveAttribute('aria-pressed', 'true');
    await expectAccessible(page, 'onboarding course');
    await page.getByRole('button', { name: 'Continue' }).click();

    // Step 2 — level
    await page.getByRole('button', { name: /Beginner/ }).click();
    await page.getByRole('button', { name: 'Continue' }).click();

    // Step 3 — diagnostic: answer one, say "I don't know" to one, skip the rest
    await page.getByRole('button', { name: 'Start the check' }).click();
    await expect(page.getByText('Question 1 of 6')).toBeVisible();
    await page.getByRole('radio').nth(1).check();
    await page.getByRole('button', { name: 'Check answer' }).click();
    await expect(page.getByRole('status').filter({ hasText: /right|Not quite/ })).toBeVisible();
    await page.getByRole('button', { name: /Next question/ }).click();
    await expect(page.getByText('Question 2 of 6')).toBeVisible();
    await page.getByRole('button', { name: 'I don’t know' }).click();
    await expect(page.getByText('Question 3 of 6')).toBeVisible();
    await page.getByRole('button', { name: 'Skip the rest of the check' }).click();

    // Results → home
    await expect(page.getByRole('heading', { name: 'Here’s your starting point' })).toBeVisible();
    await expect(page.getByText('Backpropagation').first()).toBeVisible();
    await page.getByRole('button', { name: 'Go to my home' }).click();
    await expect(page).toHaveURL(/\/home$/);
    await expect(page.getByRole('heading', { name: /Meena/ })).toBeVisible();
  });

  test('wrong password shows a friendly error', async ({ page }) => {
    await page.goto('/auth/sign-in');
    await page.getByLabel('Email').fill('asha@sathi.dev');
    await page.getByLabel('Password', { exact: true }).fill('wrong');
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    await expect(page.getByRole('alert')).toContainText('That email and password don’t match');
  });

  test('protected pages redirect to sign-in with a return URL', async ({ page }) => {
    await page.goto('/progress');
    await expect(page).toHaveURL(/\/auth\/sign-in\?returnUrl=%2Fprogress/);
    await page.getByLabel('Email').fill('asha@sathi.dev');
    await page.getByLabel('Password', { exact: true }).fill('demo-password-1');
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    await expect(page).toHaveURL(/\/progress$/);
  });
});

test.describe('J2 · home', () => {
  test('shows continue-lesson, revision, mastery with text labels and study-next', async ({ page }) => {
    await signIn(page);
    await expect(page.getByRole('heading', { name: /Good (morning|afternoon|evening)|Up late/ })).toContainText('Asha');
    await expect(page.getByRole('heading', { name: 'Attention mechanisms' })).toBeVisible();
    await expect(page.getByText('Lesson 4 of 7.')).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Revision due today' })).toBeVisible();
    await expect(page.getByText('42% · needs work')).toBeVisible();
    await expect(page.getByText('4-day')).toBeVisible();
    await expectAccessible(page, 'home');

    await page.getByRole('link', { name: 'Continue lesson' }).click();
    await expect(page).toHaveURL(/\/lessons\/les-attention$/);
    await expect(page.locator('.katex').first()).toBeVisible();
    await expectAccessible(page, 'lesson');
  });

  test('works on a phone with bottom navigation', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await signIn(page);
    const nav = page.getByRole('navigation', { name: 'Main' }).last();
    await expect(nav.getByRole('link', { name: 'Tutor' })).toBeVisible();
    await nav.getByRole('button', { name: 'More pages' }).click();
    await page.getByRole('menuitem', { name: 'Progress' }).click();
    await expect(page).toHaveURL(/\/progress$/);
  });
});

test.describe('J3 · tutor', () => {
  test('streams an answer with citations, web sources and feedback', async ({ page }) => {
    await signIn(page);
    await page.goto('/tutor?lessonId=les-attention');
    await expect(page.getByRole('heading', { name: 'Attention mechanisms' })).toBeVisible();
    const web = page.getByRole('switch', { name: /Search the web/ });
    await expect(web).toHaveAttribute('aria-checked', 'false'); // off by default
    await web.click();
    await expect(web).toHaveAttribute('aria-checked', 'true');

    await page.getByRole('button', { name: 'Advanced' }).click();
    await page.getByLabel('Ask the tutor').fill('Why do we divide by the square root of d in attention?');
    await page.keyboard.press('Enter');

    // Status line before the first token, then streaming with a Stop button
    await expect(page.getByText('Searching the web…')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Stop' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Simpler' })).toBeVisible({ timeout: 30_000 });

    // Numbered citation chips and a Sources panel with type labels
    const chips = page.locator('.answer .cite-chip');
    await expect(chips).toHaveCount(3);
    await expect(chips.nth(2)).toHaveAttribute('data-type', 'web');
    const sources = page.getByRole('complementary', { name: 'Sources used' });
    await expect(sources.locator('#side-src-1')).toContainText('Your notes');
    await expect(sources.locator('#side-src-1')).toContainText('Page 12');
    await expect(sources.locator('#side-src-2')).toContainText('Course');
    await expect(sources.locator('#side-src-3')).toContainText('Web');
    await expect(sources.locator('#side-src-3')).toContainText('arxiv.org');
    await expect(sources.getByText(/Answered from: your notes, your course and the web/)).toBeVisible();
    await chips.nth(2).click();
    await expect(page.locator('#side-src-3')).toBeFocused();

    // Feedback + re-explain
    await page.getByRole('button', { name: 'Helpful', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Helpful', exact: true })).toHaveAttribute('aria-pressed', 'true');
    await page.getByRole('button', { name: 'Simpler' }).click();
    await expect(page.getByText('Explain that more simply')).toBeVisible();
    await expect(page.locator('.msg.assistant')).toHaveCount(2);
    await expect(page.getByRole('button', { name: 'Simpler' }).nth(1)).toBeVisible({ timeout: 30_000 });
    await expectAccessible(page, 'tutor');

    // History drawer lists the conversation
    await page.getByRole('button', { name: /History/ }).click();
    await expect(page.getByRole('dialog', { name: 'Your conversations' })).toBeVisible();
    await expect(page.getByRole('dialog').getByText('Why do we divide by the square root')).toBeVisible();
    await page.keyboard.press('Escape');
  });

  test('shows a reference ID when the tutor fails, and Retry recovers', async ({ page }) => {
    await signIn(page);
    await page.goto('/tutor');
    await page.getByLabel('Ask the tutor').fill('Trigger an error please');
    await page.getByRole('button', { name: 'Send' }).click();
    const alert = page.locator('.inline-error');
    await expect(alert).toContainText('The tutor is unavailable right now', { timeout: 20_000 });
    await expect(alert).toContainText(/Reference [0-9A-F]{4}-[0-9A-F]{4}/);
    await alert.getByRole('button', { name: 'Retry' }).click();
    await expect(page.getByRole('button', { name: 'Simpler' })).toBeVisible({ timeout: 30_000 });
    await expect(page.locator('.inline-error')).toHaveCount(0);
  });

  test('can stop a slow answer', async ({ page }) => {
    await signIn(page);
    await page.goto('/tutor');
    await page.getByLabel('Ask the tutor').fill('This will be slow');
    await page.keyboard.press('Enter');
    await expect(page.getByText('Still working on it…')).toBeVisible({ timeout: 15_000 });
    await page.getByRole('button', { name: 'Stop' }).click();
    await expect(page.getByRole('button', { name: 'Send' })).toBeVisible();
  });
});

test.describe('J4 · notes', () => {
  test('uploads a file, watches processing, rejects bad files, and retries a failed one', async ({ page }) => {
    await signIn(page);
    await page.goto('/notes');
    await settle(page);
    await expectAccessible(page, 'notes');

    // Seeded failed file shows its reference ID and can be retried
    const failed = page.locator('li.file', { hasText: 'Scanned handout.pdf' });
    await expect(failed).toContainText('Could not read text');
    await expect(failed).toContainText('Reference 7F3A-91C2');
    await failed.getByRole('button', { name: 'Retry' }).click();
    await expect(failed).toContainText(/Queued|Reading your file|Creating search index|Ready/);
    await expect(failed).toContainText(/Ready · \d+ passages/, { timeout: 30_000 });

    // Client-side validation
    await page.setInputFiles('#file-input', { name: 'slides.pptx', mimeType: 'application/vnd.ms-powerpoint', buffer: Buffer.from('x') });
    await expect(page.getByRole('alert')).toContainText('slides.pptx');

    // A good upload goes through Uploading → Reading → Creating search index → Ready
    await page.setInputFiles('#file-input', { name: 'Week 5 notes.md', mimeType: 'text/markdown', buffer: Buffer.from('# Attention\n\nNotes about softmax.') });
    const row = page.locator('li.file', { hasText: 'Week 5 notes.md' });
    await expect(row).toBeVisible();
    await expect(row).toContainText(/Ready · \d+ passages/, { timeout: 30_000 });

    // A scanned PDF fails with a reference ID, then Retry succeeds
    await page.setInputFiles('#file-input', { name: 'scan-of-handout.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4 fake') });
    const scan = page.locator('li.file', { hasText: 'scan-of-handout.pdf' });
    await expect(scan).toContainText('Could not read text', { timeout: 30_000 });
    await expect(scan).toContainText(/Reference [0-9A-F]{4}-[0-9A-F]{4}/);
    await scan.getByRole('button', { name: 'Retry' }).click();
    await expect(scan).toContainText(/Ready · \d+ passages/, { timeout: 30_000 });

    // Delete with confirmation
    await row.getByRole('button', { name: 'Delete Week 5 notes.md' }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Delete file' }).click();
    await expect(row).toHaveCount(0);
  });
});

test.describe('J5 · practice', () => {
  test('answers a question, sees why, mastery change, and the summary', async ({ page }) => {
    await signIn(page);
    await page.goto('/practice');
    await page.getByRole('button', { name: 'Practise Backpropagation' }).click();
    await expect(page.getByText('Question 1 of 5')).toBeVisible();
    await expectAccessible(page, 'practice question');

    await page.getByRole('radio', { name: /Weights are updated before gradients exist/ }).check();
    await page.getByRole('button', { name: 'Check answer' }).click();
    await expect(page.locator('label.opt.correct')).toContainText('Correct answer');
    await expect(page.locator('label.opt.wrong')).toContainText('Your answer');
    await expect(page.getByRole('heading', { name: 'Why B' })).toBeVisible();
    await expect(page.getByText(/Backpropagation mastery/)).toBeVisible();
    await expect(page.getByText(/42% to \d+%/)).toBeVisible();
    await expectAccessible(page, 'practice feedback');

    // Next questions (MCQ) …
    for (let i = 2; i <= 4; i++) {
      await page.getByRole('button', { name: 'Next question' }).click();
      await expect(page.getByText(`Question ${i} of 5`)).toBeVisible();
      await page.getByRole('radio').first().check();
      await page.getByRole('button', { name: 'Check answer' }).click();
      await expect(page.getByRole('button', { name: /Next question/ })).toBeVisible();
    }
    // … and a short answer that goes through "Grading…"
    await page.getByRole('button', { name: 'Next question' }).click();
    await expect(page.getByText('Question 5 of 5')).toBeVisible();
    await page.getByRole('textbox').fill('Because the loss is computed at the output, and by the chain rule each layer needs the gradient from the layer above it, so we go backwards and reuse it.');
    await page.getByRole('button', { name: 'Check answer' }).click();
    await expect(page.getByRole('heading', { name: 'Grading…' })).toBeVisible();
    await expect(page.getByRole('heading', { name: /Score \d+ \/ \d+/ })).toBeVisible({ timeout: 20_000 });
    await page.getByRole('button', { name: 'See summary' }).click();

    await expect(page).toHaveURL(/\/summary$/);
    await expect(page.getByRole('heading', { name: 'Mastery changes' })).toBeVisible();
    await expect(page.getByText(/of 5 correct/)).toBeVisible();
  });
});

test.describe('J6 · revision', () => {
  test('reviews a due card and self-rates it', async ({ page }) => {
    await signIn(page);
    await page.goto('/revision');
    await expect(page.getByRole('heading', { name: '5 cards due today' })).toBeVisible();
    await page.getByRole('button', { name: 'Start revision' }).click();
    await page.getByRole('radio').nth(1).check();
    await page.getByRole('button', { name: /Good/ }).click();
    await expect(page.getByText(/Next review in \d+ day/)).toBeVisible();
    await expectAccessible(page, 'revision');
  });
});

test.describe('J7 · instructor', () => {
  test('reviews an uncertain AI grade and sees class insights', async ({ page }) => {
    await signIn(page, 'instructor@sathi.dev');
    await expect(page.getByRole('link', { name: 'Teach' }).first()).toBeVisible();
    await page.goto('/teach/grading');
    const first = page.locator('li.item').first();
    await expect(first).toContainText('Asha Verma');
    await expect(first).toContainText('AI score');
    await expect(first).toContainText(/confidence/);
    await expectAccessible(page, 'grading queue');

    await first.getByRole('button', { name: 'Override' }).click();
    await first.getByLabel(/Final score/).fill('3');
    await first.getByLabel('Feedback to the student').fill('Good use of the chain rule. Mention reuse of gradients next time.');
    await first.getByRole('button', { name: 'Save review' }).click();
    await expect(page.getByText('Review saved for Asha Verma.')).toBeVisible();
    await expect(page.locator('li.item', { hasText: 'Asha Verma' })).toHaveCount(0);

    await page.getByRole('link', { name: /Class insights/ }).click();
    await expect(page.getByText('Students enrolled')).toBeVisible();
    await expect(page.getByText(/students below 50%/).first()).toBeVisible();
  });

  test('edits a lesson with live preview and generates AI drafts', async ({ page }) => {
    await signIn(page, 'instructor@sathi.dev');
    await page.goto('/teach/content');
    await page.getByRole('button', { name: 'Attention mechanisms' }).click();
    await expect(page.getByRole('heading', { name: 'Edit lesson' })).toBeVisible();
    await page.getByLabel('Summary').fill('Scaled dot-product attention, step by step.');
    await expect(page.getByText('Unsaved changes')).toBeVisible();
    await page.getByRole('button', { name: 'Save lesson' }).click();
    await expect(page.getByText('All changes saved')).toBeVisible();

    await page.getByRole('link', { name: /Question bank/ }).click();
    await page.getByRole('button', { name: 'Generate questions with AI' }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Generate drafts' }).click();
    await expect(page.getByText('Drafts generated.')).toBeVisible();
    await expect(page.getByText(/\[Draft 1\]/)).toBeVisible({ timeout: 10_000 });
  });

  test('students cannot open the Teach area', async ({ page }) => {
    await signIn(page);
    await page.goto('/teach');
    await expect(page).toHaveURL(/\/home$/);
  });
});

test.describe('J8 · admin', () => {
  test('looks up a failed run by reference ID', async ({ page }) => {
    await signIn(page, 'admin@sathi.dev');
    await page.goto('/admin');
    await page.getByLabel('Reference, trace or run ID').fill('7f3a91c2');
    await page.getByRole('button', { name: 'Look up' }).click();
    await expect(page).toHaveURL(/\/admin\/lookup\/7F3A-91C2$/);
    await expect(page.getByRole('heading', { name: /Reference 7F3A-91C2/ })).toBeVisible();
    await expect(page.getByText('INGEST_NO_TEXT').first()).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Steps' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Logs in Grafana' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Hangfire job', exact: true })).toBeVisible();
    await expectAccessible(page, 'admin run detail');

    await page.getByLabel('Reference, trace or run ID').fill('0000-0000');
    await page.getByRole('button', { name: 'Look up' }).click();
    await expect(page.getByRole('heading', { name: 'No run found for that ID' })).toBeVisible();

    await page.getByRole('link', { name: /Recent runs/ }).click();
    await expect(page.getByRole('cell', { name: 'LLM_TIMEOUT' }).first()).toBeVisible();
  });
});

test.describe('errors and states', () => {
  test('a failing endpoint shows an error state with reference ID and retry', async ({ page }) => {
    await signIn(page);
    await page.evaluate(() => sessionStorage.setItem('sathi.mock.fail', '/api/v1/progress'));
    await page.goto('/progress');
    await expect(page.getByRole('heading', { name: 'We couldn’t load your progress' })).toBeVisible();
    await expect(page.getByText(/Reference [0-9A-F]{4}-[0-9A-F]{4}/)).toBeVisible();
    await page.evaluate(() => sessionStorage.removeItem('sathi.mock.fail'));
    await page.getByRole('button', { name: 'Try again' }).click();
    await expect(page.getByRole('heading', { name: 'Mastery by topic' })).toBeVisible();
  });

  test('offline banner appears and disappears', async ({ page, context }) => {
    await signIn(page);
    await context.setOffline(true);
    await expect(page.getByText('You’re offline.')).toBeVisible();
    await context.setOffline(false);
    await expect(page.getByText('You’re offline.')).toHaveCount(0);
  });

  test('unknown pages show a friendly 404', async ({ page }) => {
    await page.goto('/this/does/not/exist');
    await expect(page.getByRole('heading', { name: 'We couldn’t find that page' })).toBeVisible();
  });
});
