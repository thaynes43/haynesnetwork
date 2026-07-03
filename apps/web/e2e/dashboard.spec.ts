// AC-04 — a fresh Member's dashboard shows exactly the seeded default-visible
// catalog entries (Seerr, Plex, K8Plex — migration 0002), every href on
// https://*.haynesnetwork.com (R-14, CLAUDE.md hard rule 3).
// AC-05 — admin grants an app through the admin UI and the member's next refresh
// shows the tile; revoke removes it. Driven with two live browser contexts.
import { test, expect, type Page } from '@playwright/test';
import { signIn } from './support/helpers';

const HNET_URL = /^https:\/\/[a-z0-9-]+(\.[a-z0-9-]+)*\.haynesnetwork\.com(\/|$)/;

function tiles(page: Page) {
  return page.locator('.tile-grid .tile');
}

test('AC-04 — fresh member sees exactly the seeded default tiles with haynesnetwork.com hrefs', async ({
  page,
}) => {
  // The fresh-member persona is never granted anything by any spec.
  await signIn(page, 'fresh-member');

  // Exactly the three default-visible seeds, in sort_order.
  await expect(tiles(page).locator('.tile__name')).toHaveText([/Seerr/, /Plex/, /K8Plex/]);

  const hrefs = await tiles(page).evaluateAll((els) => els.map((el) => el.getAttribute('href')));
  expect(hrefs).toEqual([
    'https://overseerr.haynesnetwork.com',
    'https://plex.haynesnetwork.com',
    'https://k8plex.haynesnetwork.com',
  ]);
  for (const href of hrefs) {
    expect(href).toMatch(HNET_URL);
  }

  // Tiles open in a new tab without leaking an opener.
  await expect(tiles(page).first()).toHaveAttribute('target', '_blank');
  await expect(tiles(page).first()).toHaveAttribute('rel', 'noopener noreferrer');
});

test('AC-05 — admin grant shows on the member refresh; revoke removes it', async ({
  page,
  browser,
}) => {
  // Member signs in first (its own context) so the users row exists for the admin.
  const memberContext = await browser.newContext();
  const memberPage = await memberContext.newPage();
  await signIn(memberPage, 'member');
  await expect(tiles(memberPage).filter({ hasText: 'Immich' })).toHaveCount(0);

  // Admin drives the grant in the default context.
  await signIn(page, 'admin');
  await page.goto('/admin');
  await page.getByRole('link', { name: 'Marge Member' }).click();
  await expect(page.getByRole('heading', { name: 'Marge Member' })).toBeVisible();

  const immichRow = page.locator('.grant').filter({ hasText: 'Immich' });
  const immichCheckbox = immichRow.locator('input[type="checkbox"]');
  await expect(immichCheckbox).not.toBeChecked();

  // Grant: controlled checkbox — state lands after the mutation + refetch settle.
  await immichCheckbox.click();
  await expect(immichCheckbox).toBeChecked();
  await expect(immichRow.locator('.chip', { hasText: 'direct' })).toBeVisible();

  // Member's next refresh shows the tile (AC-05 "next dashboard query").
  await memberPage.reload();
  await expect(tiles(memberPage).filter({ hasText: 'Immich' })).toHaveCount(1);
  await expect(tiles(memberPage).filter({ hasText: 'Immich' })).toHaveAttribute(
    'href',
    'https://immich.haynesnetwork.com',
  );

  // Revoke removes it again.
  await immichCheckbox.click();
  await expect(immichCheckbox).not.toBeChecked();
  await memberPage.reload();
  await expect(memberPage.locator('.greeting')).toBeVisible();
  await expect(tiles(memberPage).filter({ hasText: 'Immich' })).toHaveCount(0);

  await memberContext.close();
});
