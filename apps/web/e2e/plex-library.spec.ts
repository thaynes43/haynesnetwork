// ADR-017 / DESIGN-007 — Plex library self-service e2e (hermetic via stub-plex.ts). Covers the
// R-25..R-28 journeys: a member sees only their role's libraries (family library withheld),
// adds one (a sharing write is recorded at the stub), removes it via the two-step ConfirmButton
// (an un-share is recorded), and the admin registry-refresh + per-role library matrix on
// /admin/roles. Serial: the tests share the one stack + stub state.
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

    // Registry refresh (idempotent — the stub serves the same sections the seed used).
    await page.getByTestId('plex-refresh-registry').click();
    await expect(page.getByTestId('plex-refresh-registry')).toHaveText('Refresh Plex libraries');
    await expect(page.locator('.alert')).toHaveCount(0);

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
});
