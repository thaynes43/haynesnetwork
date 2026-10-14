// ADR-111 C-03 / DESIGN-055 D-10 (PLAN-077 P7) end to end — the Seerr Issue bridge, AC-43's write half, against the stub
// Seerr (stub-arr records every issue write with the `X-API-User` it acted as) and the stub Sonarr's import-check
// fixtures (Case B on Breaking Prod S01E10):
//   • An admin turns the replies on in /admin/seerr, naming the bridge user; the card reads that user from Seerr.
//   • One `seerr-issues` sync run comments exactly once on the new report, as the bridge user, worded for a missing
//     episode with the report's link; the older open reports (filed before the switch went on) get nothing, and a
//     second run posts nothing more.
//   • The reporter follows the link, the guide opens Force Search on the episode, and "Import it" imports the stuck
//     download (a Repair Request that names the report). The next sync posts the outcome note and resolves the report,
//     both as the bridge user, once; /admin/seerr shows both replies.
// The `import_check` remedy and the bridge are switched on through their admin cards for this file only and off again
// afterwards; the stub is reset and its issues emptied (every report marked removed), so no later spec sees them.
import { join } from 'node:path';
import { test as base, expect, type BrowserContext, type Page, type TestInfo } from '@playwright/test';
import { signIn } from './support/helpers';
import { readRuntimeEnv } from './support/env';
import { createOwnedProcessRunner } from './support/owned-process';
import {
  STUB_SEERR_BRIDGE_USER_ID,
  STUB_SERIES_TVDB_ID,
  importCheckQueueFixture,
  seerrIssueFixture,
  type RecordedArrWrite,
} from './support/stub-arr';

/** The new report's Seerr id; a CI retry uses a fresh one, since the first attempt's writes are already recorded. */
let NEW_REPORT = 906;
const env = () => readRuntimeEnv();

const test = base.extend<{ seerrSync: () => Promise<void> }, { adminContext: BrowserContext; adminPage: Page }>({
  seerrSync: [async ({}, provide) => {
    const runner = createOwnedProcessRunner({
      command: process.execPath,
      args: [
        '--import', require.resolve('tsx'),
        join(process.cwd(), '..', '..', 'packages', 'sync', 'src', 'scripts', 'sync.ts'), '--mode=seerr-issues',
      ],
      env: { ...process.env, ...env() },
      label: 'seerr-issues sync',
    });
    try {
      await provide(() => runner.run());
    } finally {
      await runner.dispose();
    }
  }, { timeout: 5_000, title: 'Seerr sync runner' }],
  adminContext: [async ({ browser }, provide) => {
    const context = await browser.newContext({ baseURL: env().BETTER_AUTH_URL });
    try {
      // Yield before authentication so the dependent page's setup failure still has registered context teardown.
      await provide(context);
    } finally {
      await context.close();
    }
  }, { scope: 'worker', timeout: 15_000, title: 'Admin context' }],
  adminPage: [async ({ adminContext }, provide) => {
    const page = await adminContext.newPage();
    await test.step('Sign in as an administrator', () => signIn(page, 'admin'));
    await provide(page);
  }, { scope: 'worker', timeout: 30_000, title: 'Admin sign-in' }],
});

async function stubArr(path: string, body?: unknown): Promise<void> {
  const res = await fetch(`${env().STUB_ARR_URL}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`stub-arr ${path} failed: ${res.status}`);
}

/** The Seerr issue writes the stub recorded, oldest first. */
async function seerrWrites(): Promise<RecordedArrWrite[]> {
  const res = await fetch(`${env().STUB_ARR_URL}/_stub/calls`);
  const { calls } = (await res.json()) as { calls: RecordedArrWrite[] };
  return calls.filter((c) => c.path.startsWith('/issue/'));
}

/** Switch the `import_check` remedy through the admin card (audited, one Save). */
async function setImportCheck(page: Page, on: boolean): Promise<void> {
  await page.goto('/admin/fixes');
  const card = page.locator('.repair-guide-settings');
  await expect(card.getByRole('heading', { name: 'Repair Guide' })).toBeVisible();
  const box = card.getByRole('checkbox', { name: /Force Search checks the queue first/ });
  if (on) await box.check();
  else await box.uncheck();
  await card.getByRole('button', { name: 'Save' }).click();
  await expect(card.getByRole('status')).toHaveText('Saved.');
}

/**
 * Close every open Fix on Breaking Prod (the admin escape hatch, the two-step ConfirmButton), so the import below meets no
 * open fix on its season left by an earlier spec (the repair-guide.spec.ts pattern).
 */
async function closeOpenFixes(page: Page): Promise<void> {
  await page.goto('/admin/fixes');
  // The list loads after the page: count the close buttons only once it is there (a row, or the empty state when this
  // spec runs alone on a fresh database).
  await expect(page.locator('.admin-table tbody tr').first().or(page.getByText(/^No fix requests/))).toBeVisible();
  const rows = page.locator('.admin-table tbody tr').filter({ hasText: 'Breaking Prod' });
  for (let i = 0; i < 10; i += 1) {
    const close = rows.getByRole('button', { name: /Close the open fix/ });
    if ((await close.count()) === 0) return;
    await close.first().click();
    const confirm = rows.getByRole('button', { name: /Confirm closing the fix/ });
    await expect(confirm).toBeVisible();
    await page.waitForTimeout(350);
    await confirm.click();
    await expect(confirm).toHaveCount(0);
  }
}

/** The Replies in Seerr card on /admin/seerr: both switches and the bridge user, one Save. */
async function setBridge(page: Page, on: boolean): Promise<void> {
  await page.goto('/admin/seerr');
  const card = page.getByTestId('seerr-bridge-settings');
  await expect(card.getByRole('heading', { name: 'Replies in Seerr' })).toBeVisible();
  await card.getByRole('textbox', { name: 'Seerr user id to post as' }).fill(on ? String(STUB_SEERR_BRIDGE_USER_ID) : '');
  for (const name of [/Comment on new reports/, /Resolve once the repair is done/]) {
    const box = card.getByRole('checkbox', { name });
    if (on) await box.check();
    else await box.uncheck();
  }
  await card.getByRole('button', { name: 'Save' }).click();
  await expect(card.getByRole('status')).toHaveText('Saved.');
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

test.describe('the Seerr Issue bridge (ADR-111 C-03 / DESIGN-055 D-10, PLAN-077 P7)', () => {
  test.beforeAll(async () => {
    // Case B's stuck download on Breaking Prod S01E10, behind the queue-aware Force Search.
    await test.step('Prepare the blocked download fixture', async () => {
      await stubArr('/_stub/reset');
      await stubArr('/_stub/seerr-issues', { issues: [] });
      await stubArr('/_stub/import-check', { on: true });
      await stubArr('/_stub/queue', { records: importCheckQueueFixture() });
    });
  });

  // Independent of admin fixture setup: a failed sign-in cannot skip clearing the stub reports and queue.
  test.afterAll(async ({ seerrSync }) => {
    await test.step('Clear the report fixtures', () => stubArr('/_stub/seerr-issues', { issues: [] }));
    await test.step('Sync the removed reports', () => seerrSync());
    await test.step('Reset the download fixtures', () => stubArr('/_stub/reset'));
  });

  test.afterAll(async ({ adminPage }) => {
    await test.step('Restore the replies setting', () => setBridge(adminPage, false));
    await test.step('Restore the import-check setting', () => setImportCheck(adminPage, false));
  });

  test('an admin turns the replies on; a new report gets exactly one comment, as the bridge user (AC-43)', async ({
    adminPage: page,
    seerrSync,
  }, testInfo) => {
    NEW_REPORT = 906 + testInfo.retry;
    await page.setViewportSize({ width: 1280, height: 900 });
    await test.step('Enable import checks', () => setImportCheck(page, true));
    await test.step('Close old open fixes', () => closeOpenFixes(page));
    await test.step('Enable replies on new reports', () => setBridge(page, true));
    const card = page.getByTestId('seerr-bridge-settings');
    await expect(card.getByTestId('seerr-bridge-user')).toHaveText(
      `Posting as haynesnetwork.com (Seerr user ${STUB_SEERR_BRIDGE_USER_ID}).`,
    );
    await checkWidths(page, testInfo, 'seerr-bridge-settings');

    // A report filed after the switch went on: Breaking Prod S01E10, which has no file.
    const now = new Date().toISOString();
    const fresh = {
      ...seerrIssueFixture().find((i) => i.id === 901)!,
      id: NEW_REPORT,
      createdAt: now,
      updatedAt: now,
      media: { id: 9906, downloadStatus: [], status: 5, mediaType: 'tv', tmdbId: 770001, tvdbId: STUB_SERIES_TVDB_ID },
      comments: [{ id: 9906, message: 'Episode 10 is missing', createdAt: now, updatedAt: now }],
    };
    await stubArr('/_stub/seerr-issues', { issues: [...seerrIssueFixture(), fresh] });
    await seerrSync();

    const writes = await seerrWrites();
    expect(writes.map((w) => [w.method, w.path, w.actingUser])).toEqual([
      ['POST', `/issue/${NEW_REPORT}/comment`, String(STUB_SEERR_BRIDGE_USER_ID)],
    ]);
    const message = (writes[0]!.body as { message: string }).message;
    expect(message).toMatch(/^Thanks for the report\. You can try fixing this yourself on haynesnetwork\.com:/);
    expect(message).toContain(`/r/seerr/${NEW_REPORT} and sign in with your Plex account.`);
    expect(message).toContain('2. Press Force Search on S01E10.');
    expect(message).toContain("If that doesn't sort it out, reply here and staff will take a look.");
    expect(message).not.toMatch(/[—–]/);

    // The next run (or a webhook) posts nothing more.
    await seerrSync();
    expect(await seerrWrites()).toHaveLength(1);
  });

  test('the repair the report started completes, and the bridge resolves the report with its note, once', async ({
    page,
    adminPage,
    seerrSync,
  }, testInfo) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await signIn(page, 'member');
    await page.goto(`/r/seerr/${NEW_REPORT}`);
    await page.waitForURL(/\/library\/[0-9a-f-]{36}/);
    const dialog = page.getByRole('dialog', { name: 'Force search Breaking Prod' });
    await expect(dialog).toBeVisible();
    await expect(
      dialog.getByRole('heading', { name: 'A finished download for S01E10 · 125 Years Young is waiting to be added' }),
    ).toBeVisible({ timeout: 30_000 });
    await dialog.getByRole('button', { name: 'Import it' }).click();
    await expect(dialog).toContainText('Found a finished download and imported it.', { timeout: 30_000 });
    await dialog.getByRole('button', { name: 'Done' }).click();

    await seerrSync();
    const writes = await seerrWrites();
    expect(writes.map((w) => [w.path, w.actingUser])).toEqual([
      [`/issue/${NEW_REPORT}/comment`, String(STUB_SEERR_BRIDGE_USER_ID)],
      [`/issue/${NEW_REPORT}/comment`, String(STUB_SEERR_BRIDGE_USER_ID)],
      [`/issue/${NEW_REPORT}/resolved`, String(STUB_SEERR_BRIDGE_USER_ID)],
    ]);
    expect((writes[1]!.body as { message: string }).message).toBe(
      "Fixed on haynesnetwork.com: Force Search found the stuck download for S01E10 and imported it.\n\nIf something still isn't right, use Reopen with Comment and staff will take a look.",
    );
    expect(writes[2]!.body).toBeUndefined();
    await seerrSync();
    expect(await seerrWrites()).toHaveLength(3);

    // The admin view shows both replies on the (now resolved) report.
    await test.step('Check the administrator view of the resolved report', async () => {
      const admin = adminPage;
      await admin.setViewportSize({ width: 1280, height: 900 });
      await admin.goto('/admin/seerr');
      await admin.getByRole('group', { name: 'Which reports' }).getByRole('button', { name: 'All' }).click();
      const issue = admin.locator(`[data-testid="seerr-admin-issue"][data-issue="${NEW_REPORT}"]`);
      await expect(issue).toContainText('Resolved');
      const replies = issue.getByTestId('seerr-admin-replies');
      await expect(replies).toContainText('Fix-it-yourself comment');
      await expect(replies).toContainText('Resolve with a note');
      await expect(replies.getByText('Posted', { exact: true })).toHaveCount(2);
      await expect(issue).toContainText('Import');
      await checkWidths(admin, testInfo, 'seerr-bridge-admin');
    });
  });
});
