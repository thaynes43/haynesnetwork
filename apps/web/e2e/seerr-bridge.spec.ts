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
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { test, expect, type Browser, type Page, type TestInfo } from '@playwright/test';
import { signIn } from './support/helpers';
import { readRuntimeEnv } from './support/env';
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

/** One run of the real `seerr-issues` sync mode (the mirror, then the bridge pass) against the stubs. */
function syncSeerrIssues(): void {
  const res = spawnSync(
    join(process.cwd(), 'node_modules', '.bin', 'tsx'),
    [join(process.cwd(), '..', '..', 'packages', 'sync', 'src', 'scripts', 'sync.ts'), '--mode=seerr-issues'],
    { env: { ...process.env, ...env() }, encoding: 'utf8' },
  );
  if (res.status !== 0) throw new Error(`seerr-issues sync failed:\n${res.stdout}\n${res.stderr}`);
}

async function asAdmin(browser: Browser, run: (page: Page) => Promise<void>): Promise<void> {
  const context = await browser.newContext();
  const page = await context.newPage();
  try {
    await signIn(page, 'admin');
    await run(page);
  } finally {
    await context.close();
  }
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
  test.beforeAll(async ({ browser }) => {
    // Case B's stuck download on Breaking Prod S01E10, behind the queue-aware Force Search.
    await stubArr('/_stub/reset');
    await stubArr('/_stub/seerr-issues', { issues: [] });
    await stubArr('/_stub/import-check', { on: true });
    await stubArr('/_stub/queue', { records: importCheckQueueFixture() });
    await asAdmin(browser, async (page) => {
      await setImportCheck(page, true);
      await closeOpenFixes(page);
    });
  });

  test.afterAll(async ({ browser }) => {
    await stubArr('/_stub/seerr-issues', { issues: [] });
    syncSeerrIssues();
    await stubArr('/_stub/reset');
    await asAdmin(browser, async (page) => {
      await setBridge(page, false);
      await setImportCheck(page, false);
    });
  });

  test('an admin turns the replies on; a new report gets exactly one comment, as the bridge user (AC-43)', async ({
    page,
  }, testInfo) => {
    NEW_REPORT = 906 + testInfo.retry;
    await page.setViewportSize({ width: 1280, height: 900 });
    await signIn(page, 'admin');
    await setBridge(page, true);
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
    syncSeerrIssues();

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
    syncSeerrIssues();
    expect(await seerrWrites()).toHaveLength(1);
  });

  test('the repair the report started completes, and the bridge resolves the report with its note, once', async ({
    page,
    browser,
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

    syncSeerrIssues();
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
    syncSeerrIssues();
    expect(await seerrWrites()).toHaveLength(3);

    // The admin view shows both replies on the (now resolved) report.
    await asAdmin(browser, async (admin) => {
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
