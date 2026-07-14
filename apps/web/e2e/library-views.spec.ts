// PLAN-029 (ADR-051/052 / DESIGN-026) end to end — the Library views/grouping + per-view sort &
// filter overhaul:
//   • R2 defaults: Books opens GROUPED-BY-AUTHOR (aggregate cards, D-04); a card DRILLS into the
//     author's flat grid (?group= — a PUSH, D-19) and Back restores the grouped wall.
//   • The view selector: grouped ⇄ flat switches PUSH history entries; the choice persists
//     SERVER-SIDE per user (R1) — a bare reload reopens the last shape — while an explicit
//     shared-link ?view= OVERRIDES for that visit and never overwrites the stored preference.
//   • Registry-driven facets (D-08): audiobook genre/narrator/length chips (the shipped
//     books.filterFacets finally has UI); the ledger walls' Released-range chip; the per-user
//     watch/read chips stay HIDDEN for a viewer with no data (ADR-051 C-06 gate).
//   • R6 sort defaults + remember-last-used; the A–Z jump (?at=) pages the wall (D-09).
//   • The 390×844 portrait pass (selector + group cards + chip row fit — ADR-015).
// Books tabs are admin-only until the owner opens the section (ADR-046 C-04) — these journeys
// sign in as admin. Stub data: e2e/support/stub-books.ts (Kavita: Charlaine Harris ×3, Arthur
// Conan Doyle ×2, Various ×1; ABS: Dickens ×2, Adams, Tolkien) + seed-ledger's two movies.
import { test, expect, type Page } from '@playwright/test';
import { signIn } from './support/helpers';

function groupCard(page: Page, label: string) {
  return page.locator('.group-card').filter({ hasText: label });
}

test.describe('library views + grouping (PLAN-029 / DESIGN-026)', () => {
  test('Books: grouped-by-Author default (R2) → card drill-in → Back restores the grouped wall', async ({
    page,
  }) => {
    await signIn(page, 'admin');
    await page.goto('/library?tab=books');

    // The bare URL canonicalizes (a replace, D-10) to the resolved default shape.
    await expect(page).toHaveURL(/view=grouped/);
    await expect(page.getByTestId('books-groups')).toBeVisible();

    // One aggregate card per author, with the member count (D-04).
    await expect(groupCard(page, 'Charlaine Harris')).toHaveCount(1);
    await expect(groupCard(page, 'Charlaine Harris')).toContainText('3 items');
    await expect(groupCard(page, 'Arthur Conan Doyle')).toContainText('2 items');
    await expect(page.locator('.group-card')).toHaveCount(3);

    // Drill in: the same wall in flat view, pre-filtered to the author (?group= — a PUSH).
    await groupCard(page, 'Charlaine Harris').click();
    await expect(page).toHaveURL(/group=Charlaine(\+|%20)Harris/);
    await expect(page.getByTestId('library-drill')).toContainText('Charlaine Harris');
    await expect(page.getByTestId('books-grid').locator('.poster-card')).toHaveCount(3);
    await expect(page.getByTestId('books-grid')).toContainText("Shakespeare's Landlord");

    // BACK restores the grouped wall (the D-19 crux: the drill-in was a history entry).
    await page.goBack();
    await expect(page).toHaveURL(/view=grouped/);
    await expect(page.getByTestId('books-groups')).toBeVisible();

    // The "All authors" header link also returns up a level (for deep-linked visitors).
    await page.goForward();
    await expect(page.getByTestId('library-drill')).toBeVisible();
    await page.getByRole('link', { name: /All authors/ }).click();
    await expect(page.getByTestId('books-groups')).toBeVisible();
  });

  test('view switch PUSHES + persists server-side (R1); a shared link overrides but never overwrites (ADR-052)', async ({
    page,
  }) => {
    await signIn(page, 'admin');
    await page.goto('/library?tab=books');
    await expect(page.getByTestId('books-groups')).toBeVisible();

    // Switch to the flat "All books" shape — a screen-level PUSH + a stored preference write.
    await page.getByTestId('view-selector').getByRole('button', { name: 'All books' }).click();
    await expect(page).toHaveURL(/view=flat/);
    await expect(page.getByTestId('books-grid').locator('.poster-card')).toHaveCount(6);

    // Back restores the grouped wall; Forward re-applies flat (PLAN-036 history contract).
    await page.goBack();
    await expect(page).toHaveURL(/view=grouped/);
    await expect(page.getByTestId('books-groups')).toBeVisible();
    await page.goForward();
    await expect(page).toHaveURL(/view=flat/);
    await expect(page.getByTestId('books-grid')).toBeVisible();

    // A bare reload reopens the LAST-USED shape (the server-side per-user preference, R1).
    await page.goto('/library?tab=books');
    await expect(page).toHaveURL(/view=flat/);
    await expect(page.getByTestId('books-grid')).toBeVisible();

    // A shared link with an explicit ?view= WINS for that visit (shared-link fidelity)…
    await page.goto('/library?tab=books&view=grouped');
    await expect(page.getByTestId('books-groups')).toBeVisible();

    // …and is NEVER written back over the stored preference (the ADR-052 no-write-back rule).
    await page.goto('/library?tab=books');
    await expect(page).toHaveURL(/view=flat/);
    await expect(page.getByTestId('books-grid')).toBeVisible();
  });

  test('Audiobooks group-card ART (D-04 amendment): author portraits where ABS holds a photo, the fan elsewhere; the Genres glyph wall drills by genre', async ({
    page,
  }) => {
    await signIn(page, 'admin');
    await page.goto('/library?tab=audiobooks&view=grouped');
    await expect(page.getByTestId('books-groups')).toBeVisible();

    // Dickens + Tolkien carry ABS photos (stub imagePath) → the portrait card; Adams has NONE →
    // the stacked-cover fan (the populated-value gate: a card never renders a broken slot).
    await expect(groupCard(page, 'Charles Dickens').locator('.group-card__portrait img')).toHaveCount(1);
    await expect(groupCard(page, 'J. R. R. Tolkien').locator('.group-card__portrait img')).toHaveCount(1);
    await expect(groupCard(page, 'Douglas Adams').locator('.group-card__portrait')).toHaveCount(0);
    await expect(groupCard(page, 'Douglas Adams').locator('.group-card__stack')).toHaveCount(1);

    // The portrait streams through the authed sibling proxy (ADR-019 posture).
    const src = await groupCard(page, 'Charles Dickens')
      .locator('.group-card__portrait img')
      .getAttribute('src');
    expect(src).toContain('/api/books/author-image?id=');

    // The GENRES grouping (the first abstract dimension) — designed glyph tiles, never fake art.
    await page.getByTestId('view-selector').getByRole('button', { name: 'Genres' }).click();
    await expect(page).toHaveURL(/view=grouped/);
    await expect(page).toHaveURL(/by=genre/);
    await expect(groupCard(page, 'Fantasy').locator('.glyph-tile svg')).toHaveCount(1);
    await expect(groupCard(page, 'Classics')).toContainText('2 items');
    await expect(page.locator('.group-card__portrait, .group-card__cover')).toHaveCount(0);

    // Drilling a genre card filters the flat grid by THAT genre; the header climbs back up.
    await groupCard(page, 'Fantasy').click();
    await expect(page).toHaveURL(/group=Fantasy/);
    await expect(page.getByTestId('books-grid').locator('.poster-card')).toHaveCount(1);
    await expect(page.getByTestId('books-grid')).toContainText('The Hobbit');
    await page.getByRole('link', { name: /All genres/ }).click();
    await expect(page.getByTestId('books-groups')).toBeVisible();
    await expect(page).toHaveURL(/by=genre/);
  });

  test('Audiobooks facets (D-08): genre chips narrow; sparse facets gated IN by values; Read gated OUT without progress', async ({
    page,
  }) => {
    await signIn(page, 'admin');
    // Deep-link the flat shape (an explicit URL override — exercises R1 without touching prefs).
    await page.goto('/library?tab=audiobooks&view=flat');
    await expect(page.getByTestId('books-grid').locator('.poster-card')).toHaveCount(4);

    // The shipped books.filterFacets finally has UI: genre + author + the value-gated narrator/
    // series/language chips (ABS carries values for each in the stub) + the Length buckets.
    for (const label of ['Genre', 'Author', 'Narrator', 'Series', 'Language', 'Length']) {
      await expect(page.getByTitle(`Edit the ${label} filter`)).toHaveCount(1);
    }
    // The per-user Read chip is HIDDEN — this viewer has no ABS progress rows (ADR-051 C-06).
    await expect(page.getByTitle('Edit the Read filter')).toHaveCount(0);

    // Genre narrows (server-side, same-field OR).
    await page.getByTitle('Edit the Genre filter').click();
    await page.getByRole('dialog', { name: 'Edit the Genre filter' }).getByLabel('Fantasy').click();
    await expect(page.getByTestId('books-grid').locator('.poster-card')).toHaveCount(1);
    await expect(page.getByTestId('books-grid')).toContainText('The Hobbit');
    await expect(page).toHaveURL(/genre=Fantasy/);
    await page.keyboard.press('Escape');
    await page.getByLabel('Clear the Genre filter').click();
    await expect(page.getByTestId('books-grid').locator('.poster-card')).toHaveCount(4);

    // Length buckets (duration — the D-11 boundaries): "Over 12 h" keeps only Oliver Twist (~17 h).
    await page.getByTitle('Edit the Length filter').click();
    await page.getByRole('dialog', { name: 'Edit the Length filter' }).getByLabel('Over 12 h').click();
    await expect(page.getByTestId('books-grid').locator('.poster-card')).toHaveCount(1);
    await expect(page.getByTestId('books-grid')).toContainText('Oliver Twist');
    await expect(page).toHaveURL(/len=long/);
  });

  test('Movies: R6 recently-added default + remember-last-used; Released range; the A–Z jump; watch chip gated', async ({
    page,
  }) => {
    await signIn(page, 'admin');
    await page.goto('/library?tab=movies');
    await expect(page.locator('.poster-card').filter({ hasText: 'The Fixture' })).toHaveCount(1);

    // R6 — the default sort is Recently Added (desc), newest first.
    const sortbar = page.locator('.library-sortbar');
    await expect(sortbar.getByRole('button', { name: 'Added' })).toHaveClass(/is-active/);

    // The per-user watch chip is hidden — no attributed watch rows for this viewer (C-06 gate).
    await expect(page.getByTitle('Edit the Watched filter')).toHaveCount(0);

    // The Released range chip (D-05/D-08): from 2021 keeps only The Fixture (2022-03-04).
    await page.getByTitle('Edit the Released filter').click();
    await page.getByRole('dialog', { name: 'Edit the Released filter' }).getByLabel('Released from').fill('2021-01-01');
    await expect(page.locator('.poster-card')).toHaveCount(1);
    await expect(page.locator('.poster-card')).toContainText('The Fixture');
    await expect(page).toHaveURL(/rfrom=2021-01-01/);
    await page.keyboard.press('Escape');
    await page.getByLabel('Clear the Released filter').click();
    await expect(page.locator('.poster-card')).toHaveCount(2);

    // The A–Z jump (D-09): armed via ?at=, it PAGES to the first title at the letter; the rail
    // renders while armed and '#' returns to the top. (The size threshold keeps it hidden on this
    // two-item wall otherwise — visibility is unit-tested.)
    await page.goto('/library?tab=movies&sort=title:asc&at=s');
    await expect(page.getByTestId('letter-jump-bar')).toBeVisible();
    await expect(page.locator('.poster-card')).toHaveCount(1);
    await expect(page.locator('.poster-card')).toContainText('Stub Runner');
    await page.getByRole('button', { name: 'Jump to the top' }).click();
    await expect(page.locator('.poster-card')).toHaveCount(2);
    await expect(page).not.toHaveURL(/at=/);

    // R6 remember-last-used: choosing Title (clicked twice → Z–A, an order added_at can't fake)
    // persists server-side; a bare reload keeps BOTH the field and the direction.
    await page.goto('/library?tab=movies');
    await sortbar.getByRole('button', { name: 'Title', exact: true }).click();
    await expect(page).toHaveURL(/sort=title(%3A|:)asc/);
    await sortbar.getByRole('button', { name: 'Title', exact: true }).click();
    await expect(page).toHaveURL(/sort=title(%3A|:)desc/);
    await page.goto('/library?tab=movies');
    await expect(sortbar.getByRole('button', { name: 'Title', exact: true })).toHaveClass(/is-active/);
    await expect(page.locator('.poster-card').first()).toContainText('Stub Runner'); // title Z–A
  });

  test('390×844 portrait: the selector, group cards and chip row fit without horizontal overflow (ADR-015)', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await signIn(page, 'admin');
    await page.goto('/library?tab=books&view=grouped');
    await expect(page.getByTestId('books-groups')).toBeVisible();

    // The view selector renders and fits.
    const seg = (await page.getByTestId('view-selector').boundingBox())!;
    expect(seg.x).toBeGreaterThanOrEqual(0);
    expect(seg.x + seg.width).toBeLessThanOrEqual(390);

    // Group cards ride the same dense 3-column grid (each card well under half the width) and the
    // stacked-cover box reserves the 2:3 space.
    const cards = await page.locator('.group-card').all();
    expect(cards.length).toBeGreaterThan(0);
    const cardBox = (await cards[0]!.boundingBox())!;
    expect(cardBox.width).toBeLessThan(150);
    const stack = (await page.locator('.group-card__stack').first().boundingBox())!;
    expect(stack.height).toBeGreaterThan(stack.width * 1.3);

    // The page never scrolls horizontally (the ADR-015 portrait-safety check).
    const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
    expect(scrollWidth).toBeLessThanOrEqual(390);

    // The flat wall's chip bar stays ONE fixed-height row at 390px too.
    await page.goto('/library?tab=audiobooks&view=flat');
    await expect(page.getByTestId('books-grid')).toBeVisible();
    const bar = (await page.locator('.library-chipbar').boundingBox())!;
    expect(bar.height).toBeLessThanOrEqual(52);
  });
});
