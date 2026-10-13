// ADR-111 C-01, C-02, C-04 / ADR-112 C-02 / DESIGN-055 D-10, D-11, D-12 (PLAN-077 P3) end to end, against the stub
// Seerr issues (stub-arr's `GET /issue`, seerrIssueFixture):
//   • AC-43 (read half): one `seerr-issues` sync run mirrors the reports; a reporter with no session follows
//     `/r/seerr/<id>`, sees the onboarding card, signs in with Plex (the stub), comes back through the link and lands on
//     the title page with the guide the report points at open (Force Search on the missing episode) and the
//     "You reported this in Seerr" note; the report shows on the title page; an Audio report opens Fix with Wrong
//     language preselected. Phone and desktop widths are captured.
//   • AC-44: the admin Seerr issues view lists each report with its title and episode, its linked repairs (the Force
//     Search made above, from the app's own records) and the fixed-by-hand mark with its note, which can be cleared.
//   • The cards for a report with no title in the Library and an unknown report; an issue webhook mirrors a new report
//     with no sync run.
// Read-only toward Seerr throughout (the stub records no Seerr write). afterAll empties the stub's issues and syncs
// again, so every report is marked removed and no later spec sees a banner.
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { test, expect, type Page, type TestInfo } from '@playwright/test';
import { armAndConfirm, selectStubUser, signIn } from './support/helpers';
import { readRuntimeEnv } from './support/env';
import {
  SEERR_ISSUE_AUDIO_MOVIE,
  SEERR_ISSUE_MISSING_EPISODE,
  SEERR_ISSUE_NOT_IN_LIBRARY,
  SEERR_ISSUE_RESOLVED,
  seerrIssueFixture,
  type RecordedArrWrite,
} from './support/stub-arr';

const env = () => readRuntimeEnv();

async function stubArr(path: string, body?: unknown): Promise<void> {
  const res = await fetch(`${env().STUB_ARR_URL}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`stub-arr ${path} failed: ${res.status}`);
}

async function arrCalls(): Promise<RecordedArrWrite[]> {
  const res = await fetch(`${env().STUB_ARR_URL}/_stub/calls`);
  return ((await res.json()) as { calls: RecordedArrWrite[] }).calls;
}

/** One run of the real `seerr-issues` sync mode against the stubs. */
function syncSeerrIssues(): void {
  const res = spawnSync(
    join(process.cwd(), 'node_modules', '.bin', 'tsx'),
    [join(process.cwd(), '..', '..', 'packages', 'sync', 'src', 'scripts', 'sync.ts'), '--mode=seerr-issues'],
    { env: { ...process.env, ...env() }, encoding: 'utf8' },
  );
  if (res.status !== 0) throw new Error(`seerr-issues sync failed:\n${res.stdout}\n${res.stderr}`);
}

/** Phone and desktop: no sideways page scroll; captured for review. */
async function checkWidths(page: Page, testInfo: TestInfo, name: string): Promise<void> {
  for (const [label, w, h] of [
    ['desktop', 1280, 900],
    ['390', 390, 844],
  ] as const) {
    await page.setViewportSize({ width: w, height: h });
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow, `${name} ${label}`).toBeLessThanOrEqual(0);
    const path = testInfo.outputPath(`${name}-${label}.png`);
    await page.screenshot({ path, fullPage: true });
    await testInfo.attach(`${name}-${label}`, { path, contentType: 'image/png' });
  }
  await page.setViewportSize({ width: 1280, height: 900 });
}

test.describe.configure({ mode: 'serial' });

test.describe('Seerr issues (ADR-111 / DESIGN-055 D-10..D-12, PLAN-077 P3)', () => {
  test.beforeAll(async () => {
    await stubArr('/_stub/seerr-issues', {});
    syncSeerrIssues();
  });

  test.afterAll(async () => {
    // Every report goes away (marked removed), so no later spec sees a banner or a link card.
    await stubArr('/_stub/seerr-issues', { issues: [] });
    syncSeerrIssues();
    await stubArr('/_stub/reset');
  });

  test('a reporter follows the link signed out, signs in, and lands on the guide the report points at (AC-43)', async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto(`/r/seerr/${SEERR_ISSUE_MISSING_EPISODE}`);
    const card = page.getByTestId('seerr-link-sign-in');
    await expect(card.getByRole('heading', { name: 'Thanks for reporting this' })).toBeVisible();
    // Nothing about the report is shown before sign-in.
    await expect(card).not.toContainText('Breaking Prod');
    await expect(card).not.toContainText('Missing episode 10');
    await expect(card.getByRole('link', { name: 'Seerr' })).toHaveAttribute('href', 'https://overseerr.haynesnetwork.com');
    await checkWidths(page, testInfo, 'seerr-link-sign-in');

    // Sign in with Plex (the stub OIDC) and come back through the same link. A click before hydration is dropped,
    // so retry until the round trip leaves the card (as helpers.signIn does for /login).
    await selectStubUser('fresh-member');
    await expect(async () => {
      if (new URL(page.url()).pathname.startsWith('/r/seerr/')) {
        await page.getByRole('button', { name: 'Sign in with Plex' }).click({ timeout: 2_000 });
      }
      await page.waitForURL(/\/library\/[0-9a-f-]{36}/, { timeout: 5_000 });
    }).toPass({ timeout: 30_000, intervals: [250, 500, 1_000] });

    // The guide opened on Force Search for the missing episode, with the first-visit note.
    const dialog = page.getByRole('dialog', { name: 'Force search Breaking Prod' });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByTestId('seerr-guide-intro')).toHaveText(
      "You reported this in Seerr. Here's what you can try first.",
    );
    await expect(dialog).toContainText('S01E10');
    // The `?seerr=` param is dropped once the guide opened, so a reload does not open it again.
    await expect(page).toHaveURL(/\/library\/[0-9a-f-]{36}$/);
    await checkWidths(page, testInfo, 'seerr-guide-arrived');

    // Press it: one EpisodeSearch on the missing episode (the linked repair the admin view reads below).
    await dialog.getByRole('button', { name: 'Force search' }).click();
    await expect(dialog).toContainText('A fresh search is running');
    await dialog.getByRole('button', { name: 'Close' }).click();

    const banner = page.getByTestId('seerr-report').first();
    await expect(banner).toContainText('You reported this in Seerr');
    await expect(banner).toContainText('Video · S01E10');
    await expect(banner).toContainText('Missing episode 10');
    // Only admins see who reported it.
    await expect(banner).not.toContainText('stubfresh');
    await expect(banner.getByRole('link', { name: 'See the report in Seerr' })).toHaveAttribute(
      'href',
      `https://overseerr.haynesnetwork.com/issues/${SEERR_ISSUE_MISSING_EPISODE}`,
    );
    await expect(banner.getByTestId('seerr-report-action')).toBeVisible();
    await checkWidths(page, testInfo, 'seerr-report-banner');
    const searches = (await arrCalls()).filter(
      (c) => c.path === '/command' && (c.body as { name?: string }).name === 'EpisodeSearch',
    );
    expect(searches.length).toBeGreaterThanOrEqual(1);
  });

  test('an Audio report opens Fix with Wrong language preselected; the banner names it for anyone who can see the title', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await signIn(page, 'member');
    await page.goto(`/r/seerr/${SEERR_ISSUE_AUDIO_MOVIE}`);
    await page.waitForURL(/\/library\/[0-9a-f-]{36}/);
    const dialog = page.getByRole('dialog', { name: 'Fix The Fixture' });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByTestId('seerr-guide-intro')).toHaveText(
      "You reported this in Seerr. Here's what you can try first.",
    );
    await expect(dialog.getByRole('radio', { name: 'Wrong language' })).toBeChecked();
    await dialog.getByRole('button', { name: 'Close' }).click();
    await expect(page.getByTestId('seerr-report')).toContainText('Audio');
    await expect(page.getByTestId('seerr-report').getByTestId('seerr-report-action')).toHaveText('Fix');
  });

  test('the link explains a report with no title in the Library, and an unknown report', async ({ page }) => {
    await signIn(page, 'member');
    await page.goto(`/r/seerr/${SEERR_ISSUE_NOT_IN_LIBRARY}`);
    await expect(page.getByTestId('seerr-link-no-title')).toContainText("This title isn't in the Library yet");
    await expect(page.getByRole('link', { name: 'Go to the Library' })).toHaveAttribute('href', '/library');
    await page.goto('/r/seerr/99999');
    await expect(page.getByTestId('seerr-link-not-found')).toContainText("We couldn't find that report");
  });

  test('admins see every report with its linked repairs and mark one fixed by hand (AC-44)', async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await signIn(page, 'admin');
    await page.goto('/admin/seerr');
    await expect(page.getByRole('heading', { name: 'Seerr issues' })).toBeVisible();
    const issue = (id: number) => page.locator(`[data-testid="seerr-admin-issue"][data-issue="${id}"]`);

    // Open reports only by default; the resolved one under All.
    await expect(issue(SEERR_ISSUE_MISSING_EPISODE)).toBeVisible();
    await expect(issue(SEERR_ISSUE_RESOLVED)).toHaveCount(0);
    const episode = issue(SEERR_ISSUE_MISSING_EPISODE);
    await expect(episode).toContainText('Breaking Prod');
    await expect(episode).toContainText('Video · S01E10');
    await expect(episode).toContainText('Reported by stubfresh');
    // The linked repair is the app's own record: the Force Search made in the first test.
    await expect(episode).toContainText('Force Search');
    await expect(episode.locator('.seerr-admin__url')).toHaveText(new RegExp(`/r/seerr/${SEERR_ISSUE_MISSING_EPISODE}$`));
    await expect(issue(SEERR_ISSUE_NOT_IN_LIBRARY)).toContainText('Not in the Library');

    await page.getByRole('group', { name: 'Which reports' }).getByRole('button', { name: 'All' }).click();
    const resolved = issue(SEERR_ISSUE_RESOLVED);
    await expect(resolved).toContainText('Resolved');
    await resolved.getByRole('button', { name: 'Mark fixed by hand' }).click();
    const dialog = page.getByRole('dialog', { name: 'Mark fixed by hand' });
    const save = dialog.getByRole('button', { name: 'Mark fixed by hand' });
    await expect(save).toBeDisabled();
    await dialog.getByRole('textbox').fill('Replaced the poster by hand. Missing: a poster fix for members.');
    await save.click();
    await expect(dialog).toHaveCount(0);
    await expect(resolved).toContainText('Fixed by hand');
    await expect(resolved).toContainText('Replaced the poster by hand. Missing: a poster fix for members.');
    await checkWidths(page, testInfo, 'seerr-admin');

    await armAndConfirm(resolved.getByTestId('seerr-admin-clear'));
    await expect(resolved).not.toContainText('Fixed by hand');
    await expect(resolved).toContainText('Staff note');
  });

  test('an issue webhook mirrors a new report with no sync run, and is not a Feed notification', async ({ page }) => {
    const fresh = {
      ...seerrIssueFixture()[2]!,
      id: 905,
      comments: [{ id: 9905, message: 'Webhook report', createdAt: '2026-10-12T13:00:00.000Z', updatedAt: '2026-10-12T13:00:00.000Z' }],
    };
    await stubArr('/_stub/seerr-issues', { issues: [...seerrIssueFixture(), fresh] });
    const res = await page.request.post('/api/webhooks/seerr', {
      headers: { 'content-type': 'application/json', authorization: env().SEERR_WEBHOOK_SECRET },
      data: JSON.stringify({ notification_type: 'ISSUE_CREATED', subject: 'The Fixture', issue: { issue_id: '905' } }),
    });
    expect(res.status()).toBe(202);
    expect(await res.json()).toMatchObject({ ok: true, seerrIssueId: 905, outcome: 'inserted' });
    await signIn(page, 'admin');
    await page.goto('/admin/seerr');
    await expect(page.locator('[data-testid="seerr-admin-issue"][data-issue="905"]')).toContainText('Webhook report');
  });
});
