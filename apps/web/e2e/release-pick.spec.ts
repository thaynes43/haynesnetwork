// ADR-109 C-06 / DESIGN-055 D-01, D-06 (PLAN-077 P5) end to end: the Release Pick ("See every release"), against the
// stub *arr's Release Pick fixtures (POST /_stub/release-pick: Breaking Prod gains a Season 4 whose E03 and E05 are
// missing, and `GET /release?seriesId=&seasonNumber=4` lists their releases in Sonarr's decision order):
//   • Episode A (E03): Force Search on the missing episode offers "See every release"; the approved release is the
//     best choice; grabbed, Sonarr receives the plain body (`{guid, indexerId}`, nothing else) and the live chip follows
//     the download. Run as the admin: the hourly media-action budget is shared across the suite, and the admin bypasses
//     it, so this stays order-independent.
//   • Episode B (E05), as a member (the owner's Q-01 ruling: anyone who can use Fix may pick a release outside the
//     library's usual rules): the best choice is the Override whose name matches the episode; the blocklisted release and
//     the one whose name says it is another episode sit under "Releases you can't pick" with their reasons in plain words
//     and an "Ask staff" ticket; a release the site refuses (409) is marked and the person picks another; the override
//     grab's body pins the series, the episode, the row's own quality and languages, no download client and
//     `shouldOverride`. The release numbered for another episode shows its "Numbered as" line. Three hourly media actions
//     (the list and two grabs).
//   • Episodes C (E07 and E08, P5 decision 17, issue #936), as the admin: the only release is one two-episode file and
//     both episodes are missing, so it is a pick for both. The row says which episodes it holds, the confirm names each,
//     and the override grab's body lists both episode ids.
// The `import_check` (Force Search checks the queue first) and `release_pick` remedies are switched on through the admin
// card on /admin/fixes for this file only and switched off afterwards, and the stub is reset, so no later spec sees them.
//
// NB: the file name keeps this suite alphabetically AFTER library.spec.ts: the list and Repair Request events it lands on
// Breaking Prod (release_list_requested / repair_requested, dated now) must not outrank the seeded history that spec
// asserts. Its Repair Requests stay open on Season 4 episodes, which no other spec touches.
import { test, expect, type Browser, type Page, type TestInfo } from '@playwright/test';
import { signIn } from './support/helpers';
import { readRuntimeEnv } from './support/env';
import {
  RELEASE_PICK_B_EPISODE_ID,
  RELEASE_PICK_C_EPISODE_IDS,
  RELEASE_PICK_C_GUID,
  RELEASE_PICK_REFUSED_GUID,
  STUB_SERIES_ID,
} from './support/stub-arr';

const REMEDY_LABELS = [/Force Search checks the queue first/, /See every release/];
const A_LABEL = 'S04E03 · Rollback Rodeo';
const B_LABEL = 'S04E05 · Hotfix Hootenanny';
const A_GOOD = 'Breaking.Prod.S04E03.Rollback.Rodeo.1080p.WEB-DL.DDP5.1.H.264-GOOD';
const B_OLDT = 'Breaking.Prod.S04E05.Hotfix.Hootenanny.1080p.HMAX.WEB-DL.DDP2.0.H.265-OldT';
const B_WVF = 'Breaking.Prod.S04E05.720p.WEB.h264-WvF';
const B_NUMBERED = 'Breaking.Prod.S04E04.Hotfix.Hootenanny.1080p.HMAX.WEB-DL-OldT';
const B_BLOCKLISTED = 'Breaking.Prod.S04E05.1080p.AMZN.WEB-DL.DDP5.1.H.264.DUAL-BiOMA';
const B_WRONG_TITLE = 'Breaking.Prod.S04E05.Legacy.Code.1080p.WEB-DL-OldT';
const B_REFUSED = 'Breaking.Prod.S04E05.480p.WEB.h264-NOPE';
const UNRELATED = 'Standup.Showdown';
const C_LABELS = ['S04E07 · Merge Conflict', 'S04E08 · Deploy Day'] as const;
const C_TWO = 'Breaking.Prod.S04E07E08.720p.WEB.H.264-JFF';

async function stubArr(path: string, body?: unknown): Promise<void> {
  const env = readRuntimeEnv();
  const res = await fetch(`${env.STUB_ARR_URL}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`stub-arr ${path} failed: ${res.status}`);
}

/** The `POST /release` bodies the stub accepted, in order. */
async function releaseGrabs(): Promise<Record<string, unknown>[]> {
  const env = readRuntimeEnv();
  const res = await fetch(`${env.STUB_ARR_URL}/_stub/release-grabs`);
  if (!res.ok) throw new Error(`stub-arr release-grabs fetch failed: ${res.status}`);
  return (await res.json()) as Record<string, unknown>[];
}

/** Reset the stub and serve the Release Pick fixtures. */
async function stageReleasePick(): Promise<void> {
  await stubArr('/_stub/reset');
  await stubArr('/_stub/release-pick', { on: true });
}

/** Switch the queue check and the Release Pick through the admin card (audited, one Save). */
async function setRemedies(page: Page, on: boolean): Promise<void> {
  await page.goto('/admin/fixes');
  const card = page.locator('.repair-guide-settings');
  await expect(card.getByRole('heading', { name: 'Repair Guide' })).toBeVisible();
  for (const label of REMEDY_LABELS) {
    const box = card.getByRole('checkbox', { name: label });
    if (on) await box.check();
    else await box.uncheck();
  }
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

/** Open Force Search on one Season 4 episode, then "See every release" from its search step. */
async function seeEveryRelease(page: Page, row: string) {
  const section = page.locator('.season').filter({ hasText: 'Season 4' });
  await section.locator('.season__title').click();
  await expect(section).toHaveJSProperty('open', true);
  await section.locator('.child-row').filter({ hasText: row }).getByRole('button', { name: 'Force Search' }).click();
  const dialog = page.getByRole('dialog', { name: 'Force search Breaking Prod' });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText(`Force a fresh search for ${row}?`)).toBeVisible({ timeout: 30_000 });
  await expect(dialog).toContainText('including ones the library would not normally take');
  await dialog.getByRole('button', { name: 'See every release' }).click();
  await expect(dialog.locator('.release-pick')).toBeVisible({ timeout: 60_000 });
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

test.describe('the Release Pick (ADR-109 C-06 / DESIGN-055 D-06, PLAN-077 P5)', () => {
  test.beforeAll(async ({ browser }) => {
    await asAdmin(browser, (page) => setRemedies(page, true));
  });

  test.afterAll(async ({ browser }) => {
    await stubArr('/_stub/reset');
    // Later specs expect today's Force Search dialog.
    await asAdmin(browser, (page) => setRemedies(page, false));
  });

  test('episode A: the approved release is the best choice, and its grab sends only the guid and the site', async ({
    page,
  }) => {
    test.setTimeout(120_000);
    await page.setViewportSize({ width: 1280, height: 900 });
    await stageReleasePick();
    await signIn(page, 'admin');
    await openBreakingProd(page);
    const dialog = await seeEveryRelease(page, A_LABEL);

    const best = dialog.locator('.release-pick__row--best');
    await expect(best).toContainText('Best choice');
    await expect(best).toContainText(A_GOOD);
    await expect(best).toContainText('Fits the library’s rules');
    await expect(best).toContainText('It’s the one the library would pick on its own, and its name matches this episode.');
    await expect(best).toContainText('1080p · 0.6 GB · English · StubIndexer');
    await expect(best).not.toContainText('(Prowlarr)');
    // Episode B's releases and the unrelated episode's are not this episode's.
    await expect(dialog).not.toContainText('Hotfix.Hootenanny');
    await expect(dialog).not.toContainText(UNRELATED);
    expect(await releaseGrabs()).toEqual([]);

    await best.getByRole('button', { name: 'Pick this one' }).click();
    await expect(dialog.getByRole('heading', { name: 'Grab this release?' })).toBeVisible();
    await expect(dialog).toContainText(`Download this release for ${A_LABEL}.`);
    await expect(dialog).toContainText('Nothing is deleted or blocked.');
    await expect(dialog).not.toContainText('outside the library’s usual rules');
    await dialog.getByRole('button', { name: 'Grab this release' }).click();

    await expect(dialog).toContainText(`Grabbed it for ${A_LABEL}.`, { timeout: 30_000 });
    expect(await releaseGrabs()).toEqual([{ guid: 'stub-rp-a1', indexerId: 1 }]);
    await expect(dialog.locator('.action-progress')).toHaveAttribute('data-live-phase', 'downloading', {
      timeout: 30_000,
    });
    await expect(dialog.locator('.action-progress')).toContainText('Downloading');

    await dialog.getByRole('button', { name: 'Done' }).click();
    await expect(dialog).toHaveCount(0);
  });

  test('episode B: a member overrides the best choice past the usual rules after a site refuses another pick', async ({
    page,
  }, testInfo) => {
    test.setTimeout(120_000);
    await page.setViewportSize({ width: 1280, height: 900 });
    await stageReleasePick();
    await signIn(page, 'member');
    await openBreakingProd(page);
    const dialog = await seeEveryRelease(page, B_LABEL);

    // The best choice: the release outside the usual rules whose name matches the episode, and why.
    const best = dialog.locator('.release-pick__row--best');
    await expect(best).toContainText(B_OLDT);
    await expect(best).toContainText('Outside the usual rules');
    await expect(best).toContainText(
      'The closest to what the library usually keeps, and its name matches this episode.',
    );
    await expect(best).toContainText('Its name matches this episode');
    await expect(best).toContainText('Lower quality than the library usually keeps');
    await expect(dialog).toContainText('Picking a release uses one hourly media action.');

    // The other releases the person can pick, each in plain words, the *arr's words under their own disclosure.
    const rows = dialog.locator('.release-pick__row');
    await expect(rows.filter({ hasText: B_WVF })).toContainText('Not a quality the library usually keeps (720p)');
    const numbered = rows.filter({ hasText: B_NUMBERED });
    await expect(numbered).toContainText('Numbered as S04E04, but its title is this episode’s');
    const words = numbered.locator('.release-pick__arr');
    await words.locator('summary').click();
    await expect(words).toContainText('What Sonarr says');
    await expect(words).toContainText('have score -9925 below Series profile minimum 0');
    await expect(dialog).not.toContainText(UNRELATED);

    // The ones nobody can pick, closed by default, with their reasons and an "Ask staff" ticket.
    const blocked = dialog.locator('.release-pick__blocked');
    await expect(blocked.locator(':scope > summary')).toHaveText('Releases you can’t pick (2)');
    await expect(blocked).not.toHaveAttribute('open', '');
    await blocked.locator(':scope > summary').click();
    const blocklisted = blocked.locator('.release-pick__row').filter({ hasText: B_BLOCKLISTED });
    await expect(blocklisted).toContainText('Blocked after an earlier download of it failed or was removed');
    const wrongTitle = blocked.locator('.release-pick__row').filter({ hasText: B_WRONG_TITLE });
    await expect(wrongTitle).toContainText('a different episode (S04E02 · Legacy Code)');
    const ask = wrongTitle.getByRole('link', { name: 'Ask staff' });
    await expect(ask).toHaveAttribute('href', /\/bulletin\?tab=helpdesk&compose=1&about=[0-9a-f-]{36}&episode=50505&/);
    await expect(ask).toHaveAttribute('href', /category=missing/);
    await expect(blocked.getByRole('button', { name: 'Pick this one' })).toHaveCount(0);
    await blocked.locator(':scope > summary').click();
    await checkWidths(page, testInfo, 'release-pick-list');

    // A site that refuses the file: the row is marked and the list stays.
    const refused = rows.filter({ hasText: B_REFUSED });
    await refused.getByRole('button', { name: 'Pick this one' }).click();
    await expect(dialog.getByRole('heading', { name: 'Grab this release?' })).toBeVisible();
    await dialog.getByRole('button', { name: 'Grab this release' }).click();
    await expect(refused).toContainText('That site wouldn’t hand it over.', { timeout: 30_000 });
    await expect(refused.getByRole('button', { name: 'Try another site' })).toHaveCount(0);
    expect(await releaseGrabs()).toEqual([]);

    // The best choice instead: the confirm says plainly it is outside the usual rules, and why.
    await best.getByRole('button', { name: 'Pick this one' }).click();
    await expect(dialog.getByRole('heading', { name: 'Grab this release?' })).toBeVisible();
    await expect(dialog).toContainText(`Download this release for ${B_LABEL}.`);
    await expect(dialog).toContainText('It is outside the library’s usual rules');
    await expect(dialog).toContainText('Grabbing it makes an exception for this one episode.');
    await expect(dialog).toContainText('Nothing is deleted or blocked.');
    await expect(dialog).toContainText('It uses one of your hourly media actions.');
    await checkWidths(page, testInfo, 'release-pick-confirm');
    // Back keeps the list (no new search), and the refusal mark with it.
    await dialog.getByRole('button', { name: 'Back' }).click();
    await expect(rows.filter({ hasText: B_REFUSED })).toContainText('That site wouldn’t hand it over.');
    await best.getByRole('button', { name: 'Pick this one' }).click();
    await dialog.getByRole('button', { name: 'Grab this release' }).click();

    await expect(dialog).toContainText(`Grabbed it for ${B_LABEL}, as an exception to the library’s usual rules.`, {
      timeout: 30_000,
    });
    const grabs = await releaseGrabs();
    expect(grabs).toHaveLength(1);
    expect(grabs[0]).toEqual({
      guid: 'stub-rp-b1',
      indexerId: 1,
      seriesId: STUB_SERIES_ID,
      episodeIds: [RELEASE_PICK_B_EPISODE_ID],
      quality: {
        quality: { id: 3, name: 'WEBDL-1080p', source: 'web', resolution: 1080, modifier: 'none' },
        revision: { version: 1, real: 0, isRepack: false },
      },
      languages: [{ id: 1, name: 'English' }],
      downloadClientId: null,
      shouldOverride: true,
    });
    expect(grabs.some((g) => g.guid === RELEASE_PICK_REFUSED_GUID)).toBe(false);
    await expect(dialog.locator('.action-progress')).toHaveAttribute('data-live-phase', 'downloading', {
      timeout: 30_000,
    });

    await dialog.getByRole('button', { name: 'Done' }).click();
    await expect(dialog).toHaveCount(0);
  });
  test('episodes C: a two-episode release fills both missing episodes, and the confirm names each (P5 decision 17)', async ({
    page,
  }) => {
    test.setTimeout(120_000);
    await page.setViewportSize({ width: 1280, height: 900 });
    await stageReleasePick();
    await signIn(page, 'admin');
    await openBreakingProd(page);
    const dialog = await seeEveryRelease(page, C_LABELS[1]);

    const best = dialog.locator('.release-pick__row--best');
    await expect(best).toContainText(C_TWO);
    await expect(best).toContainText('Outside the usual rules');
    await expect(best).toContainText('Holds S04E07 and S04E08, both missing');
    await expect(best).toContainText('Not a quality the library usually keeps (720p)');
    await expect(best).not.toContainText('Holds more than this one episode');
    // Nothing for the other targets of the season is on this list.
    await expect(dialog).not.toContainText('Hotfix.Hootenanny');

    await best.getByRole('button', { name: 'Pick this one' }).click();
    await expect(dialog.getByRole('heading', { name: 'Grab this release?' })).toBeVisible();
    await expect(dialog).toContainText('Download this release for both of the missing episodes it holds:');
    for (const label of C_LABELS) await expect(dialog.locator('.release-pick__sub')).toContainText(label);
    await expect(dialog).toContainText('Grabbing it makes an exception for these episodes.');
    await expect(dialog).toContainText('Nothing is deleted or blocked.');
    await dialog.getByRole('button', { name: 'Grab this release' }).click();

    await expect(dialog).toContainText(
      `Grabbed it for ${C_LABELS[0]} and ${C_LABELS[1]}, as an exception to the library’s usual rules.`,
      { timeout: 30_000 },
    );
    expect(await releaseGrabs()).toEqual([
      expect.objectContaining({
        guid: RELEASE_PICK_C_GUID,
        indexerId: 2,
        seriesId: STUB_SERIES_ID,
        episodeIds: [...RELEASE_PICK_C_EPISODE_IDS],
        downloadClientId: null,
        shouldOverride: true,
      }),
    ]);
    await expect(dialog.locator('.action-progress')).toHaveAttribute('data-live-phase', 'downloading', {
      timeout: 30_000,
    });
    await dialog.getByRole('button', { name: 'Done' }).click();
    await expect(dialog).toHaveCount(0);
  });
});
