// Admin surfaces: catalog CRUD happy path incl. the free-form URL entry UX
// (any http(s) URL accepted; bare domains normalize to https:// — BRANCH-A), and
// roles (ADR-012) — create a role with an app set, assign it to a member, and the
// member gains that app set as their tiles. Specs clean up what they create so the
// shared catalog/roles stay canonical for the other spec files.
import { test, expect } from '@playwright/test';
import { armAndConfirm, measureFit, signIn } from './support/helpers';

test.describe('catalog CRUD (admin)', () => {
  test('create → edit → delete a catalog entry', async ({ page }) => {
    await signIn(page, 'admin');
    await page.goto('/admin/catalog');

    // Create — the form lives in a Modal opened by "Add entry" (not a fixed bottom
    // form). A new entry belongs to no role, so a fresh member never sees it (AC-04).
    await page.getByRole('button', { name: 'Add entry' }).click();
    const dialog = page.getByRole('dialog', { name: 'Add entry' });
    await expect(dialog).toBeVisible();
    await dialog.getByLabel('Slug').fill('e2e-status');
    await dialog.getByLabel('Name', { exact: true }).fill('E2E Status');
    await dialog.getByLabel('Description').fill('Suite-created entry');
    // Free-form URL: a bare domain normalizes to https:// on the server.
    await dialog.getByLabel('URL').fill('google.com');
    await dialog.getByRole('button', { name: 'Create entry' }).click();
    await expect(dialog).toBeHidden(); // modal closes on success

    const row = page.locator('.admin-table tbody tr').filter({ hasText: 'e2e-status' });
    await expect(row).toHaveCount(1);
    await expect(row).toContainText('https://google.com');
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

    // Delete (two-step arm-to-confirm) — the row disappears.
    const del = savedRow.getByTestId('catalog-row-delete');
    await armAndConfirm(del);
    await expect(savedRow).toHaveCount(0);
  });

  test('free-form URL — garbage shows an inline error; a bare domain normalizes to https://', async ({
    page,
  }) => {
    await signIn(page, 'admin');
    await page.goto('/admin/catalog');
    await page.getByRole('button', { name: 'Add entry' }).click();
    const dialog = page.getByRole('dialog', { name: 'Add entry' });
    const url = dialog.getByLabel('URL');

    // Garbage surfaces the prominent inline error (not a subtle hint).
    await url.fill('not a url');
    await url.blur();
    await expect(dialog.locator('.field-error')).toBeVisible();
    await expect(url).toHaveAttribute('aria-invalid', 'true');

    // A bare domain is accepted and stored normalized to https://.
    await dialog.getByLabel('Slug').fill('e2e-built');
    await dialog.getByLabel('Name', { exact: true }).fill('Built URL');
    await url.fill('example.org');
    await dialog.getByRole('button', { name: 'Create entry' }).click();
    await expect(dialog).toBeHidden();
    const row = page.locator('.admin-table tbody tr').filter({ hasText: 'e2e-built' });
    await expect(row).toContainText('https://example.org');

    // Cleanup so the shared catalog stays canonical (two-step arm-to-confirm).
    const del = row.getByTestId('catalog-row-delete');
    await armAndConfirm(del);
    await expect(row).toHaveCount(0);
  });

  test('keyboard reorder — ArrowDown on the drag handle swaps rows and persists (ADR-015)', async ({
    page,
  }) => {
    await signIn(page, 'admin');
    await page.goto('/admin/catalog');

    // Two entries with slugs that sort last, so they land adjacent at the tail
    // regardless of the seeded catalog — reorder acts on a known, isolated pair.
    for (const [slug, name] of [
      ['zzz-a', 'ZZZ Alpha'],
      ['zzz-b', 'ZZZ Beta'],
    ] as const) {
      await page.getByRole('button', { name: 'Add entry' }).click();
      const dialog = page.getByRole('dialog', { name: 'Add entry' });
      await expect(dialog).toBeVisible();
      await dialog.getByLabel('Slug').fill(slug);
      await dialog.getByLabel('Name', { exact: true }).fill(name);
      await dialog.getByLabel('URL').fill('example.com');
      await dialog.getByRole('button', { name: 'Create entry' }).click();
      await expect(dialog).toBeHidden();
    }

    // Relative order of the pair among all rows (the whole-tbody text sequence).
    const positions = async () => {
      const texts = await page.locator('.admin-table tbody tr').allTextContents();
      return {
        a: texts.findIndex((t) => t.includes('zzz-a')),
        b: texts.findIndex((t) => t.includes('zzz-b')),
      };
    };

    // Created in order → zzz-a precedes zzz-b.
    let order = await positions();
    expect(order.a).toBeGreaterThanOrEqual(0);
    expect(order.b).toBeGreaterThanOrEqual(0);
    expect(order.a).toBeLessThan(order.b);

    // Drive the KEYBOARD path (not HTML5 dragTo): focus zzz-a's grip and ArrowDown.
    const rowA = page.locator('.admin-table tbody tr').filter({ hasText: 'zzz-a' });
    const handleA = rowA.getByRole('button', { name: /Reorder .* arrow keys/ });
    await handleA.focus();
    await page.keyboard.press('ArrowDown');

    // The pair swapped: zzz-b now precedes zzz-a.
    await expect
      .poll(async () => {
        const o = await positions();
        return o.b < o.a;
      })
      .toBe(true);

    // Persisted through the reorder mutation — survives a reload.
    await page.reload();
    await expect(page.locator('.admin-table tbody tr').filter({ hasText: 'zzz-a' })).toHaveCount(1);
    order = await positions();
    expect(order.b).toBeLessThan(order.a);

    // Cleanup both via the two-step arm-to-confirm delete.
    for (const slug of ['zzz-a', 'zzz-b']) {
      const row = page.locator('.admin-table tbody tr').filter({ hasText: slug });
      const del = row.getByTestId('catalog-row-delete');
      await armAndConfirm(del);
      await expect(row).toHaveCount(0);
    }
  });
});

test.describe('roles (admin)', () => {
  test('a role grants its app set to assigned members; reassignment + delete take it away', async ({
    page,
    browser,
  }) => {
    // Member context first — we watch the dashboard change live from here.
    const memberContext = await browser.newContext();
    const memberPage = await memberContext.newPage();
    await signIn(memberPage, 'member');
    const memberTiles = memberPage.locator('.tile-grid .tile');
    await expect(memberTiles.filter({ hasText: 'Tautulli' })).toHaveCount(0);

    await signIn(page, 'admin');

    // Create a role granting Tautulli (seeded admin-grantable, in no role by default),
    // via the Add-role modal.
    await page.goto('/admin/roles');
    await page.getByRole('button', { name: 'Add role' }).click();
    const dialog = page.getByRole('dialog', { name: 'Add role' });
    await expect(dialog).toBeVisible();
    await dialog.getByLabel('Name', { exact: true }).fill('e2e-role');
    await dialog.getByLabel('Description').fill('Suite-created role');
    await dialog
      .locator('.check-list .check-row')
      .filter({ hasText: 'Tautulli' })
      .locator('input[type="checkbox"]')
      .check();
    await dialog.getByRole('button', { name: 'Create role' }).click();
    await expect(dialog).toBeHidden();

    const roleRow = page.locator('.admin-table tbody tr').filter({ hasText: 'e2e-role' });
    await expect(roleRow).toHaveCount(1);
    await expect(roleRow).toContainText('Tautulli');

    // Assign it to the member on the user detail page.
    await page.goto('/admin');
    await page.getByRole('link', { name: 'Marge Member' }).click();
    await expect(page.getByRole('heading', { name: 'Marge Member' })).toBeVisible();
    const grantsPanel = page
      .locator('.card.admin-section')
      .filter({ hasText: 'Apps this role grants' });

    await page.locator('#user-role').selectOption({ label: 'e2e-role' });
    // The "Apps this role grants" panel reflects the new role once setRole + refetch settle.
    await expect(grantsPanel).toContainText('Tautulli');

    // The member's next refresh gains the role's tile (R-21).
    await memberPage.reload();
    await expect(memberTiles.filter({ hasText: 'Tautulli' })).toHaveCount(1);

    // Reassign the member back to Default — wait for the panel before re-checking the member.
    await page.locator('#user-role').selectOption({ label: 'Default (default)' });
    await expect(grantsPanel).toContainText('Seerr');
    await expect(grantsPanel).not.toContainText('Tautulli');
    await memberPage.reload();
    await expect(memberPage.locator('.greeting')).toBeVisible();
    await expect(memberTiles.filter({ hasText: 'Tautulli' })).toHaveCount(0);

    // …then delete the role itself (two-step arm-to-confirm).
    await page.goto('/admin/roles');
    const roleDeleteRow = page
      .locator('.admin-table tbody tr')
      .filter({ hasText: 'e2e-role' });
    const del = roleDeleteRow.getByTestId('role-row-delete');
    await armAndConfirm(del);
    await expect(roleDeleteRow).toHaveCount(0);

    await memberContext.close();
  });

  // fix/family-strip-mobile-roles (owner-directed 2026-07-09) — the owner couldn't change his wife's
  // role from his phone: the /admin/roles editor broke in portrait and the /admin users card dropped
  // the desktop role control. These two journeys drive the fixed surfaces at 390×844.

  test('mobile 390: the /admin/roles inline editor stacks — change a role trash level + a trash action, saved (round-trips), no sideways scroll', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await signIn(page, 'admin');
    await page.goto('/admin/roles');

    // A throwaway role so the seeded roles other specs depend on are never perturbed. The Add-role
    // modal is also exercised in portrait.
    await page.getByRole('button', { name: 'Add role' }).click();
    const dialog = page.getByRole('dialog', { name: 'Add role' });
    await expect(dialog).toBeVisible();
    await dialog.getByLabel('Name', { exact: true }).fill('Phone Journey Role');
    await dialog.getByRole('button', { name: 'Create role' }).click();
    await expect(dialog).toBeHidden();

    const row = () =>
      page.locator('.admin-table tbody tr').filter({ hasText: 'Phone Journey Role' });
    await expect(row()).toHaveCount(1);

    // The reported breakage was sideways overflow — the collapsed 7-col card must fit 390px.
    const noSideScroll = async () => {
      const m = await measureFit(page);
      expect(m.pageHScroll, 'no horizontal page scroll at 390').toBeLessThanOrEqual(1);
      expect(m.maxRight, 'nothing wider than the viewport at 390').toBeLessThanOrEqual(m.innerW + 1);
    };
    await noSideScroll();

    // Change the Trash LEVEL from the card's full-width select (audited setSectionPermission).
    const trashLevel = page.getByLabel('Trash access for Phone Journey Role');
    await trashLevel.scrollIntoViewIfNeeded();
    await Promise.all([
      page.waitForResponse((r) => r.url().includes('roles.setSectionPermission')),
      trashLevel.selectOption('read_only'), // seeded default is 'disabled' → a real change
    ]);

    // Open the inline editor: the action grid is a stack of tap-friendly checkboxes; Save is
    // reachable at the bottom — and there is still no sideways scroll mid-edit. (exact:true so the
    // "Edit" button isn't confused with any button whose aria-label merely contains the substring;
    // the row's controls re-enable once the level write settles.)
    const editBtn = row().getByRole('button', { name: 'Edit', exact: true });
    await expect(editBtn).toBeEnabled();
    await editBtn.click();
    const grid = page.getByTestId('trash-actions-grid');
    await expect(grid).toBeVisible();
    const action = grid.getByTestId('trash-action-save_exclude');
    await action.scrollIntoViewIfNeeded();
    await action.check();
    await noSideScroll();
    const save = page.getByRole('button', { name: 'Save changes' });
    await save.scrollIntoViewIfNeeded();
    await Promise.all([
      page.waitForResponse((r) => r.url().includes('roles.setTrashActions')),
      save.click(),
    ]);
    // The grant-count badge recounts IN PLACE (ADR-015): one stored action (save_exclude).
    await expect(page.getByTestId('trash-actions-summary-Phone Journey Role')).toHaveText('1 action');

    // Round-trip: both audited writes persist across a reload (the level + the action grant).
    await page.reload();
    await expect(page.getByLabel('Trash access for Phone Journey Role')).toHaveValue('read_only');
    await expect(page.getByTestId('trash-actions-summary-Phone Journey Role')).toHaveText('1 action');

    // Cleanup — delete the throwaway role (two-step confirm).
    await armAndConfirm(row().getByTestId('role-row-delete'));
    await expect(row()).toHaveCount(0);
  });

  test('mobile 390: the /admin users card exposes an editable role select — reassign a member Default → role → back (audited round-trip), no sideways scroll', async ({
    page,
    browser,
  }) => {
    // Ensure the member user row exists (first login creates it) without disturbing the admin page.
    const boot = await browser.newContext();
    const bootPage = await boot.newPage();
    await signIn(bootPage, 'member');
    await boot.close();

    await page.setViewportSize({ width: 390, height: 844 });
    await signIn(page, 'admin');
    await page.goto('/admin');

    // The per-user card must carry the role CONTROL (was plain text on mobile — the owner's bug).
    const margeCard = page.locator('.admin-table tbody tr').filter({ hasText: 'Marge Member' });
    const roleSelect = margeCard.getByTestId('user-role-select');
    await expect(roleSelect).toBeVisible();
    const m = await measureFit(page);
    expect(m.pageHScroll, 'no horizontal page scroll at 390').toBeLessThanOrEqual(1);
    expect(m.maxRight, 'nothing wider than the viewport at 390').toBeLessThanOrEqual(m.innerW + 1);

    // Default → Trash Viewer (the audited users.setRole write; the same one the desktop detail uses).
    await Promise.all([
      page.waitForResponse((r) => r.url().includes('users.setRole')),
      roleSelect.selectOption({ label: 'Trash Viewer' }),
    ]);
    // Round-trip: reload and the card's select reflects the committed role.
    await page.reload();
    await expect(
      margeCard.getByTestId('user-role-select').locator('option:checked'),
    ).toHaveText('Trash Viewer');

    // …and back to Default (leaves the roster as later specs expect it).
    await Promise.all([
      page.waitForResponse((r) => r.url().includes('users.setRole')),
      margeCard.getByTestId('user-role-select').selectOption({ label: 'Default (default)' }),
    ]);
    await page.reload();
    await expect(
      margeCard.getByTestId('user-role-select').locator('option:checked'),
    ).toHaveText(/Default/);
  });
});
