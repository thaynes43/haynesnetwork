// US-06 / AC-07 end to end (DESIGN-005 e2e layer): a member browses /library, opens
// the seeded item, submits a Fix with reason "wrong language", sees the status —
// and the stub *arr recorded the blocklist (history/failed) + search command with
// the right ids. The admin then sees the request in /admin/fixes (R-46).
import { test, expect } from '@playwright/test';
import { signIn, openUserMenu } from './support/helpers';
import { readRuntimeEnv } from './support/env';
import { grabHistoryIdFor, type RecordedArrWrite } from './support/stub-arr';

const TARGET_EPISODE_ID = 50102; // S01E02 · Chapter 2 (seed-ledger.ts / stub-arr.ts)

async function stubArrCalls(): Promise<RecordedArrWrite[]> {
  const env = readRuntimeEnv();
  const res = await fetch(`${env.STUB_ARR_URL}/_stub/calls`);
  if (!res.ok) throw new Error(`stub-arr calls fetch failed: ${res.status}`);
  const body = (await res.json()) as { calls: RecordedArrWrite[] };
  return body.calls;
}

test.describe('media ledger + fix flow', () => {
  test('member browses /library, opens the item, submits a fix (AC-07)', async ({ page }) => {
    await signIn(page, 'member');

    // Topbar nav → /library (desktop viewport keeps the nav visible).
    await page.locator('.topbar__nav').getByRole('link', { name: 'Library' }).click();
    await page.waitForURL('/library');

    // The seeded ledger rows render as horizontal cards with kind + disk badges.
    const card = page.locator('.media-card').filter({ hasText: 'Breaking Prod' });
    await expect(card).toHaveCount(1);
    await expect(card).toContainText('TV');
    await expect(card).toContainText('9/10 on disk');
    await expect(page.locator('.media-card').filter({ hasText: 'The Fixture' })).toHaveCount(1);

    // Search narrows the list.
    await page.getByLabel('Search the library').fill('breaking');
    await expect(page.locator('.media-card')).toHaveCount(1);

    // Item detail: metadata + the seeded history timeline (R-41).
    await card.click();
    await page.waitForURL(/\/library\/[0-9a-f-]{36}$/);
    await expect(page.locator('.detail-head__title')).toContainText('Breaking Prod');
    await expect(page.locator('.detail-head')).toContainText('9/10 on disk');
    await expect(page.locator('.meta-grid')).toContainText('HD-1080p');
    await expect(page.locator('.timeline li').first()).toContainText('Imported');

    // Fix dialog (D-15): pick the episode, pick the reason, submit.
    await page.getByRole('button', { name: 'Fix' }).click();
    const dialog = page.getByRole('dialog', { name: 'Fix Breaking Prod' });
    await expect(dialog).toBeVisible();
    await dialog.getByLabel('Which episode?').selectOption(String(TARGET_EPISODE_ID));
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
});
