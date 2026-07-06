// ADR-017 / DESIGN-007 — Plex library self-service e2e (hermetic via stub-plex.ts). Covers the
// R-25..R-28 journeys: a member sees only their role's libraries (family library withheld),
// adds one (a sharing write is recorded at the stub), removes it via the two-step ConfirmButton
// (an un-share is recorded), and the admin registry-refresh + per-role library matrix on
// /admin/roles. ADR-024 (D-13): the member's Default role all-grants haynesops and their stub
// account starts all-libraries there, so the per-server All↔Specific segmented toggle, the
// read-only "Included" state (no per-library Add/Remove while All), and the admin per-server
// All-libraries grant round-trip are exercised too. Serial: the tests share the one stack +
// stub state.
import { test, expect } from '@playwright/test';
import { armAndConfirm, signIn } from './support/helpers';
import { readRuntimeEnv } from './support/env';

interface StubShareCall {
  method: string;
  path: string;
  machineId: string;
  body: unknown;
}

async function stubCalls(): Promise<StubShareCall[]> {
  const env = readRuntimeEnv();
  const res = await fetch(`${env.STUB_PLEX_URL}/_stub/calls`);
  if (!res.ok) throw new Error(`stub-plex calls fetch failed: ${res.status}`);
  return ((await res.json()) as { calls: StubShareCall[] }).calls;
}

async function resetStubPlex(): Promise<void> {
  const env = readRuntimeEnv();
  await fetch(`${env.STUB_PLEX_URL}/_stub/reset`, { method: 'POST' });
}

test.describe.serial('Plex library self-service (ADR-017)', () => {
  test('member sees only their role-allowed libraries — the family library is withheld', async ({
    page,
  }) => {
    await resetStubPlex();
    await signIn(page, 'member');
    await page.locator('.topbar__nav').getByRole('link', { name: 'My Plex' }).click();
    await page.waitForURL('/library/plex');
    await expect(page.getByRole('heading', { name: 'My Plex libraries' })).toBeVisible();

    // Granted (Default role): HNet Movies + HOps Movies.
    await expect(page.locator('.plex-lib-row', { hasText: 'HNet Movies' })).toBeVisible();
    await expect(page.locator('.plex-lib-row', { hasText: 'HOps Movies' })).toBeVisible();
    // NOT granted (family-only): HNet Photos is absent from the page entirely (R-26).
    await expect(page.getByText('HNet Photos')).toHaveCount(0);
  });

  test('member adds then removes a library — sharing writes are recorded', async ({ page }) => {
    await resetStubPlex();
    await signIn(page, 'member');
    await page.goto('/library/plex');
    const moviesRow = page.locator('.plex-lib-row', { hasText: 'HNet Movies' });

    // ---- ADD ----
    await moviesRow.getByTestId('plex-add').click();
    await expect(moviesRow.getByTestId('plex-remove')).toBeVisible();
    let calls = await stubCalls();
    const addWrite = calls.find((c) => c.method === 'POST' || c.method === 'PUT');
    expect(addWrite, 'an add records a shared_servers write').toBeTruthy();
    // The write carries the HNet Movies plex.tv section id (read-merge-write payload).
    expect(JSON.stringify(addWrite!.body)).toContain('118181361');

    // ---- REMOVE (two-step ConfirmButton — ADR-014) ----
    await armAndConfirm(moviesRow.getByTestId('plex-remove'));
    await expect(moviesRow.getByTestId('plex-add')).toBeVisible();
    calls = await stubCalls();
    expect(
      calls.some((c) => c.method === 'DELETE'),
      'removing the last shared section un-shares the server',
    ).toBe(true);
  });

  test('all-libraries: the member toggles between All and specific libraries (ADR-024)', async ({
    page,
  }) => {
    await resetStubPlex();
    await signIn(page, 'member');
    await page.goto('/library/plex');

    const ops = page.locator('.plex-server', { hasText: 'HaynesOps' });
    const opsRow = ops.locator('.plex-lib-row', { hasText: 'HOps Movies' });

    // Seeded in the all-libraries state: the All segment is active, the state note explains the
    // future-inclusive grant, and NO per-library Add/Remove is offered — the row is read-only
    // "Included" (PLEX_ALL_STATE is unreachable from the UI).
    await expect(ops.getByTestId('plex-mode-all')).toHaveAttribute('aria-pressed', 'true');
    await expect(ops.locator('.plex-mode__note')).toContainText(
      'all current and future libraries',
    );
    await expect(opsRow).toContainText('Included');
    await expect(ops.getByTestId('plex-add')).toHaveCount(0);
    await expect(ops.getByTestId('plex-remove')).toHaveCount(0);

    // No toggle on a server the role does NOT all-grant (haynestower is explicit-only).
    const tower = page.locator('.plex-server', { hasText: 'HaynesTower' });
    await expect(tower.locator('.plex-lib-row', { hasText: 'HNet Movies' })).toBeVisible();
    await expect(tower.getByTestId('plex-mode-all')).toHaveCount(0);

    // ---- leave All: demote to an explicit list seeded with the current full set (no loss) ----
    await ops.getByTestId('plex-mode-specific').click();
    await expect(ops.getByTestId('plex-mode-specific')).toHaveAttribute('aria-pressed', 'true');
    // The seeded full set keeps HOps Movies shared, so Remove (not Add) is offered.
    await expect(opsRow.getByTestId('plex-remove')).toBeVisible();
    let calls = await stubCalls();
    const offWrite = calls.find(
      (c) => c.method === 'PUT' && JSON.stringify(c.body).includes('"all_libraries":false'),
    );
    expect(offWrite, 'leaving All records an explicit-list write').toBeTruthy();
    expect(
      JSON.stringify(offWrite!.body),
      'the explicit list is seeded with the current full section set',
    ).toContain('200001');

    // ---- return to All: per-library controls disappear again ----
    await ops.getByTestId('plex-mode-all').click();
    await expect(ops.getByTestId('plex-mode-all')).toHaveAttribute('aria-pressed', 'true');
    await expect(opsRow).toContainText('Included');
    await expect(ops.getByTestId('plex-add')).toHaveCount(0);
    await expect(ops.getByTestId('plex-remove')).toHaveCount(0);
    calls = await stubCalls();
    expect(
      calls.some(
        (c) => c.method === 'PUT' && JSON.stringify(c.body).includes('"all_libraries":true'),
      ),
      'returning to All records the all-libraries write',
    ).toBe(true);
  });

  test('the member page fits a narrow viewport (no page scroll, no overflow)', async ({ page }) => {
    await signIn(page, 'member');
    await page.setViewportSize({ width: 375, height: 720 });
    await page.goto('/library/plex');
    await expect(page.getByRole('heading', { name: 'My Plex libraries' })).toBeVisible();
    const m = await page.evaluate(() => ({
      hScroll: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      innerW: window.innerWidth,
    }));
    expect(m.hScroll, 'no page-level horizontal scrollbar').toBeLessThanOrEqual(1);
  });

  test('admin: registry refresh + the per-role library matrix on /admin/roles', async ({ page }) => {
    await signIn(page, 'admin');
    await page.goto('/admin/roles');

    // Registry refresh (idempotent — the stub serves the same sections the seed used). All three
    // stub servers are reachable, so the refresh reports success per server (DESIGN-007 D-12) —
    // an info-tone status note, never the red error banner.
    await page.getByTestId('plex-refresh-registry').click();
    await expect(page.getByTestId('plex-refresh-registry')).toHaveText('Refresh Plex libraries');
    await expect(page.locator('.alert')).toHaveCount(0);
    const refreshStatus = page.getByTestId('plex-refresh-status');
    await expect(refreshStatus).toBeVisible();
    await expect(refreshStatus).toContainText('HaynesTower');
    await expect(refreshStatus).toContainText('libraries');
    await expect(refreshStatus).not.toContainText('unreachable');
    await expect(refreshStatus).not.toHaveClass(/status-note--warn/);

    // Open the Default role editor; its library matrix reflects the seeded grants.
    const defaultRow = page.locator('tr', { hasText: 'Default' }).first();
    await defaultRow.getByRole('button', { name: 'Edit' }).click();
    const matrix = page.locator('fieldset', { hasText: 'Plex libraries this role can self-add' });
    await expect(matrix).toBeVisible();
    // HNet Movies is granted (checked); the family HNet Photos is present but unchecked.
    await expect(
      matrix.locator('.check-row', { hasText: 'HNet Movies' }).locator('input[type="checkbox"]'),
    ).toBeChecked();
    await expect(
      matrix.locator('.check-row', { hasText: 'HNet Photos' }).locator('input[type="checkbox"]'),
    ).not.toBeChecked();
  });

  test('admin: the per-server All-libraries grant round-trips in the role editor (ADR-024)', async ({
    page,
  }) => {
    await signIn(page, 'admin');
    await page.goto('/admin/roles');

    const matrix = page.locator('fieldset', { hasText: 'Plex libraries this role can self-add' });
    const editButton = () =>
      page.locator('tr', { hasText: 'Default' }).first().getByRole('button', { name: 'Edit' });
    const openDefaultEditor = async () => {
      await editButton().click();
      await expect(matrix).toBeVisible();
    };
    // Saving fires two sequential mutations (roles.update then setRoleLibraryGrants); the row's
    // Edit button stays disabled until both settle, and the reload re-reads committed state.
    const saveAndReload = async () => {
      await page.getByRole('button', { name: 'Save changes' }).click();
      await expect(matrix).toHaveCount(0);
      await expect(editButton()).toBeEnabled();
      await page.reload();
    };

    await openDefaultEditor();
    const allOps = () => matrix.getByTestId('lib-all-haynesops');
    const opsMovies = () =>
      matrix.locator('.check-row', { hasText: 'HOps Movies' }).locator('input[type="checkbox"]');

    // The seeded all-grant on haynesops is reflected; its per-library boxes read implied-on
    // (checked + disabled) without losing the underlying explicit grant. Other servers are
    // unaffected.
    await expect(allOps()).toBeChecked();
    await expect(opsMovies()).toBeChecked();
    await expect(opsMovies()).toBeDisabled();
    await expect(matrix.getByTestId('lib-all-haynestower')).not.toBeChecked();

    // Uncheck All → the per-library boxes are editable again and the kept explicit grant shows.
    await allOps().uncheck();
    await expect(opsMovies()).toBeEnabled();
    await expect(opsMovies()).toBeChecked();
    await saveAndReload();

    // The cleared all-grant persisted; the explicit HOps Movies grant survived untouched.
    await openDefaultEditor();
    await expect(allOps()).not.toBeChecked();
    await expect(opsMovies()).toBeEnabled();
    await expect(opsMovies()).toBeChecked();

    // Re-grant All and save — restores the seeded state for the member specs.
    await allOps().check();
    await expect(opsMovies()).toBeDisabled();
    await saveAndReload();
    await openDefaultEditor();
    await expect(allOps()).toBeChecked();
    await expect(opsMovies()).toBeDisabled();
  });
});
