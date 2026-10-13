// ADR-109 C-02, C-07 / DESIGN-055 D-08 (PLAN-077 P6) end to end — the language-aware Wrong language, against the stub
// *arr's language fixtures (POST /_stub/language) and the stub Plex's show preferences:
//   • The file has the wanted audio (Breaking Prod S01E03: Portuguese first and flagged default, English second, like
//     Regular Show: The Lost Tapes S01E12). English is the show's original language, so the guide names the track
//     ("English (EAC3 5.1)", the 2nd of 2), explains how to switch it on each kind of player, and offers to set the
//     show's preferred audio language in Plex; pressed, HaynesTower stores en-US and the guide says so. Nothing is
//     written to the *arr. A second Fix finds it already set and writes nothing.
//   • Another language than the original (Portuguese) gets the advice only, and no offer.
//   • The file lacks it (S01E06, Portuguese only): the preview is the Language Replace, the English release that would
//     replace it; confirmed, the Fix blocks the Portuguese download, deletes the file and grabs that release.
// The remedies are switched on and off through the admin card on /admin/fixes (every remedy ships off), and the one Fix
// this file opens is closed from /admin/fixes, so no later spec sees the guide or an open fix. The file is named to run
// after library.spec (whose first timeline row is the seeded import, and which leaves a Fix open on S01E02), and the
// journeys run as the admin, so the member's hourly budget the other specs count is untouched.
//
import { test, expect, type Browser, type Page, type TestInfo } from '@playwright/test';
import { signIn } from './support/helpers';
import { readRuntimeEnv } from './support/env';
import {
  LANGUAGE_MISSING_EPISODE_ID,
  LANGUAGE_REPLACE_GUID,
  LANGUAGE_REPLACE_TITLE,
  repairGuideGrabIdFor,
  type RecordedArrWrite,
} from './support/stub-arr';

const REMEDY_LABELS = [
  'Check the audio before a Wrong language Fix',
  'Set a show’s audio language in Plex',
  'Replace with a release in the wanted language',
];

async function stub(base: 'arr' | 'plex', path: string, body?: unknown): Promise<Response> {
  const env = readRuntimeEnv();
  const root = base === 'arr' ? env.STUB_ARR_URL : env.STUB_PLEX_URL;
  const res = await fetch(`${root}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`stub-${base} ${path} failed: ${res.status}`);
  return res;
}

async function arrCalls(): Promise<RecordedArrWrite[]> {
  const res = await fetch(`${readRuntimeEnv().STUB_ARR_URL}/_stub/calls`);
  return ((await res.json()) as { calls: RecordedArrWrite[] }).calls;
}

async function plexCalls(): Promise<Array<{ method: string; path: string; machineId: string; body: unknown }>> {
  const res = await fetch(`${readRuntimeEnv().STUB_PLEX_URL}/_stub/calls`);
  return ((await res.json()) as { calls: Array<{ method: string; path: string; machineId: string; body: unknown }> }).calls;
}

/** Reset both stubs, then serve the language fixtures (and the season-1 grab history the Fix blocks). */
async function stageLanguageFixtures(): Promise<void> {
  await stub('arr', '/_stub/reset');
  await stub('arr', '/_stub/repair-guide', { on: true });
  await stub('arr', '/_stub/language', { on: true });
  await stub('plex', '/_stub/reset');
}

async function setRemedies(page: Page, on: boolean): Promise<void> {
  await page.goto('/admin/fixes');
  const card = page.locator('.repair-guide-settings');
  await expect(card.getByRole('heading', { name: 'Repair Guide' })).toBeVisible();
  for (const label of REMEDY_LABELS) {
    const box = card.getByRole('checkbox', { name: new RegExp(label) });
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

async function openEpisodeFix(page: Page, label: string) {
  await page.locator('.topbar__nav').getByRole('link', { name: 'Library' }).click();
  await page.waitForURL('/library');
  await page.getByRole('tab', { name: 'TV' }).click();
  await page.locator('.media-card').filter({ hasText: 'Breaking Prod' }).click();
  await page.waitForURL(/\/library\/[0-9a-f-]{36}$/);
  const season1 = page.locator('.season').filter({ hasText: 'Season 1' });
  await season1.locator('.season__title').click();
  await expect(season1).toHaveJSProperty('open', true);
  await page.locator('.child-row').filter({ hasText: label }).getByRole('button', { name: 'Fix' }).click();
  const dialog = page.getByRole('dialog', { name: 'Fix Breaking Prod' });
  await expect(dialog).toContainText(label);
  await dialog.getByRole('radio', { name: "It's in the wrong language" }).check();
  await dialog.getByRole('button', { name: 'Next' }).click();
  await expect(dialog.getByRole('group', { name: 'Which language did you want?' })).toBeVisible();
  return dialog;
}

/** The dialog stays inside the viewport with no sideways scroll, at desktop and phone widths. */
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

test.describe('the language-aware Wrong language (ADR-109 C-07 / DESIGN-055 D-08, PLAN-077 P6)', () => {
  test.beforeAll(async ({ browser }) => {
    await asAdmin(browser, (page) => setRemedies(page, true));
  });

  test.afterAll(async ({ browser }) => {
    await stub('arr', '/_stub/reset');
    await stub('plex', '/_stub/reset');
    await asAdmin(browser, async (page) => {
      await setRemedies(page, false);
      // Close the S01E06 Fix this file opened, so no later spec meets an open fix.
      await page.goto('/admin/fixes');
      const row = page.locator('.admin-table tbody tr').filter({ hasText: 'Breaking Prod' }).filter({ hasText: 'S01E06' });
      const closeButtons = row.getByRole('button', { name: /Close the open fix/ });
      if ((await closeButtons.count()) > 0) {
        await closeButtons.first().click();
        const confirmClose = row.getByRole('button', { name: /Confirm closing the fix/ });
        await expect(confirmClose).toBeVisible();
        await page.waitForTimeout(350);
        await confirmClose.click();
        await expect(row.getByRole('button', { name: /Close the open fix|Confirm closing the fix/ })).toHaveCount(0);
      }
    });
  });

  test('the file has English, the show’s original language: the track advice, then Plex plays English first', async ({
    page,
  }, testInfo) => {
    await stageLanguageFixtures();
    await signIn(page, 'admin');
    const dialog = await openEpisodeFix(page, 'S01E03 · Chapter 3');
    await expect(dialog.getByRole('radio', { name: /English \(in this file\)/ })).toBeChecked();
    await expect(dialog.getByRole('radio', { name: /Portuguese \(in this file\)/ })).toBeVisible();
    await dialog.getByRole('button', { name: 'Next' }).click();

    await expect(dialog.getByRole('heading', { name: 'This file already has English audio.' })).toBeVisible();
    // Which track, as Plex names it, and why the other one plays first.
    await expect(dialog).toContainText('Choose English (EAC3 5.1), the 2nd of 2 audio tracks.', { timeout: 30_000 });
    await expect(dialog).toContainText('The file marks Português (EAC3 5.1) as its main track');
    await expect(dialog).toContainText('Phone or tablet:');
    await expect(dialog).toContainText('TV or streaming box:');
    await expect(dialog.getByRole('link', { name: 'Plex account settings' })).toBeVisible();
    await expect(dialog.getByRole('link', { name: 'Watching Movies & TV' })).toHaveAttribute('href', '/about#watching');
    // The offer: English is the show's original language.
    await expect(dialog).toContainText('English is this show’s original language.');
    await expect(dialog).toContainText('for everyone, on HaynesTower');
    await checkWidths(page, testInfo, 'language-present-offer');
    expect(await plexCalls()).toEqual([]);

    await dialog.getByRole('button', { name: 'Play English first on this show' }).click();
    await expect(dialog.getByRole('heading', { name: 'Done. Plex now plays English first on this show.' })).toBeVisible();
    await expect(dialog).toContainText('It’s set for everyone on HaynesTower.');
    await checkWidths(page, testInfo, 'language-set');

    // One write, on the server that carries the show, of the show's own key; nothing to the *arr.
    expect((await plexCalls()).filter((c) => c.method === 'PUT')).toEqual([
      { method: 'PUT', path: '/library/metadata/501/prefs', machineId: 'haynestower', body: { audioLanguage: 'en-US' } },
    ]);
    expect((await arrCalls()).filter((c) => c.method !== 'GET')).toEqual([]);
    await dialog.getByRole('button', { name: 'Done' }).click();

    // Asked again: Plex already prefers English, so there is no offer and nothing is written.
    const again = await openEpisodeFix(page, 'S01E03 · Chapter 3');
    await again.getByRole('button', { name: 'Next' }).click();
    await expect(again).toContainText('Plex is already set to play English first on this show on HaynesTower.', {
      timeout: 30_000,
    });
    await expect(again.getByRole('button', { name: /Play English first/ })).toHaveCount(0);
    await again.getByRole('button', { name: 'Done' }).click();
    expect((await plexCalls()).filter((c) => c.method === 'PUT')).toHaveLength(1);
  });

  test('another language than the original gets the advice only', async ({ page }) => {
    await stageLanguageFixtures();
    await signIn(page, 'admin');
    const dialog = await openEpisodeFix(page, 'S01E03 · Chapter 3');
    await dialog.getByRole('radio', { name: /Portuguese \(in this file\)/ }).check();
    await dialog.getByRole('button', { name: 'Next' }).click();
    await expect(dialog.getByRole('heading', { name: 'This file already has Portuguese audio.' })).toBeVisible();
    await expect(dialog).toContainText('Portuguese isn’t this show’s original language (English)', { timeout: 30_000 });
    await expect(dialog).toContainText('Choose Português (EAC3 5.1), the 1st of 2 audio tracks.');
    await expect(dialog.getByRole('button', { name: /first on this show/ })).toHaveCount(0);
    await dialog.getByRole('button', { name: 'Done' }).click();
    expect(await plexCalls()).toEqual([]);
  });

  test('the file lacks English: the Language Replace blocks, deletes and grabs the English release', async ({
    page,
  }, testInfo) => {
    await stageLanguageFixtures();
    await signIn(page, 'admin');
    const dialog = await openEpisodeFix(page, 'S01E06 · Chapter 6');
    await dialog.getByRole('button', { name: 'Next' }).click();

    await expect(dialog.getByRole('heading', { name: 'Here’s what will happen' })).toBeVisible({ timeout: 30_000 });
    const replacement = dialog.locator('.repair-guide__card').filter({ hasText: 'Replaces it, with English audio' });
    await expect(replacement).toContainText(LANGUAGE_REPLACE_TITLE);
    await expect(replacement).toContainText('Audio: English');
    await checkWidths(page, testInfo, 'language-replace-preview');

    // Both lines must be ticked first; nothing was written yet.
    const confirm = dialog.getByRole('button', { name: 'Replace it with the English release' });
    await expect(confirm).toBeDisabled();
    const gone = dialog.locator('.repair-guide__gone').getByRole('checkbox');
    await expect(gone).toHaveCount(2);
    expect((await arrCalls()).filter((c) => c.method !== 'GET')).toEqual([]);
    for (const box of await gone.all()) await box.check();
    await confirm.click();
    await expect(dialog).toContainText('The old file was removed, and the release with English audio is on its way.');

    // Block the Portuguese download, delete the file, grab the English release with the plain body; no blind search.
    const writes = (await arrCalls()).filter((c) => c.method !== 'GET');
    expect(writes.map((c) => `${c.method} ${c.path}`)).toEqual([
      `POST /history/failed/${repairGuideGrabIdFor(LANGUAGE_MISSING_EPISODE_ID)}`,
      'DELETE /episodefile/3006',
      'POST /release',
    ]);
    expect(writes[2]!.body).toEqual({ guid: LANGUAGE_REPLACE_GUID, indexerId: 2 });
  });
});
