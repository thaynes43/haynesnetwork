// PLAN-036 / DESIGN-004 D-19 — the history-navigation contract: browser Back/Forward behave
// like SCREEN navigation. A screen-level view switch (a Library kind tab, a Bulletin Feed/
// Messages tab, a Metrics sub-tab, a Trash tab, …) is a router.push, so it mints a history
// entry — Back restores the PRIOR tab WITH whatever URL-synced filter state that tab carried,
// Forward re-applies. Refinements (filter chips / sort / search text / pagination cursors) stay
// router.replace (no history spam) — that D-09 semantics is unchanged except the tab dimension.
//
// Pre-fix (recon 2026-07-11) every tab switch used router.replace, so switching tabs REWROTE the
// current entry: Back skipped past the app screen entirely (the assertions below fail on that
// build — they document the defect — and pass once the tab switches push). Scroll behaviour on a
// tab switch is unchanged (the push keeps `{ scroll: false }`); deep links keep working.
import { test, expect, type Page } from '@playwright/test';
import { signIn } from './support/helpers';

/** A tab's accessible name is substring-matched, so a count badge (Trash) never breaks this. */
function tab(page: Page, name: string) {
  return page.getByRole('tab', { name });
}

test.describe('history-navigation contract (PLAN-036 / DESIGN-004 D-19)', () => {
  test('Library: TV→Movies→Back⇒TV (filter state intact)→Forward⇒Movies', async ({ page }) => {
    // admin is unrestricted (ADR-024), so every media tab (Movies/TV/Music) renders without
    // depending on any role→library grant setup — the tab-history contract is what's under test.
    await signIn(page, 'admin');

    // Land on TV carrying a URL-synced filter (Breaking Prod is genre Drama in the seed). This is
    // the state a real filter edit leaves behind (a replace-in-place within the TV history entry).
    await page.goto('/library?tab=tv&genre=Drama');
    await expect(tab(page, 'TV')).toHaveAttribute('aria-selected', 'true');
    await expect(page.locator('.poster-card').filter({ hasText: 'Breaking Prod' })).toHaveCount(1);
    await expect(page.locator('.hnet-filter-chip').filter({ hasText: 'Genre' })).toContainText(
      'Genre · Drama',
    );

    // Switch to Movies — a SCREEN switch: it pushes a fresh `?tab=movies` (filters dropped, D-11).
    await tab(page, 'Movies').click();
    await expect(page).toHaveURL(/\/library\?tab=movies$/);
    await expect(page.locator('.poster-card').filter({ hasText: 'The Fixture' })).toHaveCount(1);

    // BACK restores the prior tab (TV) WITH its filter state — the crux of the contract. On the
    // pre-fix (replace) build Back left /library entirely and this URL assertion failed.
    await page.goBack();
    await expect(page).toHaveURL(/\/library\?tab=tv&genre=Drama$/);
    await expect(tab(page, 'TV')).toHaveAttribute('aria-selected', 'true');
    await expect(page.locator('.poster-card').filter({ hasText: 'Breaking Prod' })).toHaveCount(1);
    await expect(page.locator('.hnet-filter-chip').filter({ hasText: 'Genre' })).toContainText(
      'Genre · Drama',
    );

    // FORWARD re-applies Movies.
    await page.goForward();
    await expect(page).toHaveURL(/\/library\?tab=movies$/);
    await expect(page.locator('.poster-card').filter({ hasText: 'The Fixture' })).toHaveCount(1);
    await expect(tab(page, 'Movies')).toHaveAttribute('aria-selected', 'true');
  });

  test('Bulletin: Feed→Tickets→Back⇒Feed', async ({ page }) => {
    await signIn(page, 'admin'); // admin sees both Feed + Tickets sub-views
    await page.goto('/bulletin?tab=feed');
    await expect(tab(page, 'Feed')).toHaveAttribute('aria-selected', 'true');

    // DESIGN-004 D-22 — the lead sub-tab reads "Tickets" (HELPDESK_NAME); its tab key stays
    // `helpdesk`, so the pushed URL is ?tab=helpdesk.
    await tab(page, 'Tickets').click();
    await expect(page).toHaveURL(/\/bulletin\?tab=helpdesk$/);
    await expect(tab(page, 'Tickets')).toHaveAttribute('aria-selected', 'true');

    await page.goBack();
    await expect(page).toHaveURL(/\/bulletin\?tab=feed$/);
    await expect(tab(page, 'Feed')).toHaveAttribute('aria-selected', 'true');
  });

  test('Metrics: Overview→Apps→Back⇒Overview', async ({ page }) => {
    await signIn(page, 'admin');
    await page.goto('/metrics'); // normalize effect (a replace) canonicalizes to ?tab=overview
    await expect(page).toHaveURL(/\/metrics\?tab=overview$/);
    await expect(tab(page, 'Overview')).toHaveAttribute('aria-selected', 'true');

    await tab(page, 'Apps').click();
    await expect(page).toHaveURL(/\/metrics\?tab=apps$/);
    await expect(tab(page, 'Apps')).toHaveAttribute('aria-selected', 'true');

    await page.goBack();
    await expect(page).toHaveURL(/\/metrics\?tab=overview$/);
    await expect(tab(page, 'Overview')).toHaveAttribute('aria-selected', 'true');
  });

  test('Trash: Movies→TV→Back⇒Movies', async ({ page }) => {
    await signIn(page, 'admin');
    await page.goto('/trash?tab=movies');
    await expect(tab(page, 'Movies')).toHaveAttribute('aria-selected', 'true');

    await tab(page, 'TV').click();
    await expect(page).toHaveURL(/\/trash\?tab=tv$/);
    await expect(tab(page, 'TV')).toHaveAttribute('aria-selected', 'true');

    await page.goBack();
    await expect(page).toHaveURL(/\/trash\?tab=movies$/);
    await expect(tab(page, 'Movies')).toHaveAttribute('aria-selected', 'true');
  });
});
