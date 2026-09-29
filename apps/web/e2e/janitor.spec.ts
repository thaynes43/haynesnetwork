// ADR-083 / ADR-095 — /admin/janitor (DESIGN-046 D-08, D-17, D-20): one ladder block per family (Sonarr, Radarr and
// Lidarr; books; comics), the *arr grid and the "Books and comics" grid inside ONE form, and the two-step confirm
// on a census→enforce flip of a new cell. The page must fit a phone without sideways page scroll (the grids scroll
// inside their own wrap). Nothing is saved: the spec never writes the shared config.
import { test, expect } from '@playwright/test';
import { measureFit, signIn } from './support/helpers';

test.describe('/admin/janitor (admin)', () => {
  test('ladders per family, the books and comics grid, and the confirm on a new cell', async ({ page }) => {
    await signIn(page, 'admin');
    await page.goto('/admin/janitor');

    for (const family of ['arr', 'books', 'comics']) {
      await expect(page.getByTestId(`janitor-ladder-${family}`)).toBeVisible();
    }
    await expect(page.getByTestId('janitor-ladder-books')).toContainText('Books (LazyLibrarian)');

    const arrGrid = page.getByTestId('janitor-mode-grid');
    await expect(arrGrid.getByRole('columnheader')).toHaveText(['Problem class', 'Sonarr', 'Radarr', 'Lidarr']);
    const suite = page.getByTestId('janitor-mode-grid-suite');
    await expect(suite.getByRole('columnheader')).toHaveText(['Problem class', 'LazyLibrarian', 'Kapowarr']);
    for (const cell of ['lazylibrarian-retry_import', 'lazylibrarian-bad_release', 'lazylibrarian-leftover', 'kapowarr-bad_release']) {
      await expect(page.getByTestId(`janitor-cell-${cell}`)).toHaveText('Census');
    }
    // Kapowarr has no retry or leftover cell; "Keeps failing" is LazyLibrarian's report-only row.
    const keepsFailing = suite.getByRole('row').filter({ hasText: 'Keeps failing' });
    await expect(keepsFailing.getByRole('cell')).toHaveText(['Report only', 'Not used']);

    // Flipping a new cell to enforce swaps Save for the two-step confirm, without moving the grid (ADR-015).
    const leftover = page.getByTestId('janitor-cell-lazylibrarian-leftover');
    await leftover.scrollIntoViewIfNeeded();
    const before = await leftover.boundingBox();
    await leftover.click();
    await expect(leftover).toHaveText('Enforce');
    const after = await leftover.boundingBox();
    expect(after).toEqual(before);
    await expect(page.getByTestId('janitor-save')).toBeEnabled();
    await expect(page.getByRole('status').filter({ hasText: 'Unsaved' })).toBeVisible();
    await leftover.click(); // back to census: nothing to save
    await expect(page.getByTestId('janitor-save')).toBeDisabled();
  });

  test('fits a phone: no sideways page scroll at 390px', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await signIn(page, 'admin');
    await page.goto('/admin/janitor');
    await expect(page.getByTestId('janitor-mode-grid-suite')).toBeVisible();
    const m = await measureFit(page);
    expect(m.pageHScroll, 'no horizontal page scroll at 390').toBeLessThanOrEqual(1);
    expect(m.maxRight, 'nothing wider than the viewport at 390').toBeLessThanOrEqual(m.innerW + 1);
    // Opt-in captures for a visual review (not part of the assertion).
    const shots = process.env.JANITOR_SCREENSHOTS;
    if (shots) {
      await page.getByTestId('janitor-config').screenshot({ path: `${shots}/janitor-config-390.png` });
      await page.setViewportSize({ width: 1280, height: 900 });
      await page.getByTestId('janitor-config').screenshot({ path: `${shots}/janitor-config-1280.png` });
      await page.getByTestId('janitor-summary').screenshot({ path: `${shots}/janitor-summary-1280.png` });
    }
  });
});
