// ADR-045 / DESIGN-023 (PLAN-026) end to end, hermetic: an admin creates the "Friends" synced tier via
// /admin/roles (the shipped UX), which PRE-CREATES the Authentik group `friends` AND the same-named Open
// WebUI group; then assigns the Plex-external identity `plexguy` (currently in `family`) the Friends role
// via /admin/users, which flips its owned-group membership EXCLUSIVELY (join friends, leave family) and
// parks a pending intent (no app row). Asserts against the stub Authentik/OWUI control surfaces — the
// hermetic mirror of the PROD acceptance scenario (create Friends → move mikebi12 family→friends).
import { test, expect } from '@playwright/test';
import { signIn } from './support/helpers';
import { readRuntimeEnv } from './support/env';

interface AuthentikState {
  users: Array<{ pk: number; username: string; groups: string[] }>;
  groups: Array<{ name: string; members: number[] }>;
  createdGroups: string[];
}

async function authentikState(): Promise<AuthentikState> {
  const env = readRuntimeEnv();
  const res = await fetch(`${env.STUB_AUTHENTIK_URL}/_stub/state`);
  return (await res.json()) as AuthentikState;
}

async function owuiCreatedGroups(): Promise<string[]> {
  const env = readRuntimeEnv();
  const res = await fetch(`${env.STUB_OPENWEBUI_URL}/_stub/groups`);
  const body = (await res.json()) as { createdGroups: Array<{ name: string }> };
  return body.createdGroups.map((g) => g.name);
}

test('admin creates a Friends synced tier and moves a Plex identity family → friends', async ({
  page,
}) => {
  await signIn(page, 'admin');

  // (a) Create the "Friends" role as a synced tier.
  await page.goto('/admin/roles');
  await page.getByRole('button', { name: 'Add role' }).click();
  await page.getByRole('textbox', { name: 'Name', exact: true }).fill('Friends');
  await page.getByTestId('synced-tier-add').check();
  await page.getByRole('button', { name: 'Create role' }).click();

  // The Add-role modal closes on success; the new row carries the "synced tier" tag.
  await expect(page.getByRole('heading', { name: 'Add role' })).toHaveCount(0);
  await expect(page.getByRole('cell', { name: /Friends/ }).first()).toBeVisible();

  // Verify the tier's group was pre-created in BOTH Authentik and Open WebUI.
  await expect
    .poll(async () => (await authentikState()).createdGroups)
    .toContain('friends');
  await expect.poll(async () => await owuiCreatedGroups()).toContain('friends');

  // Precondition: plexguy (pk 2) starts in `family` only.
  const before = await authentikState();
  expect(before.users.find((u) => u.pk === 2)!.groups).toEqual(['family']);

  // (b) Assign plexguy the Friends role via /admin/users (Authentik-only identity → pending + group flip).
  await page.goto('/admin/users');
  const select = page.locator('#dir-role-2');
  await expect(select).toBeVisible();
  await select.selectOption({ label: 'Friends' });

  // The exclusive-tier flip: plexguy is now in `friends` and no longer in `family`.
  await expect
    .poll(async () => (await authentikState()).users.find((u) => u.pk === 2)!.groups)
    .toEqual(['friends']);

  // The UI reflects the parked pending assignment (no app row yet).
  await expect(page.getByTestId('dir-role-pending').first()).toContainText('Friends');
});
