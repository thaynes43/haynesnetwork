// PLAN-047 / ADR-058 / DESIGN-004 D-21 — THE DRIFT GATE for the shared card family. The
// /e2e/card-gallery harness page renders EVERY card variant in every state over pure fixtures;
// this spec asserts the STRUCTURE of each one — the anatomy contract the PLAN-045 "Wanted strip"
// incident violated:
//
//   • one reserved art box per card (2:3 — geometry asserted), nothing stacked around it;
//   • one caption block: one title line, ≤ one subtitle line, ONE badge row of ≤ MAX_CARD_BADGES;
//   • corner pucks ONLY in the reserved corners (state top-right, lib-nav top-left);
//   • NO buttons/links bolted onto a card face (the only button is the Trash corner-toggle
//     surface, and the whole card is otherwise a single link).
//
// A card that drifts (an extra badge row, a stray button, a second caption line…) FAILS here.
// Full-page screenshot artifacts (dark + light, desktop + 390) are ALWAYS emitted — they are the
// standing visual reference the coordinator diffs before deploy.
import { test, expect, type Locator, type Page } from '@playwright/test';

async function openGallery(page: Page, theme: 'hnet-dark' | 'hnet-light'): Promise<void> {
  // Drive the theme through the pre-hydration init script's `prefers-color-scheme` branch
  // (fresh contexts carry no stored theme) — no localStorage/reload round trip to race.
  await page.emulateMedia({ colorScheme: theme === 'hnet-dark' ? 'dark' : 'light' });
  await page.goto('/e2e/card-gallery');
  await page.locator(`html[data-theme="${theme}"]`).waitFor();
  await expect(page.getByTestId('card-gallery')).toBeVisible();
}

/** Assert one poster-idiom card's anatomy (MediaCard/BookCard/GroupCard/RequestCard). */
async function expectPosterCardAnatomy(card: Locator): Promise<void> {
  // Exactly ONE reserved art box (a poster box or the glyph tile — never both, never none).
  await expect(card.locator('.poster-box, .glyph-tile')).toHaveCount(1);
  // Exactly one caption body with exactly one title line and at most one subtitle.
  await expect(card.locator('.poster-card__body')).toHaveCount(1);
  await expect(card.locator('.media-card__title')).toHaveCount(1);
  expect(await card.locator('.media-card__subtitle').count()).toBeLessThanOrEqual(1);
  // ONE badge row, hard-capped at 3 badges (MAX_CARD_BADGES).
  const badgeRows = await card.locator('.media-card__badges').count();
  expect(badgeRows).toBeLessThanOrEqual(1);
  expect(await card.locator('.media-card__badges .badge').count()).toBeLessThanOrEqual(3);
  // NO interactive elements on the card face (the card itself is the only link).
  await expect(card.locator('button')).toHaveCount(0);
  await expect(card.locator('a')).toHaveCount(0);
}

test.describe('card gallery — the shared-card-system drift gate (ADR-058)', () => {
  test('every poster-idiom card variant keeps the canonical anatomy', async ({ page }) => {
    await openGallery(page, 'hnet-dark');

    for (const section of [
      'gallery-media',
      'gallery-books',
      'gallery-groups',
      'gallery-requests',
      'gallery-activity',
    ]) {
      const cards = page.getByTestId(section).locator('.poster-card');
      const count = await cards.count();
      expect(count, `${section} renders cards`).toBeGreaterThan(2);
      for (let i = 0; i < count; i++) {
        await expectPosterCardAnatomy(cards.nth(i));
      }
    }

    // The 2:3 box reserves its space (ADR-015): sample one card per grid.
    for (const section of ['gallery-media', 'gallery-books', 'gallery-groups']) {
      const box = await page
        .getByTestId(section)
        .locator('.poster-box, .glyph-tile')
        .first()
        .boundingBox();
      expect(box).not.toBeNull();
      expect(box!.height).toBeGreaterThan(box!.width * 1.3);
      expect(box!.height).toBeLessThan(box!.width * 1.7);
    }

    // Grid rows align: the first row of the media grid shares a y origin.
    const boxes = await Promise.all(
      (await page.getByTestId('gallery-media').locator('.poster-card').all()).map((c) =>
        c.boundingBox(),
      ),
    );
    expect(Math.abs(boxes[0]!.y - boxes[1]!.y)).toBeLessThan(2);

    // The pre-mint RequestCard is a non-interactive <div>; every other request card is a link.
    const requests = page.getByTestId('gallery-requests').locator('.poster-card');
    await expect(requests.filter({ hasText: 'Pre-mint Want' })).toHaveCount(1);
    expect(
      await requests
        .filter({ hasText: 'Pre-mint Want' })
        .evaluateAll((els) => els.map((el) => el.tagName)),
    ).toEqual(['DIV']);
    expect(
      await requests
        .filter({ hasText: 'Searching' })
        .evaluateAll((els) => els.map((el) => el.tagName)),
    ).toEqual(['A']);
  });

  test('activity tiles carry the in-flight stage badge (+ failure class) in the ONE badge row', async ({
    page,
  }) => {
    // PLAN-048 / ADR-059 D-03/D-05 — the in-flight signal is a caption BADGE (never a new poster
    // anatomy): each ActivityCard has exactly the shared caption + a ≤3 badge row leading with the stage.
    await openGallery(page, 'hnet-dark');
    const cards = page.getByTestId('gallery-activity').locator('.poster-card');
    await expect(cards).toHaveCount(5);
    // The failed tile carries TWO badges (stage "Stuck" + failure class), both in the ONE badge row.
    const failed = page.getByTestId('activity-failed');
    await expect(failed.locator('.media-card__badges')).toHaveCount(1);
    await expect(failed.locator('.media-card__badges .badge')).toHaveCount(2);
    await expect(failed.locator('.badge--danger')).toHaveCount(2);
    // The wall in-flight prop lands as the leading badge on a real MediaCard/BookCard too.
    await expect(
      page.getByTestId('gallery-media').locator('.poster-card', { hasText: 'Grabbing Now' }).locator('.badge--info'),
    ).toHaveCount(1);

    // PLAN-048 D-10 — the LIVE badge state (the Fix feel): a downloading badge carries the filling mini-meter
    // + the pulsing dot INSIDE the one badge (still one `.badge`, no new anatomy). Locked here so it can't drift.
    const downloading = page
      .getByTestId('gallery-activity')
      .locator('.poster-card', { hasText: 'Downloading Now' });
    await expect(downloading.locator('.media-card__badges .badge')).toHaveCount(1);
    await expect(downloading.locator('.badge--live .badge__fill')).toHaveCount(1);
    await expect(downloading.locator('.badge--pulse .badge__dot')).toHaveCount(1);
    // A searching tile pulses (alive) but has no determinate meter fill.
    const searching = page
      .getByTestId('gallery-activity')
      .locator('.poster-card', { hasText: 'Searching For This' });
    await expect(searching.locator('.badge--pulse .badge__dot')).toHaveCount(1);
    await expect(searching.locator('.badge__fill')).toHaveCount(0);
  });

  test('ticket tiles keep the twall anatomy (state puck + caption/sub + ONE meta row)', async ({
    page,
  }) => {
    await openGallery(page, 'hnet-dark');
    const tiles = page.getByTestId('gallery-tickets').locator('.twall-tile');
    await expect(tiles).toHaveCount(4);
    for (let i = 0; i < 4; i++) {
      const tile = tiles.nth(i);
      // One link wrapping the whole tile; one poster surface with exactly one corner puck.
      await expect(tile.locator('a.twall-link')).toHaveCount(1);
      await expect(tile.locator('.twall-poster')).toHaveCount(1);
      await expect(tile.locator('.twall-overlay')).toHaveCount(1);
      // Poster XOR category tile fills the art box.
      const hasPoster = (await tile.locator('.twall-poster .poster-box').count()) === 1;
      expect(hasPoster, 'the 2:3 art box is present').toBe(true);
      // Fixed caption grammar: one caption, one sub, one meta row with exactly one status badge.
      await expect(tile.locator('.twall-caption')).toHaveCount(1);
      await expect(tile.locator('.twall-sub')).toHaveCount(1);
      await expect(tile.locator('.twall-meta')).toHaveCount(1);
      await expect(tile.locator('.twall-meta .badge')).toHaveCount(1);
      await expect(tile.locator('button')).toHaveCount(0);
    }
    // The state puck carries the state (recolor-only semantics ride data-status).
    await expect(tiles.nth(0)).toHaveAttribute('data-status', 'open');
    await expect(tiles.nth(3)).toHaveAttribute('data-status', 'rejected');
    // The category tile renders for the non-media ticket, a poster for the linked one.
    await expect(tiles.nth(1).locator('.twall-cattile')).toHaveCount(1);
    await expect(tiles.nth(0).locator('.twall-cattile')).toHaveCount(0);
  });

  test('trash tiles keep the bwall anatomy (corner toggle + lib-link + meta chips)', async ({
    page,
  }) => {
    await openGallery(page, 'hnet-dark');
    const tiles = page.getByTestId('gallery-trash').locator('.bwall-tile');
    await expect(tiles).toHaveCount(5);
    for (let i = 0; i < 5; i++) {
      const tile = tiles.nth(i);
      // ONE tap surface holding the poster + exactly one state puck.
      await expect(tile.locator('.bwall-tap')).toHaveCount(1);
      await expect(tile.locator('.bwall-overlay')).toHaveCount(1);
      await expect(tile.locator('.poster-box')).toHaveCount(1);
      // At most one lib-nav corner; fixed caption + ONE meta row.
      expect(await tile.locator('.pwall-corner').count()).toBeLessThanOrEqual(1);
      await expect(tile.locator('.bwall-caption')).toHaveCount(1);
      await expect(tile.locator('.bwall-meta')).toHaveCount(1);
      // The meta chips are the ONLY sanctioned extras (person/eye) — never buttons.
      expect(await tile.locator('.bwall-meta button, .bwall-meta a').count()).toBe(0);
    }
    // Interactivity contract: tappable states are <button>, terminal/inert states are spans.
    await expect(tiles.nth(0).locator('button.bwall-tap')).toHaveCount(1); // trash — saveable
    await expect(tiles.nth(1).locator('button.bwall-tap')).toHaveCount(1); // shield — un-saveable
    await expect(tiles.nth(2).locator('button.bwall-tap')).toHaveCount(0); // check — inert
    await expect(tiles.nth(4).locator('button.bwall-tap')).toHaveCount(0); // gone — terminal
    // State rides data-glyph (recolor-only, ADR-015).
    await expect(tiles.nth(1)).toHaveAttribute('data-glyph', 'shield');
    await expect(tiles.nth(4)).toHaveAttribute('data-glyph', 'gone');
    // The pending tiles carry the lib-nav corner where ledger-joined.
    await expect(tiles.nth(0).locator('.pwall-corner')).toHaveCount(1);
  });

  test('skeletons hold the grid geometry', async ({ page }) => {
    await openGallery(page, 'hnet-dark');
    await expect(
      page.getByTestId('gallery-poster-skeleton').locator('.poster-card--skeleton'),
    ).toHaveCount(4);
    await expect(page.getByTestId('gallery-trash-skeleton').locator('.bwall-tile')).toHaveCount(4);
    const box = await page
      .getByTestId('gallery-poster-skeleton')
      .locator('.poster-box')
      .first()
      .boundingBox();
    expect(box!.height).toBeGreaterThan(box!.width * 1.3);
  });

  test('reference captures — dark/light × desktop/390 (the standing artifact)', async ({
    browser,
  }, testInfo) => {
    // Four theme/viewport combos with full-page shots — give the matrix its own budget, and a
    // FRESH context per combo (the proven capture-harness pattern; a reused page can wedge on the
    // second theme swap).
    testInfo.setTimeout(180_000);
    for (const [label, viewport] of [
      ['desktop', { width: 1280, height: 900 }],
      ['390', { width: 390, height: 844 }],
    ] as const) {
      for (const theme of ['hnet-dark', 'hnet-light'] as const) {
        const context = await browser.newContext({ viewport, baseURL: testInfo.project.use.baseURL });
        const page = await context.newPage();
        await openGallery(page, theme);
        // Hide the Next dev overlay badge — the captures are the standing reference artifact.
        await page.addStyleTag({ content: 'nextjs-portal { display: none !important; }' });
        const t = theme === 'hnet-dark' ? 'dark' : 'light';
        const path = testInfo.outputPath(`card-gallery-${label}-${t}.png`);
        await page.screenshot({ path, fullPage: true });
        await testInfo.attach(`card-gallery-${label}-${t}`, { path, contentType: 'image/png' });
        await context.close();
      }
    }
  });
});
