// ADR-109 / DESIGN-055 D-01, D-09 (PLAN-077 P1) end to end — the Repair Guide behind Fix, against the stub *arr's
// repair-guide fixtures (POST /_stub/repair-guide):
//   • Case C (AC-42): a Won't play Fix on a movie with no grab history and no recorded play first says the play did not
//     reach our servers, with the Watch-here link; continued, it shows the replacement and refuses to delete it,
//     because the replacement is the same release. Nothing is written to the *arr.
//   • The season guard (AC-40, season half): a season Fix asks which episodes are wrong; the pack that also holds
//     episodes marked fine is left alone, and only the chosen solo download is marked failed.
// The remedies are switched on and off through the admin card on /admin/fixes (every remedy ships off), and the one
// Fix this file opens is closed from /admin/fixes, so no later spec sees the guide or an open fix.
import { test, expect, type Browser, type Page } from '@playwright/test';
import { signIn } from './support/helpers';
import { readRuntimeEnv } from './support/env';
import { repairGuideGrabIdFor, type RecordedArrWrite } from './support/stub-arr';

const REMEDY_LABELS = [
  'Check the replacement before deleting',
  'Season guard',
  'Check the audio before a Wrong language Fix',
  'Check the play before a Won’t play Fix',
];

async function stubArr(path: string, body?: unknown): Promise<Response> {
  const env = readRuntimeEnv();
  const res = await fetch(`${env.STUB_ARR_URL}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`stub-arr ${path} failed: ${res.status}`);
  return res;
}

async function arrCalls(): Promise<RecordedArrWrite[]> {
  const env = readRuntimeEnv();
  const res = await fetch(`${env.STUB_ARR_URL}/_stub/calls`);
  if (!res.ok) throw new Error(`stub-arr calls fetch failed: ${res.status}`);
  return ((await res.json()) as { calls: RecordedArrWrite[] }).calls;
}

/** Reset the stub, then serve the repair-guide fixtures. */
async function stageRepairGuideFixtures(): Promise<void> {
  await stubArr('/_stub/reset');
  await stubArr('/_stub/repair-guide', { on: true });
}

/** Switch every remedy on or off through the admin card (audited, one Save). */
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

async function openTitle(page: Page, tab: 'Movies' | 'TV', title: string): Promise<void> {
  await page.locator('.topbar__nav').getByRole('link', { name: 'Library' }).click();
  await page.waitForURL('/library');
  await page.getByRole('tab', { name: tab }).click();
  await page.locator('.media-card').filter({ hasText: title }).click();
  await page.waitForURL(/\/library\/[0-9a-f-]{36}$/);
  await expect(page.locator('.detail-head__title')).toContainText(title);
}

test.describe.configure({ mode: 'serial' });

test.describe('the Repair Guide (ADR-109 / DESIGN-055, PLAN-077 P1)', () => {
  test.beforeAll(async ({ browser }) => {
    await asAdmin(browser, (page) => setRemedies(page, true));
  });

  test.afterAll(async ({ browser }) => {
    await stubArr('/_stub/reset');
    await asAdmin(browser, async (page) => {
      // Close the season Fix this file opened, then switch every remedy off again.
      await page.goto('/admin/fixes');
      const row = page.locator('.admin-table tbody tr').filter({ hasText: 'Breaking Prod' }).filter({ hasText: 'Season 1' });
      const closeButtons = row.getByRole('button', { name: /Close the open fix/ });
      if ((await closeButtons.count()) > 0) {
        // The two-step ConfirmButton (ADR-014): arm, wait past its double-click guard, confirm.
        await closeButtons.first().click();
        const confirmClose = row.getByRole('button', { name: /Confirm closing the fix/ });
        await expect(confirmClose).toBeVisible();
        await page.waitForTimeout(350);
        await confirmClose.click();
        await expect(row.getByRole('button', { name: /Close the open fix|Confirm closing the fix/ })).toHaveCount(0);
      }
      await setRemedies(page, false);
    });
  });

  test("Case C: the play never reached our servers, and the replacement would be the same release (AC-42)", async ({
    page,
  }) => {
    await stageRepairGuideFixtures();
    await signIn(page, 'member');
    await openTitle(page, 'Movies', 'Stub Runner');

    await page.locator('.detail-head').getByRole('button', { name: 'Fix' }).click();
    const dialog = page.getByRole('dialog', { name: 'Fix Stub Runner' });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole('radio', { name: "It won't play, or it plays with errors" })).toBeChecked();
    await dialog.getByRole('button', { name: 'Next' }).click();

    // Playback Evidence: nothing reached our servers for this person and title.
    await expect(dialog.getByRole('heading', { name: 'Your play didn’t reach our servers.' })).toBeVisible();
    await expect(dialog.getByRole('link', { name: /Watch on HaynesTower/ })).toBeVisible();

    await dialog.getByRole('button', { name: 'I played our copy and it still won’t play' }).click();

    // The Replacement Preview: the release that would replace the file is the same release.
    await expect(dialog.getByRole('heading', { name: 'That would download the same release again.' })).toBeVisible({
      timeout: 30_000,
    });
    await expect(dialog).toContainText('Stub Runner (2020) [WEBDL-1080p]-STUB.mkv');
    await expect(dialog).toContainText('Stub.Runner.2020.1080p.WEB-DL.DDP5.1.H.264-STUB');
    await expect(dialog.getByRole('button', { name: /Delete it/ })).toHaveCount(0);
    await expect(dialog.getByRole('link', { name: 'ticket' })).toBeVisible();

    // Nothing was written to the *arr: no delete, no blocklist, no search.
    expect(await arrCalls()).toEqual([]);
    await dialog.getByRole('button', { name: 'Done' }).click();
    await expect(dialog).toHaveCount(0);
  });

  test('the season guard: a pack that also holds episodes marked fine is left alone (AC-40, season half)', async ({
    page,
  }) => {
    await stageRepairGuideFixtures();
    await signIn(page, 'member');
    await openTitle(page, 'TV', 'Breaking Prod');

    const season1 = page.locator('.season').filter({ hasText: 'Season 1' });
    await season1.locator('.season__actions').getByRole('button', { name: 'Fix' }).click();
    const dialog = page.getByRole('dialog', { name: 'Fix Breaking Prod' });
    await expect(dialog.getByRole('heading', { name: 'Which episodes are wrong?' })).toBeVisible();

    // Nothing is preselected; the pack's episodes say so.
    const e01 = dialog.getByRole('checkbox', { name: /S01E01 · Chapter 1/ });
    await expect(e01).not.toBeChecked();
    await expect(dialog.locator('.repair-guide__episode').filter({ hasText: 'S01E01' })).toContainText('Pack of 3');
    await expect(dialog.getByRole('button', { name: 'Next' })).toBeDisabled();
    await e01.check();
    await dialog.getByRole('checkbox', { name: /S01E05 · Chapter 5/ }).check();
    await dialog.getByRole('button', { name: 'Next' }).click();

    await dialog.getByRole('radio', { name: "It's a different show or movie" }).check();
    await dialog.getByRole('button', { name: 'Next' }).click();

    // The preview: E05's own download is blocked; the pack behind E01 (which also holds E02 and E03) is not.
    await expect(dialog.getByRole('heading', { name: 'Blocked and searched again' })).toBeVisible({ timeout: 30_000 });
    await expect(dialog).toContainText('Breaking.Prod.S01E05.1080p.WEB-DL-STUB');
    const heldBack = dialog.locator('.repair-guide__group').filter({ hasText: 'Left alone: part of a pack' });
    await expect(heldBack).toContainText('S01E01 · Chapter 1 came in a pack that also holds S01E02 · Chapter 2, S01E03 · Chapter 3');

    // Every "gone" line must be ticked before the confirm works; none is pre-ticked.
    const confirm = dialog.getByRole('button', { name: 'Block it and search again' });
    await expect(confirm).toBeDisabled();
    const gone = dialog.locator('.repair-guide__gone').getByRole('checkbox');
    await expect(gone).toHaveCount(1);
    await expect(gone).not.toBeChecked();
    await gone.check();
    await confirm.click();
    await expect(dialog).toContainText('The bad release is blocked and a search for a replacement is running.');

    // Only E05's download was marked failed; the pack's records were never touched.
    const writes = await arrCalls();
    expect(writes.filter((c) => c.path.startsWith('/history/failed/')).map((c) => c.path)).toEqual([
      `/history/failed/${repairGuideGrabIdFor(50105)}`,
    ]);
    expect(writes.filter((c) => c.path === '/command').map((c) => c.body)).toEqual([
      { name: 'EpisodeSearch', episodeIds: [50105] },
    ]);
    expect(writes.some((c) => c.method === 'DELETE')).toBe(false);
  });
});
