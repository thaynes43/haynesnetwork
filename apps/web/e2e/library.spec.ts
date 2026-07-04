// US-06 / AC-07 + DESIGN-005 D-15/D-17 end to end: a member browses /library, opens
// the seeded item, and works PER EPISODE (inside collapsible SEASON sections) — Fix on
// an on-disk episode (blocklist + search), Force Search on a missing one (search ONLY),
// and a season roll-up Force Search (SeasonSearch). The admin then sees the fix in
// /admin/fixes (R-46). Also guards the Modal focus-steal regression: the Other-reason
// textarea must keep focus across keystrokes.
import { test, expect, type Page } from '@playwright/test';
import { signIn, openUserMenu } from './support/helpers';
import { readRuntimeEnv } from './support/env';
import { grabHistoryIdFor, STUB_SERIES_ID, type RecordedArrWrite } from './support/stub-arr';

const TARGET_EPISODE_ID = 50102; // S01E02 · Chapter 2 (on disk) — the Fix target.
const MISSING_EPISODE_ID = 50110; // S01E10 · Chapter 10 (E10 missing) — the Force Search target.

/** Episodes live inside collapsible season sections; open one to reach its rows. */
async function expandSeason(page: Page, name: string) {
  const season = page.locator('.season').filter({ hasText: name });
  await season.locator('.season__title').click();
  await expect(season).toHaveJSProperty('open', true);
  return season;
}

async function stubArrCalls(): Promise<RecordedArrWrite[]> {
  const env = readRuntimeEnv();
  const res = await fetch(`${env.STUB_ARR_URL}/_stub/calls`);
  if (!res.ok) throw new Error(`stub-arr calls fetch failed: ${res.status}`);
  const body = (await res.json()) as { calls: RecordedArrWrite[] };
  return body.calls;
}

async function resetStubArrCalls(): Promise<void> {
  const env = readRuntimeEnv();
  const res = await fetch(`${env.STUB_ARR_URL}/_stub/reset`, { method: 'POST' });
  if (!res.ok) throw new Error(`stub-arr reset failed: ${res.status}`);
}

async function openSeededItem(page: import('@playwright/test').Page): Promise<void> {
  await page.locator('.topbar__nav').getByRole('link', { name: 'Library' }).click();
  await page.waitForURL('/library');
  const card = page.locator('.media-card').filter({ hasText: 'Breaking Prod' });
  await expect(card).toHaveCount(1);
  await card.click();
  await page.waitForURL(/\/library\/[0-9a-f-]{36}$/);
  await expect(page.locator('.detail-head__title')).toContainText('Breaking Prod');
}

test.describe('media ledger + fix flow', () => {
  test('member browses /library, opens the item, fixes a single episode (AC-07)', async ({
    page,
  }) => {
    await signIn(page, 'member');

    // Library list still shows the seeded rows with kind + disk badges.
    await page.locator('.topbar__nav').getByRole('link', { name: 'Library' }).click();
    await page.waitForURL('/library');
    const card = page.locator('.media-card').filter({ hasText: 'Breaking Prod' });
    await expect(card).toContainText('TV');
    await expect(card).toContainText('9/10 on disk');
    await expect(page.locator('.media-card').filter({ hasText: 'The Fixture' })).toHaveCount(1);

    // Search narrows the list.
    await page.getByLabel('Search the library').fill('breaking');
    await expect(page.locator('.media-card')).toHaveCount(1);

    // Item detail: metadata + the seeded history timeline (R-41) + the live episode list.
    await card.click();
    await page.waitForURL(/\/library\/[0-9a-f-]{36}$/);
    await expect(page.locator('.detail-head')).toContainText('9/10 on disk');
    await expect(page.locator('.meta-grid')).toContainText('HD-1080p');
    await expect(page.locator('.timeline li').first()).toContainText('Imported');

    // Episodes are grouped into collapsible seasons; the header shows on-disk/total and
    // a whole-show Force Search sits above them (roll-up). Expand Season 1 to reach it.
    const season1 = page.locator('.season').filter({ hasText: 'Season 1' });
    await expect(season1).toContainText('9/10 on disk');
    await expect(page.getByRole('button', { name: 'Force Search show' })).toBeVisible();
    await expandSeason(page, 'Season 1');

    // The episode list shows per-episode on-disk state (D-06). E2 is on disk → Fix;
    // E10 is missing → Force Search (owner feedback: episode-level, not show-level).
    const onDiskRow = page.locator('.child-row').filter({ hasText: 'S01E02 · Chapter 2' });
    await expect(onDiskRow).toContainText('On disk');
    const missingRow = page.locator('.child-row').filter({ hasText: 'S01E10 · Chapter 10' });
    await expect(missingRow).toContainText('Missing');
    await expect(missingRow.getByRole('button', { name: 'Force Search' })).toBeVisible();

    // Fix that specific episode: the dialog carries the chosen episode (no picker).
    await onDiskRow.getByRole('button', { name: 'Fix' }).click();
    const dialog = page.getByRole('dialog', { name: 'Fix Breaking Prod' });
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText('S01E02 · Chapter 2');
    await dialog.getByRole('radio', { name: 'Wrong language' }).check();
    await dialog.getByRole('button', { name: 'Submit fix' }).click();

    // Status feedback: blocklist path confirmed to the user.
    await expect(dialog).toContainText('blocklisted', { timeout: 15_000 });
    await expect(dialog).toContainText('S01E02 · Chapter 2');
    await dialog.getByRole('button', { name: 'Done' }).click();

    // The item page now shows the fix with its lifecycle status (R-46).
    await expect(page.locator('.fix-list__row')).toContainText('Search triggered');
    await expect(page.locator('.fix-list__row')).toContainText('Wrong language');

    // AC-07 proof: the stub *arr recorded mark-failed for the RIGHT grab record,
    // then the EpisodeSearch command for the RIGHT episode.
    const calls = await stubArrCalls();
    const failed = calls.filter((c) => c.path.startsWith('/history/failed/'));
    expect(failed).toHaveLength(1);
    expect(failed[0]!.path).toBe(`/history/failed/${grabHistoryIdFor(TARGET_EPISODE_ID)}`);
    const commands = calls.filter((c) => c.path === '/command');
    expect(commands).toHaveLength(1);
    expect(commands[0]!.body).toEqual({ name: 'EpisodeSearch', episodeIds: [TARGET_EPISODE_ID] });
  });

  test('member sees the fix under My fixes with its status', async ({ page }) => {
    await signIn(page, 'member');
    await openUserMenu(page);
    await page.getByRole('menuitem', { name: 'My fixes' }).click();
    await page.waitForURL('/my-fixes');

    const row = page.locator('.admin-table tbody tr').filter({ hasText: 'Breaking Prod' });
    await expect(row).toHaveCount(1);
    await expect(row).toContainText('S01E02 · Chapter 2');
    await expect(row).toContainText('Wrong language');
    await expect(row).toContainText('Search triggered');
  });

  test('admin sees the request in /admin/fixes with requester and actions (R-46)', async ({
    page,
  }) => {
    await signIn(page, 'admin');
    await page.goto('/admin/fixes');

    const row = page.locator('.admin-table tbody tr').filter({ hasText: 'Breaking Prod' });
    await expect(row).toHaveCount(1);
    await expect(row).toContainText('Marge Member');
    await expect(row).toContainText('Wrong language');
    await expect(row).toContainText('Search triggered');
    await expect(row).toContainText('blocklist+search');

    // The raw *arr actions (AC-07's recorded responses) are one disclosure away.
    await row.locator('.actions-details summary').click();
    await expect(row.locator('.actions-json')).toContainText('mark_failed');
    await expect(row.locator('.actions-json')).toContainText(
      `/history/failed/${grabHistoryIdFor(TARGET_EPISODE_ID)}`,
    );
  });

  test('Force Search on a missing episode searches ONLY — no blocklist (D-17)', async ({
    page,
  }) => {
    await signIn(page, 'member');
    await openSeededItem(page);
    await expandSeason(page, 'Season 1');

    // Isolate this action's recorded *arr writes.
    await resetStubArrCalls();

    const missingRow = page.locator('.child-row').filter({ hasText: 'S01E10 · Chapter 10' });
    await expect(missingRow).toContainText('Missing');
    await missingRow.getByRole('button', { name: 'Force Search' }).click();

    // Single confirm — no reason taxonomy for missing content.
    const dialog = page.getByRole('dialog', { name: 'Force search Breaking Prod' });
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText('S01E10 · Chapter 10');
    await dialog.getByRole('button', { name: 'Force search' }).click();
    await expect(dialog).toContainText('search is running', { timeout: 15_000 });
    await dialog.getByRole('button', { name: 'Done' }).click();

    // D-17 proof: EpisodeSearch fired for the missing episode, and NOTHING was
    // blocklisted (no history/failed) or deleted — it is missing, not broken.
    const calls = await stubArrCalls();
    expect(calls.filter((c) => c.path.startsWith('/history/failed/'))).toHaveLength(0);
    expect(calls.filter((c) => c.method === 'DELETE')).toHaveLength(0);
    const commands = calls.filter((c) => c.path === '/command');
    expect(commands).toHaveLength(1);
    expect(commands[0]!.body).toEqual({ name: 'EpisodeSearch', episodeIds: [MISSING_EPISODE_ID] });
  });

  test('Force Search a whole season fires SeasonSearch (roll-up) with no blocklist', async ({
    page,
  }) => {
    await signIn(page, 'member');
    await openSeededItem(page);
    await resetStubArrCalls();

    // The season header carries a Force Search without expanding the episode list.
    const season2 = page.locator('.season').filter({ hasText: 'Season 2' });
    await expect(season2).toContainText('1/2 on disk');
    await season2.locator('.season__head').getByRole('button', { name: 'Force Search' }).click();

    const dialog = page.getByRole('dialog', { name: 'Force search Breaking Prod' });
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText('Season 2');
    await dialog.getByRole('button', { name: 'Force search' }).click();
    await expect(dialog).toContainText('search is running', { timeout: 15_000 });
    await dialog.getByRole('button', { name: 'Done' }).click();

    // SeasonSearch fired for the whole season with the right payload; nothing blocklisted.
    const calls = await stubArrCalls();
    expect(calls.filter((c) => c.path.startsWith('/history/failed/'))).toHaveLength(0);
    expect(calls.filter((c) => c.method === 'DELETE')).toHaveLength(0);
    const commands = calls.filter((c) => c.path === '/command');
    expect(commands).toHaveLength(1);
    expect(commands[0]!.body).toEqual({
      name: 'SeasonSearch',
      seriesId: STUB_SERIES_ID,
      seasonNumber: 2,
    });
  });

  test('a season can be expanded to reveal its episodes', async ({ page }) => {
    await signIn(page, 'member');
    await openSeededItem(page);

    // Collapsed by default: the episode rows are in the DOM but hidden until it opens.
    const season2 = page.locator('.season').filter({ hasText: 'Season 2' });
    await expect(season2.locator('.child-row').first()).toBeHidden();
    await expandSeason(page, 'Season 2');
    await expect(season2.locator('.child-row').filter({ hasText: 'S02E01 · Return' })).toBeVisible();
    await expect(
      season2.locator('.child-row').filter({ hasText: 'S02E02 · Reckoning' }),
    ).toContainText('Missing');
  });

  test('the Other-reason textarea keeps focus across keystrokes (Modal remount regression)', async ({
    page,
  }) => {
    await signIn(page, 'member');
    await openSeededItem(page);
    await expandSeason(page, 'Season 1');

    // Open a Fix for an on-disk episode and pick the free-text "Other" reason.
    const row = page.locator('.child-row').filter({ hasText: 'S01E03 · Chapter 3' });
    await row.getByRole('button', { name: 'Fix' }).click();
    const dialog = page.getByRole('dialog', { name: 'Fix Breaking Prod' });
    await dialog.getByRole('radio', { name: 'Other' }).check();

    // Type MANY characters one at a time: the pre-fix bug re-ran the Modal focus
    // effect on every keystroke and stole focus back to the dialog after char one.
    const textarea = dialog.getByRole('textbox');
    await textarea.click();
    const typed = 'the audio track is out of sync with the video';
    await textarea.pressSequentially(typed, { delay: 15 });
    await expect(textarea).toHaveValue(typed);
  });
});
