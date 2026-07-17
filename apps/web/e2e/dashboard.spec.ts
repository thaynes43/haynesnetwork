// AC-04 (amended by DESIGN-004 D-23) — the launcher grid lives on /portal now: a fresh
// member's Portal shows exactly the Default role's seeded apps MINUS the three direct Plex
// server cards (Plex, K8Plex, PlexOps — the D-23 display exclusion; catalog rows untouched),
// every href a valid https URL, with the inverted Plex web-player link above the rule.
// AC-05 — admin assigns the member a role that grants an app and the member's next
// refresh shows the tile; reassigning to Default removes it. Two live browser contexts.
import { test, expect, type Page } from '@playwright/test';
import { armAndConfirm, signIn } from './support/helpers';

const HNET_URL = /^https:\/\/[a-z0-9-]+(\.[a-z0-9-]+)*\.haynesnetwork\.com(\/|$)/;

function tiles(page: Page) {
  return page.locator('.tile-grid .tile');
}

test('AC-04 — fresh member Portal: seeded defaults minus the server cards, plus the player link', async ({
  page,
}) => {
  // The fresh-member persona is never granted anything by any spec.
  await signIn(page, 'fresh-member');
  await page.goto('/portal');

  // The Default role seeds Seerr + Plex + K8Plex + PlexOps (ADR-012 migration 0007); the
  // Portal renders that set minus the three direct-server cards (D-23) — Seerr remains.
  await expect(tiles(page).locator('.tile__name')).toHaveText([/Seerr/]);

  const hrefs = await tiles(page).evaluateAll((els) => els.map((el) => el.getAttribute('href')));
  expect(hrefs).toEqual(['https://overseerr.haynesnetwork.com']);
  for (const href of hrefs) {
    expect(href).toMatch(HNET_URL);
  }

  // The one Plex entry point: the inverted web-player link at the top (D-23).
  const player = page.getByTestId('portal-plex-link');
  await expect(player).toHaveAttribute('href', 'https://app.plex.tv');
  await expect(player).toHaveAttribute('target', '_blank');
  await expect(player).toHaveAttribute('rel', 'noopener noreferrer');

  // Tiles open in a new tab without leaking an opener.
  await expect(tiles(page).first()).toHaveAttribute('target', '_blank');
  await expect(tiles(page).first()).toHaveAttribute('rel', 'noopener noreferrer');
});

test('AC-05 — assigning a role that grants an app shows it on the member refresh; reassign removes it', async ({
  page,
  browser,
}) => {
  // Member signs in first (its own context) so the users row exists for the admin.
  const memberContext = await browser.newContext();
  const memberPage = await memberContext.newPage();
  await signIn(memberPage, 'member');
  await memberPage.goto('/portal');
  await expect(memberPage.getByTestId('portal-plex-link')).toBeVisible();
  await expect(tiles(memberPage).filter({ hasText: 'Immich' })).toHaveCount(0);

  await signIn(page, 'admin');

  // Create a role that grants Immich (seeded admin-grantable, in no role by default).
  await page.goto('/admin/roles');
  await page.getByRole('button', { name: 'Add role' }).click();
  const dialog = page.getByRole('dialog', { name: 'Add role' });
  await dialog.getByLabel('Name', { exact: true }).fill('e2e-immich');
  await dialog
    .locator('.check-list .check-row')
    .filter({ hasText: 'Immich' })
    .locator('input[type="checkbox"]')
    .check();
  await dialog.getByRole('button', { name: 'Create role' }).click();
  await expect(dialog).toBeHidden();

  // Assign it to the member.
  await page.goto('/admin');
  await page.getByRole('link', { name: 'Marge Member' }).click();
  await expect(page.getByRole('heading', { name: 'Marge Member' })).toBeVisible();
  const grantsPanel = page
    .locator('.card.admin-section')
    .filter({ hasText: 'Apps this role grants' });

  await page.locator('#user-role').selectOption({ label: 'e2e-immich' });
  await expect(grantsPanel).toContainText('Immich'); // waits for setRole + refetch to settle

  // Member's next refresh shows the tile (AC-05 "next dashboard query").
  await memberPage.reload();
  await expect(tiles(memberPage).filter({ hasText: 'Immich' })).toHaveCount(1);
  await expect(tiles(memberPage).filter({ hasText: 'Immich' })).toHaveAttribute(
    'href',
    'https://immich.haynesnetwork.com',
  );

  // Reassigning to Default removes it again (wait for the panel before re-checking).
  await page.locator('#user-role').selectOption({ label: 'Default (default)' });
  await expect(grantsPanel).toContainText('Seerr');
  await expect(grantsPanel).not.toContainText('Immich');
  await memberPage.reload();
  await expect(memberPage.getByTestId('portal-plex-link')).toBeVisible();
  await expect(tiles(memberPage).filter({ hasText: 'Immich' })).toHaveCount(0);

  // Cleanup: delete the role (two-step arm-to-confirm).
  await page.goto('/admin/roles');
  const roleDeleteRow = page
    .locator('.admin-table tbody tr')
    .filter({ hasText: 'e2e-immich' });
  const del = roleDeleteRow.getByTestId('role-row-delete');
  await armAndConfirm(del);
  await expect(roleDeleteRow).toHaveCount(0);

  await memberContext.close();
});
