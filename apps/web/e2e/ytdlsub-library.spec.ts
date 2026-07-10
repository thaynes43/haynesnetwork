// PLAN-022 / ADR-038 / DESIGN-017 — the ytdl-sub Library sub-tabs (Peloton, YouTube). ADVISORY spec.
// The tabs are gated by the `ytdlsub` Section Permission, which defaults to `disabled` (ships Admin-only),
// so a fresh member sees the standard Library tabs only, while an admin (implies `edit` on every section)
// sees Peloton + YouTube and their poster grids read DIRECTLY from stub-plex's k8plex libraries
// (`HOps Peloton` key 4, `HOps YT` key 5) via ytdlsub.list. Posters round-trip through the authed
// /api/ytdlsub/poster proxy (stub-plex serves a tiny PNG for any /library/…/thumb/… path).
import { test, expect, type Page } from '@playwright/test';
import { signIn } from './support/helpers';

async function openLibrary(page: Page): Promise<void> {
  await page.goto('/library');
  await expect(page.getByRole('tablist', { name: 'Library sections' })).toBeVisible();
}

test.describe('ytdl-sub Library sub-tabs (PLAN-022 · ADR-038 · DESIGN-017)', () => {
  test.describe.configure({ mode: 'serial' });

  // AC (R-122): the `ytdlsub` section ships `disabled`, so a fresh member sees NO Peloton/YouTube tabs.
  test('a default member does not see the Peloton/YouTube sub-tabs', async ({ page }) => {
    await signIn(page, 'fresh-member');
    await openLibrary(page);
    await expect(page.getByRole('tab', { name: 'Movies' })).toBeVisible(); // standard tabs still there
    await expect(page.getByRole('tab', { name: 'Peloton' })).toHaveCount(0);
    await expect(page.getByRole('tab', { name: 'YouTube' })).toHaveCount(0);
  });

  // AC (R-121/R-123): an admin sees both sub-tabs, and each renders its shows read directly from k8plex.
  test('an admin sees Peloton + YouTube and each renders its shows in the poster grid', async ({
    page,
  }) => {
    await signIn(page, 'admin');
    await openLibrary(page);

    await test.step('the Peloton tab renders its shows', async () => {
      await page.getByRole('tab', { name: 'Peloton' }).click();
      await expect(page.getByTestId('ytdlsub-grid')).toBeVisible();
      await expect(page.getByText('Bike Bootcamp')).toBeVisible();
      await expect(page.getByText('Power Zone Endurance')).toBeVisible();
      // The season/episode caption renders (T-111).
      await expect(page.getByText(/4 seasons · 128 episodes/)).toBeVisible();
    });

    await test.step('a proxied poster image loads (authed Plex-thumb proxy)', async () => {
      const poster = page.locator('.poster-grid .poster-img').first();
      await expect(poster).toBeVisible();
      // The src points at the app proxy (never a raw Plex URL / token).
      await expect(poster).toHaveAttribute('src', /\/api\/ytdlsub\/poster\?thumb=/);
    });

    await test.step('the YouTube tab renders its shows', async () => {
      await page.getByRole('tab', { name: 'YouTube' }).click();
      await expect(page.getByTestId('ytdlsub-grid')).toBeVisible();
      await expect(page.getByText('Documentaries')).toBeVisible();
    });
  });
});
