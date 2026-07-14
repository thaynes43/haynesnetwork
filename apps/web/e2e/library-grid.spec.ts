// DESIGN-008 D-10/D-11 end to end: the /library poster-card GRID over the extended
// ledger.search — posters stream through the authed proxy (ADR-019), the facet chip bar +
// sort control (the ported @hnet/ui filter engine) drive the result set through URL-synced
// state (deep-linkable), and NONE of it re-orients the page (ADR-015: the chip bar is a
// fixed-height row, editors overlay, results swap in place). Seeded fixtures
// (support/seed-ledger.ts): Movies = The Fixture (Comedy/Drama, IMDb 7.7, poster 601) +
// Stub Runner (Action/Thriller, IMDb 6.4, poster 602); Music = The Stub Band (NO metadata —
// the KindIcon-fallback + empty-facet path).
import { test, expect, type Page } from '@playwright/test';
import { signIn } from './support/helpers';

async function openMovies(page: Page): Promise<void> {
  await page.goto('/library');
  await expect(page.locator('.poster-card').filter({ hasText: 'The Fixture' })).toHaveCount(1);
}

/** The visible poster-card titles, in DOM (= sort) order. */
async function cardTitles(page: Page): Promise<string[]> {
  const titles = await page.locator('.poster-card .media-card__title').allInnerTexts();
  return titles.map((t) => t.replace(/\s*\(\d{4}\)\s*$/, '').trim());
}

test.describe('library poster grid + filter/sort engine (DESIGN-008 D-10/D-11)', () => {
  test('the grid renders 2:3 poster cards; posters stream via /api/posters/{id}', async ({
    page,
  }) => {
    await signIn(page, 'member');
    await openMovies(page);

    // Both seeded movies render as poster cards. PLAN-029 R6: the default sort is now
    // RECENTLY ADDED (desc) — The Fixture (added 2026-07-01) before Stub Runner (2026-06-15).
    expect(await cardTitles(page)).toEqual(['The Fixture', 'Stub Runner']);

    // The Fixture's poster is the AUTHED proxy route (never an upstream/*arr URL) and it
    // actually loaded (the stub serves a real PNG) — no broken image.
    const fixtureImg = page
      .locator('.poster-card')
      .filter({ hasText: 'The Fixture' })
      .locator('img.poster-img');
    await expect(fixtureImg).toHaveAttribute('src', /^\/api\/posters\/[0-9a-f-]{36}$/);
    await expect(fixtureImg).toHaveJSProperty('complete', true);
    expect(await fixtureImg.evaluate((el: HTMLImageElement) => el.naturalWidth)).toBeGreaterThan(0);

    // The 2:3 box reserves its space (ADR-015): the box is taller than it is wide.
    const box = await page
      .locator('.poster-card')
      .filter({ hasText: 'The Fixture' })
      .locator('.poster-box')
      .boundingBox();
    expect(box).not.toBeNull();
    expect(box!.height).toBeGreaterThan(box!.width * 1.3);

    // The rating badge rides the card (IMDb first), and cards stay ACTION-FREE links.
    await expect(
      page.locator('.poster-card').filter({ hasText: 'The Fixture' }).locator('.badge--rating'),
    ).toHaveText('★ 7.7');
    await expect(page.locator('.media-list button')).toHaveCount(0);
  });

  test('genre chip journey: OR-in a value → results narrow, URL syncs, nothing reflows (ADR-015)', async ({
    page,
  }) => {
    await signIn(page, 'member');
    await openMovies(page);

    // Baseline geometry: the grid's origin and the chip bar's height must NOT move.
    const gridBefore = (await page.locator('.media-list').boundingBox())!;
    const barBefore = (await page.locator('.library-chipbar').boundingBox())!;

    // Open the Genre chip editor — an OVERLAY (the grid must not move while it is open).
    await page.getByTitle('Edit the Genre filter').click();
    const popover = page.getByRole('dialog', { name: 'Edit the Genre filter' });
    await expect(popover).toBeVisible();
    const gridWithPopover = (await page.locator('.media-list').boundingBox())!;
    expect(gridWithPopover.y).toBe(gridBefore.y);

    // The checklist offers the tab-scoped facet values (ledger.filterFacets).
    await expect(popover.getByLabel('Action')).toBeVisible();
    await expect(popover.getByLabel('Comedy')).toBeVisible();

    // Check 'Action' → the result set narrows to Stub Runner and the URL carries the filter.
    // (click + retrying assertion, not .check(): the checkbox is CONTROLLED from the URL, so
    // its state flips after the router.replace round trip, not synchronously on click.)
    await popover.getByLabel('Action').click();
    await expect(popover.getByLabel('Action')).toBeChecked();
    await expect(page.locator('.poster-card')).toHaveCount(1);
    await expect(page.locator('.poster-card')).toContainText('Stub Runner');
    await expect(page).toHaveURL(/genre=Action/);

    // The chip consolidated the value (CSV form) and the bar/grid kept their geometry.
    await page.keyboard.press('Escape');
    await expect(popover).toBeHidden();
    await expect(page.locator('.hnet-filter-chip').filter({ hasText: 'Genre' })).toContainText(
      'Genre · Action',
    );
    const gridAfter = (await page.locator('.media-list').boundingBox())!;
    const barAfter = (await page.locator('.library-chipbar').boundingBox())!;
    expect(gridAfter.y).toBe(gridBefore.y);
    expect(barAfter.height).toBe(barBefore.height);

    // The chip ✕ clears the whole field → both movies return, the URL param drops.
    await page.getByLabel('Clear the Genre filter').click();
    await expect(page.locator('.poster-card')).toHaveCount(2);
    await expect(page).not.toHaveURL(/genre=/);
  });

  test('the bounded rating chip filters by COALESCE(imdb, tmdb) — on every tab', async ({
    page,
  }) => {
    await signIn(page, 'member');
    await openMovies(page);

    // Movies: the Radarr tier fills imdb_rating — ≥ 7 keeps The Fixture (7.7), drops Stub Runner (6.4).
    await page.getByTitle('Edit the Rating filter').click();
    const popover = page.getByRole('dialog', { name: 'Edit the Rating filter' });
    await popover.getByLabel('Minimum rating').selectOption('7');
    await expect(page.locator('.poster-card')).toHaveCount(1);
    await expect(page.locator('.poster-card')).toContainText('The Fixture');
    await expect(page).toHaveURL(/rmin=7/);
    await page.keyboard.press('Escape');
    await expect(page.locator('.hnet-filter-chip').filter({ hasText: 'Rating' })).toContainText(
      'Rating · ≥ 7',
    );

    // TV now offers the SAME chip (superseded the Movies-only rule): Breaking Prod carries only a
    // tmdb_rating (8.2 — the Sonarr community rating, ADR-018 C-07), which COALESCE surfaces.
    await page.getByRole('tab', { name: 'TV' }).click();
    await expect(page.locator('.poster-card').filter({ hasText: 'Breaking Prod' })).toHaveCount(1);
    await expect(page.getByTitle('Edit the Rating filter')).toHaveCount(1);

    // ≥ 8 keeps it (8.2 ≥ 8), proving the filter reads tmdb_rating on TV…
    await page.getByTitle('Edit the Rating filter').click();
    await page.getByRole('dialog', { name: 'Edit the Rating filter' }).getByLabel('Minimum rating').selectOption('8');
    await expect(page.locator('.poster-card')).toHaveCount(1);
    // …and ≥ 9 drops it (8.2 < 9) → the honest empty state, no reflow.
    await page.getByRole('dialog', { name: 'Edit the Rating filter' }).getByLabel('Minimum rating').selectOption('9');
    await expect(page.locator('.poster-card')).toHaveCount(0);
    await expect(page.locator('.empty-state')).toBeVisible();
  });

  test('sort journey: Rating toggles best-first ↔ reversed (two-state, never clears), swapping results without layout jumps', async ({
    page,
  }) => {
    await signIn(page, 'member');
    await openMovies(page);
    const gridBefore = (await page.locator('.media-list').boundingBox())!;

    // First click: best-first (desc) — 7.7 before 6.4 — and the URL carries the wire sort.
    await page.locator('.library-sortbar').getByRole('button', { name: 'Rating' }).click();
    await expect(page).toHaveURL(/sort=imdb_rating%3Adesc|sort=imdb_rating:desc/);
    expect(await cardTitles(page)).toEqual(['The Fixture', 'Stub Runner']);

    // Second click: reversed — the ORDER flips (proof the wire sort drives the grid).
    await page.locator('.library-sortbar').getByRole('button', { name: 'Rating' }).click();
    await expect(page).toHaveURL(/sort=imdb_rating%3Aasc|sort=imdb_rating:asc/);
    await expect(page.locator('.poster-card').first()).toContainText('Stub Runner');
    expect(await cardTitles(page)).toEqual(['Stub Runner', 'The Fixture']);

    // Third click: toggles BACK to best-first (two-state — the header never silently clears the
    // sort); the grid never moved.
    await page.locator('.library-sortbar').getByRole('button', { name: 'Rating' }).click();
    await expect(page).toHaveURL(/sort=imdb_rating%3Adesc|sort=imdb_rating:desc/);
    expect(await cardTitles(page)).toEqual(['The Fixture', 'Stub Runner']);
    const gridAfter = (await page.locator('.media-list').boundingBox())!;
    expect(gridAfter.y).toBe(gridBefore.y);
  });

  test('a deep-linked URL restores filters, sort, and the chip state', async ({ page }) => {
    await signIn(page, 'member');
    await page.goto('/library?tab=movies&genre=Action&sort=imdb_rating%3Aasc');

    await expect(page.locator('.poster-card')).toHaveCount(1);
    await expect(page.locator('.poster-card')).toContainText('Stub Runner');
    await expect(page.locator('.hnet-filter-chip').filter({ hasText: 'Genre' })).toContainText(
      'Genre · Action',
    );
    await expect(
      page.locator('.library-sortbar').getByRole('button', { name: 'Rating' }),
    ).toHaveClass(/is-active/);
  });

  test('switching media tabs resets filters (kept: ?tab) — Movies filters never leak into TV', async ({
    page,
  }) => {
    await signIn(page, 'member');
    await page.goto('/library?tab=movies&genre=Action');
    await expect(page.locator('.poster-card')).toHaveCount(1);

    await page.getByRole('tab', { name: 'TV' }).click();
    await expect(page).toHaveURL(/\/library\?tab=tv$/);
    await expect(page.locator('.poster-card').filter({ hasText: 'Breaking Prod' })).toHaveCount(1);
    await expect(page.locator('.hnet-filter-chip').filter({ hasText: 'Genre' })).not.toContainText(
      'Action',
    );

    // Back on Movies: fresh too (the tab switch dropped the params).
    await page.getByRole('tab', { name: 'Movies' }).click();
    await expect(page.locator('.poster-card')).toHaveCount(2);
  });

  test('the Music tab is unaffected: KindIcon fallback (no metadata), no rating badge, honest empty facets', async ({
    page,
  }) => {
    await signIn(page, 'member');
    await page.goto('/library?tab=music');

    const band = page.locator('.poster-card').filter({ hasText: 'The Stub Band' });
    await expect(band).toHaveCount(1);
    // No harvested poster → the KindIcon fallback fills the reserved box; never a broken <img>.
    await expect(band.locator('.poster-fallback')).toBeVisible();
    await expect(band.locator('img.poster-img')).toHaveCount(0);
    await expect(band.locator('.badge--rating')).toHaveCount(0);

    // Facets are empty for lidarr — the chip says so instead of offering a dead checklist.
    await page.getByTitle('Edit the Genre filter').click();
    await expect(page.getByRole('dialog', { name: 'Edit the Genre filter' })).toContainText(
      'Nothing to filter by yet',
    );
  });

  test('mobile 390×844: 3-column grid, single-row chip bar, viewport-clamped popover', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await signIn(page, 'member');
    await openMovies(page);

    // The two seeded cards share the first row of the dense 3-column grid (same y), split across
    // the width (owner densify 2026-07-06: 3 columns at 390px, was 2).
    const boxes = await Promise.all(
      (await page.locator('.poster-card').all()).map((c) => c.boundingBox()),
    );
    expect(boxes).toHaveLength(2);
    expect(Math.abs(boxes[0]!.y - boxes[1]!.y)).toBeLessThan(2);
    expect(boxes[1]!.x).toBeGreaterThan(boxes[0]!.x + boxes[0]!.width - 2);
    // Three columns at 390px: each card is well under half the viewport width.
    expect(boxes[0]!.width).toBeLessThan(150);

    // The chip bar stays ONE fixed-height row (it pans horizontally; it never wraps/grows).
    const bar = (await page.locator('.library-chipbar').boundingBox())!;
    expect(bar.height).toBeLessThanOrEqual(52);

    // A chip editor OVERLAYS and fits the viewport (the Collection chip sits far right —
    // the worst clamping case; scroll it into view, open, and measure).
    await page.getByTitle('Edit the Collection filter').scrollIntoViewIfNeeded();
    await page.getByTitle('Edit the Collection filter').click();
    const popover = page.getByRole('dialog', { name: 'Edit the Collection filter' });
    await expect(popover).toBeVisible();
    const pop = (await popover.boundingBox())!;
    expect(pop.x).toBeGreaterThanOrEqual(0);
    expect(pop.x + pop.width).toBeLessThanOrEqual(390);
    expect(pop.y + pop.height).toBeLessThanOrEqual(844);
  });
});
