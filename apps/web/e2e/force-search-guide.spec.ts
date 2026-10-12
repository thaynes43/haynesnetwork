// ADR-109 C-05 / DESIGN-055 D-07 (PLAN-077 P2) end to end — the queue-aware Force Search (the Force Search step of the
// Repair Guide), against the stub *arr's import-check fixtures (POST /_stub/import-check plus a staged queue):
//   • Case B (AC-41): a member's Force Search on a missing episode whose finished download is import-blocked by
//     Sonarr's folder-name rejection shows what it found and "Import it"; pressed, it imports the file (one ManualImport,
//     no EpisodeSearch) and says "Found a finished download and imported it."
//   • On its way: a Force Search on an episode that is still downloading shows its progress and sends nothing.
//   • The staff path: a download left packed needs staff; "Open a ticket" opens the Helpdesk composer prefilled with the
//     title, the episode and what Force Search found (the ticket is not filed). Run as the admin, who may file tickets.
// The `import_check` remedy is switched on through the admin card on /admin/fixes for this file only and switched off
// again afterwards, and the stub is reset, so no later spec sees the guide or the fixtures.
import { test, expect, type Browser, type Page, type TestInfo } from '@playwright/test';
import { signIn } from './support/helpers';
import { readRuntimeEnv } from './support/env';
import {
  IMPORT_CHECK_DOWNLOAD_ID,
  IMPORT_CHECK_EPISODE_ID,
  IMPORT_CHECK_FILE,
  STUB_SERIES_ID,
  importCheckArchiveQueueFixture,
  importCheckQueueFixture,
  type RecordedArrWrite,
} from './support/stub-arr';

const REMEDY_LABEL = /Force Search checks the queue first/;
const CASE_B_LABEL = 'S01E10 · 125 Years Young';

async function stubArr(path: string, body?: unknown): Promise<void> {
  const env = readRuntimeEnv();
  const res = await fetch(`${env.STUB_ARR_URL}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`stub-arr ${path} failed: ${res.status}`);
}

async function arrCalls(): Promise<RecordedArrWrite[]> {
  const env = readRuntimeEnv();
  const res = await fetch(`${env.STUB_ARR_URL}/_stub/calls`);
  if (!res.ok) throw new Error(`stub-arr calls fetch failed: ${res.status}`);
  return ((await res.json()) as { calls: RecordedArrWrite[] }).calls;
}

/** Reset the stub, serve the import-check fixtures, and stage the queue. */
async function stageQueue(records: Record<string, unknown>[]): Promise<void> {
  await stubArr('/_stub/reset');
  await stubArr('/_stub/import-check', { on: true });
  await stubArr('/_stub/queue', { records });
}

/** Switch the `import_check` remedy through the admin card (audited, one Save). */
async function setImportCheck(page: Page, on: boolean): Promise<void> {
  await page.goto('/admin/fixes');
  const card = page.locator('.repair-guide-settings');
  await expect(card.getByRole('heading', { name: 'Repair Guide' })).toBeVisible();
  const box = card.getByRole('checkbox', { name: REMEDY_LABEL });
  if (on) await box.check();
  else await box.uncheck();
  await card.getByRole('button', { name: 'Save' }).click();
  await expect(card.getByRole('status')).toHaveText('Saved.');
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

async function openBreakingProd(page: Page): Promise<void> {
  await page.locator('.topbar__nav').getByRole('link', { name: 'Library' }).click();
  await page.waitForURL('/library');
  await page.getByRole('tab', { name: 'TV' }).click();
  await page.locator('.media-card').filter({ hasText: 'Breaking Prod' }).click();
  await page.waitForURL(/\/library\/[0-9a-f-]{36}$/);
  await expect(page.locator('.detail-head__title')).toContainText('Breaking Prod');
}

/** Open Force Search on one episode row (the season is a collapsible section). */
async function forceSearchEpisode(page: Page, season: string, row: string) {
  const section = page.locator('.season').filter({ hasText: season });
  await section.locator('.season__title').click();
  await expect(section).toHaveJSProperty('open', true);
  await section.locator('.child-row').filter({ hasText: row }).getByRole('button', { name: 'Force Search' }).click();
  const dialog = page.getByRole('dialog', { name: 'Force search Breaking Prod' });
  await expect(dialog).toBeVisible();
  return dialog;
}

/** The dialog fits a phone and a desktop: no sideways page scroll, the box inside the viewport. Captured for review. */
async function checkWidths(page: Page, testInfo: TestInfo, name: string): Promise<void> {
  for (const [label, w, h] of [
    ['desktop', 1280, 900],
    ['390', 390, 844],
  ] as const) {
    await page.setViewportSize({ width: w, height: h });
    const box = await page.getByRole('dialog').boundingBox();
    expect(box, label).not.toBeNull();
    expect(box!.x, label).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width, label).toBeLessThanOrEqual(w + 0.5);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow, label).toBeLessThanOrEqual(0);
    const path = testInfo.outputPath(`${name}-${label}.png`);
    await page.screenshot({ path });
    await testInfo.attach(`${name}-${label}`, { path, contentType: 'image/png' });
  }
  await page.setViewportSize({ width: 1280, height: 900 });
}

test.describe.configure({ mode: 'serial' });

test.describe('queue-aware Force Search (ADR-109 C-05 / DESIGN-055 D-07, PLAN-077 P2)', () => {
  test.beforeAll(async ({ browser }) => {
    await asAdmin(browser, (page) => setImportCheck(page, true));
  });

  test.afterAll(async ({ browser }) => {
    await stubArr('/_stub/reset');
    // Later specs expect today's Force Search dialog.
    await asAdmin(browser, (page) => setImportCheck(page, false));
  });

  test('Case B: a finished download held by a folder-name rejection is imported, not searched (AC-41)', async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await stageQueue(importCheckQueueFixture());
    await signIn(page, 'member');
    await openBreakingProd(page);
    // The episode list is read live from Sonarr, so the row carries Case B's title while the fixtures are on.
    const dialog = await forceSearchEpisode(page, 'Season 1', CASE_B_LABEL);

    // What it found, each fact with its source; what it will do; and nothing written yet.
    await expect(
      dialog.getByRole('heading', { name: `A finished download for ${CASE_B_LABEL} is waiting to be added` }),
    ).toBeVisible({ timeout: 30_000 });
    await expect(dialog).toContainText(IMPORT_CHECK_FILE);
    await expect(dialog).toContainText('WEBDL-2160p');
    await expect(dialog).toContainText('FLUX');
    await expect(dialog).toContainText('The file name matches the episode title');
    await expect(dialog).toContainText('were unexpected considering the Breaking_Prod_2019_S01E10_125_Years_Young folder name');
    await expect(dialog).toContainText(`Add this file to ${CASE_B_LABEL}.`);
    await expect(dialog).toContainText('Nothing is deleted or blocked.');
    expect(await arrCalls()).toEqual([]);
    await checkWidths(page, testInfo, 'force-search-import');

    await dialog.getByRole('button', { name: 'Import it' }).click();
    await expect(dialog).toContainText('Found a finished download and imported it.', { timeout: 30_000 });

    // One ManualImport onto the episode, and no search, no blocklist, no delete.
    const writes = await arrCalls();
    const commands = writes.filter((c) => c.path === '/command');
    expect(commands.map((c) => (c.body as { name: string }).name)).toEqual(['ManualImport']);
    expect(commands[0]!.body).toMatchObject({
      name: 'ManualImport',
      importMode: 'auto',
      files: [{ seriesId: STUB_SERIES_ID, episodeIds: [IMPORT_CHECK_EPISODE_ID], downloadId: IMPORT_CHECK_DOWNLOAD_ID }],
    });
    expect(writes.some((c) => c.path.startsWith('/history/failed/'))).toBe(false);
    expect(writes.some((c) => c.method === 'DELETE')).toBe(false);

    await dialog.getByRole('button', { name: 'Done' }).click();
    await expect(dialog).toHaveCount(0);
  });

  test('a download on its way shows its progress and sends nothing', async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await stageQueue(importCheckQueueFixture());
    await signIn(page, 'member');
    await openBreakingProd(page);
    const dialog = await forceSearchEpisode(page, 'Season 2', 'S02E02 · Reckoning');

    await expect(dialog.getByRole('heading', { name: 'Already on its way' })).toBeVisible({ timeout: 30_000 });
    await expect(dialog).toContainText('Breaking.Prod.S02E02.Reckoning.1080p.WEB-DL-STUB');
    await expect(dialog).toContainText('Downloading');
    await expect(dialog).toContainText('45% · about 12 minutes left');
    await expect(dialog).toContainText('Nothing was searched, so nothing is lost.');
    await expect(dialog.getByRole('button', { name: /Force search|Import it|Remove it/ })).toHaveCount(0);
    await checkWidths(page, testInfo, 'force-search-on-its-way');

    await dialog.getByRole('button', { name: 'Done' }).click();
    await expect(dialog).toHaveCount(0);
    expect(await arrCalls()).toEqual([]);
  });

  test('a packed download goes to staff, with the Helpdesk ticket prefilled', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await stageQueue(importCheckArchiveQueueFixture());
    // The admin: filing a ticket needs the Helpdesk post permission, which the seeded member role does not carry (a
    // person without it lands on the Helpdesk with its "ask an admin" note, and the link's parameters are dropped).
    await signIn(page, 'admin');
    await openBreakingProd(page);
    // The episode list is read live from Sonarr, so the row carries Case B's title while the fixtures are on.
    const dialog = await forceSearchEpisode(page, 'Season 1', CASE_B_LABEL);

    await expect(dialog.getByRole('heading', { name: `A download for ${CASE_B_LABEL} needs staff` })).toBeVisible({
      timeout: 30_000,
    });
    await expect(dialog).toContainText(
      'This download has to be unpacked before it can be added, and that needs staff for now.',
    );
    await expect(dialog.getByRole('button', { name: /Import it|Remove it/ })).toHaveCount(0);
    await dialog.getByRole('link', { name: 'Open a ticket' }).click();

    // The composer opens with the title, the episode and what Force Search found; nothing is filed until asked.
    await page.waitForURL(/\/bulletin/);
    const compose = page.getByRole('dialog', { name: 'New ticket' });
    await expect(compose).toBeVisible();
    await expect(compose.getByTestId('ticket-title')).toHaveValue(`Stuck download: ${CASE_B_LABEL}`);
    await expect(compose.getByTestId('ticket-body')).toHaveValue(/that needs staff for now\./);
    await expect(compose.getByTestId('ticket-body')).toHaveValue(/Found archive file, might need to be extracted/);
    await expect(compose).toContainText('Breaking Prod');
    await expect(compose).toContainText(CASE_B_LABEL);
    await expect(compose.getByTestId('ticket-category-missing')).toHaveAttribute('aria-checked', 'true');
    // The link's parameters are gone from the address, so a reload does not reopen the composer.
    await expect(page).toHaveURL(/\/bulletin\?tab=helpdesk$/);
    await compose.getByRole('button', { name: 'Cancel' }).click();
    await expect(compose).toHaveCount(0);
    expect(await arrCalls()).toEqual([]);
  });
});
