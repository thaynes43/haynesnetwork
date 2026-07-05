// Admin surfaces: catalog CRUD happy path incl. the R-14 rejection UX
// (*.haynesops.com URLs never reach the catalog — CLAUDE.md hard rule 3), and
// tags — create a family tag with an app bundle, apply it to a member, and the
// member gains the bundled tile (R-20/R-21). Specs clean up what they create so
// the shared catalog/grants stay canonical for the other spec files.
import { test, expect, type Page } from '@playwright/test';
import { signIn } from './support/helpers';

/** Auto-accept the next window.confirm (delete flows). */
function acceptNextDialog(page: Page): void {
  page.once('dialog', (dialog) => void dialog.accept());
}

test.describe('catalog CRUD (admin)', () => {
  test('create → edit → delete a catalog entry', async ({ page }) => {
    await signIn(page, 'admin');
    await page.goto('/admin/catalog');

    // Create — the form lives in a Modal opened by "Add entry" (not a fixed bottom
    // form). defaultVisible stays off so AC-04's "exactly the defaults" holds.
    await page.getByRole('button', { name: 'Add entry' }).click();
    const dialog = page.getByRole('dialog', { name: 'Add entry' });
    await expect(dialog).toBeVisible();
    await dialog.getByLabel('Slug').fill('e2e-status');
    await dialog.getByLabel('Name', { exact: true }).fill('E2E Status');
    await dialog.getByLabel('Description').fill('Suite-created entry');
    await dialog.getByLabel('URL').fill('https://status.haynesnetwork.com');
    await dialog.getByRole('button', { name: 'Create entry' }).click();
    await expect(dialog).toBeHidden(); // modal closes on success

    const row = page.locator('.admin-table tbody tr').filter({ hasText: 'e2e-status' });
    await expect(row).toHaveCount(1);
    await expect(row).toContainText('https://status.haynesnetwork.com');
    await expect(row).toContainText('E2E Status');

    // Edit — the row expands into an inline editor IN PLACE (no bottom form); slug is
    // immutable and the row updates on save.
    await row.getByRole('button', { name: 'Edit' }).click();
    const editRow = page.locator('.admin-table tbody tr.row-edit');
    await expect(editRow).toBeVisible();
    await expect(editRow).toContainText('slug is immutable');
    await editRow.getByLabel('Name', { exact: true }).fill('E2E Status Page');
    await editRow.getByRole('button', { name: 'Save changes' }).click();
    const savedRow = page.locator('.admin-table tbody tr').filter({ hasText: 'e2e-status' });
    await expect(savedRow).toContainText('E2E Status Page');

    // Delete (native confirm) — the row disappears.
    acceptNextDialog(page);
    await savedRow.getByRole('button', { name: 'Delete' }).click();
    await expect(
      page.locator('.admin-table tbody tr').filter({ hasText: 'e2e-status' }),
    ).toHaveCount(0);
  });

  test('R-14 rejection UX — a haynesops.com URL shows a validation error and creates nothing', async ({
    page,
  }) => {
    await signIn(page, 'admin');
    await page.goto('/admin/catalog');

    await page.getByRole('button', { name: 'Add entry' }).click();
    const dialog = page.getByRole('dialog', { name: 'Add entry' });
    await dialog.getByLabel('Slug').fill('e2e-sneaky');
    await dialog.getByLabel('Name', { exact: true }).fill('Sneaky LAN App');
    await dialog.getByLabel('URL').fill('https://sneaky.haynesops.com');
    await dialog.getByRole('button', { name: 'Create entry' }).click();

    // The live client check blocks submit; the modal stays open with the error.
    await expect(dialog).toBeVisible();
    await expect(dialog.locator('.field-error')).toBeVisible();
    await expect(dialog.locator('.field-error')).toContainText(
      'Host must be a *.haynesnetwork.com subdomain',
    );
    await expect(dialog.getByLabel('URL')).toHaveAttribute('aria-invalid', 'true');
    // Nothing was created — haynesops never reaches the catalog.
    await expect(page.locator('.admin-table').getByText('e2e-sneaky')).toHaveCount(0);
    await expect(page.locator('.admin-table').getByText('haynesops.com')).toHaveCount(0);
  });
});

test.describe('tags (admin)', () => {
  test('family tag with a bundle: member gains the bundled tile; removal takes it away', async ({
    page,
    browser,
  }) => {
    // Member context first — the row must exist before the admin can tag it, and
    // we watch the dashboard change live from here.
    const memberContext = await browser.newContext();
    const memberPage = await memberContext.newPage();
    await signIn(memberPage, 'member');
    const memberTiles = memberPage.locator('.tile-grid .tile');
    await expect(memberTiles.filter({ hasText: 'Tautulli' })).toHaveCount(0);

    await signIn(page, 'admin');

    // Create the family tag bundling Tautulli (seeded admin-grantable, hidden).
    await page.goto('/admin/tags');
    // The name field's hint text joins its accessible name — match on the prefix.
    await page.getByRole('textbox', { name: /^Name/ }).fill('e2e-family');
    await page.getByLabel('Description').fill('Suite-created family tag');
    await page.getByLabel('Grants family designation (R-20)').check();
    await page
      .locator('.check-list .check-row')
      .filter({ hasText: 'Tautulli' })
      .locator('input[type="checkbox"]')
      .check();
    await page.getByRole('button', { name: 'Create tag' }).click();

    const tagRow = page.locator('.admin-table tbody tr').filter({ hasText: 'e2e-family' });
    await expect(tagRow).toHaveCount(1);
    await expect(tagRow).toContainText('Tautulli');
    await expect(tagRow).toContainText('grants family');

    // Apply it to the member on the user detail page.
    await page.goto('/admin');
    await page.getByRole('link', { name: 'Marge Member' }).click();
    await expect(page.getByRole('heading', { name: 'Marge Member' })).toBeVisible();
    await page.locator('#apply-tag').selectOption({ label: 'e2e-family' });
    await page.getByRole('button', { name: 'Apply tag' }).click();
    const appliedChip = page.locator('.chips--list .chip').filter({ hasText: 'e2e-family' });
    await expect(appliedChip).toBeVisible();
    // Provenance on the bundled app flips to tag:<name> (R-22).
    const tautulliRow = page.locator('.grant').filter({ hasText: 'Tautulli' });
    await expect(tautulliRow.locator('.chip', { hasText: 'tag:e2e-family' })).toBeVisible();

    // The member's next refresh gains the bundled tile (R-21).
    await memberPage.reload();
    await expect(memberTiles.filter({ hasText: 'Tautulli' })).toHaveCount(1);

    // Cleanup, still through the UI: remove the tag from the member…
    await page.getByRole('button', { name: 'Remove tag e2e-family' }).click();
    await expect(appliedChip).toHaveCount(0);
    await memberPage.reload();
    await expect(memberPage.locator('.greeting')).toBeVisible();
    await expect(memberTiles.filter({ hasText: 'Tautulli' })).toHaveCount(0);

    // …then delete the tag itself.
    await page.goto('/admin/tags');
    acceptNextDialog(page);
    await page
      .locator('.admin-table tbody tr')
      .filter({ hasText: 'e2e-family' })
      .getByRole('button', { name: 'Delete' })
      .click();
    await expect(
      page.locator('.admin-table tbody tr').filter({ hasText: 'e2e-family' }),
    ).toHaveCount(0);

    await memberContext.close();
  });
});
