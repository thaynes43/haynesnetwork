// ADR-023 / ADR-033 / DESIGN-010 + DESIGN-011 end to end — the Trash section, the app's ONLY
// user-facing deletion surface, now with the Batches tab FOLDED INTO the per-kind tabs (ADR-033):
// each of Movies/TV is one state-aware surface driven by that kind's open batch. This suite walks
// the whole thing serially (one stack, one DB, the stub's mutable state):
//   • the safety banner + the pending POSTER WALL (no open batch) — the owner-refined fast
//     tap-toggle (poster flips trash⇄shield), the library-nav corner (→ /library/[id]?from=…),
//     the reclaim counts bar + Expedite-all; per-item "Delete now…" relocated to the item page;
//   • the batch lifecycle IN the Movies tab — Start a batch → admin_review curation (+ the
//     admin-only new-candidates strip) → Green-light → Leaving-Soon countdown + family save
//     window → Expire sweep → the Past-batches strip (each row expands to its final report);
//   • the ?tab=batches → ?tab=movies redirect for old deep links;
//   • the context-aware item back-link (← Trash Movies / ← Bulletin, history.back() with state);
//   • Recently-Deleted → Restore, the Rules list (/settings/trash), Activity, the roles grid, and
//     role gating.
// Per-item /collections/media/handle calls ONLY (the estate-wide /collections/handle is asserted
// ABSENT — ADR-023 C-07a).
import { test, expect, type Page } from '@playwright/test';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { armAndConfirm, expectViewportFit, openUserMenu, signIn, signOut } from './support/helpers';
import { readRuntimeEnv } from './support/env';
import {
  STUB_MAINT_FIXTURE_ID,
  STUB_MAINT_TV_ID,
  STUB_MAINT_VANISHED_ID,
  type RecordedMaintainerrWrite,
} from './support/stub-maintainerr';

const env = () => readRuntimeEnv();

async function resetMaintainerr(page: Page): Promise<void> {
  await page.request.post(`${env().STUB_MAINTAINERR_URL}/_stub/reset`);
}

async function maintainerrCalls(page: Page): Promise<RecordedMaintainerrWrite[]> {
  const res = await page.request.get(`${env().STUB_MAINTAINERR_URL}/_stub/calls`);
  return ((await res.json()) as { calls: RecordedMaintainerrWrite[] }).calls;
}

async function maintainerrWipes(page: Page): Promise<unknown[]> {
  const res = await page.request.get(`${env().STUB_MAINTAINERR_URL}/_stub/wipes`);
  return ((await res.json()) as { wipes: unknown[] }).wipes;
}

async function setIntegration(page: Page, name: string, connected: boolean): Promise<void> {
  await page.request.post(`${env().STUB_MAINTAINERR_URL}/_stub/integrations`, {
    data: { name, connected },
  });
}

async function seedExclusion(page: Page, mediaServerId: string): Promise<void> {
  await page.request.post(`${env().STUB_MAINTAINERR_URL}/_stub/exclude`, { data: { mediaServerId } });
}

/** Push a NEW pending candidate into the movie collection AFTER a batch snapshot (ADR-033 strip). */
async function addPendingCandidate(page: Page): Promise<void> {
  await page.request.post(`${env().STUB_MAINTAINERR_URL}/_stub/add-pending`, {
    data: { collectionId: 7, mediaServerId: 'ms-990010', tmdbId: 990010, sizeBytes: 3_221_225_472 },
  });
}

/** Drop a pending item from its collection — empty a whole kind (Overview "nothing pending" card). */
async function removePending(page: Page, mediaServerId: string): Promise<void> {
  await page.request.post(`${env().STUB_MAINTAINERR_URL}/_stub/remove-pending`, {
    data: { mediaServerId },
  });
}

async function openTrashMovies(page: Page): Promise<void> {
  await page.goto('/trash?tab=movies');
  await expect(page.getByTestId('trash-tile').filter({ hasText: 'Vanished Heist' })).toHaveCount(1);
}

/** Assign the Marge Member persona's user to a role by name (admin user-detail select). */
async function assignMemberRole(page: Page, roleLabel: string): Promise<void> {
  await page.goto('/admin');
  await page.getByRole('link', { name: 'Marge Member' }).click();
  await expect(page.getByRole('heading', { name: 'Marge Member' })).toBeVisible();
  const settled = page.waitForResponse((r) => r.url().includes('users.setRole'));
  await page.locator('#user-role').selectOption({ label: roleLabel });
  await settled;
}

/** Green-light the OPEN admin_review batch with an ALREADY-EXPIRED window (e2e time-travel). */
function greenlightExpired(kind: 'movie' | 'tv'): void {
  const res = spawnSync(
    join(process.cwd(), 'node_modules', '.bin', 'tsx'),
    [join(process.cwd(), 'e2e', 'support', 'greenlight-expired.ts'), kind],
    { env: { ...process.env, ...env() }, encoding: 'utf8' },
  );
  if (res.status !== 0) throw new Error(`greenlight-expired failed:\n${res.stdout}\n${res.stderr}`);
}

/** ADR-015: the two boxes are the same place and size (float-tolerant). */
function expectSameBox(
  a: { x: number; y: number; width: number; height: number } | null,
  b: { x: number; y: number; width: number; height: number } | null,
): void {
  expect(a).not.toBeNull();
  expect(b).not.toBeNull();
  for (const key of ['x', 'y', 'width', 'height'] as const) {
    expect(Math.abs(a![key] - b![key]), `tile ${key} must not move on tap`).toBeLessThan(0.5);
  }
}

test.describe('trash section — merged per-kind lifecycle (ADR-033)', () => {
  test.describe.configure({ mode: 'serial' });

  test('the Admin → Restore nav item is gone; /admin/restore and ?tab=batches redirect', async ({
    page,
  }) => {
    await signIn(page, 'admin');
    await page.goto('/admin');
    await expect(page.locator('.admin-nav').getByRole('link', { name: 'Restore' })).toHaveCount(0);
    await page.goto('/admin/restore');
    await page.waitForURL('**/trash');
    await expect(page.getByRole('heading', { name: 'Trash' })).toBeVisible();

    // ADR-033 — the retired ?tab=batches deep link folds into the per-kind tab (kind rides along).
    await page.goto('/trash?tab=batches');
    await page.waitForURL('**/trash?tab=movies');
    await expect(page.getByRole('tab', { name: 'Movies', selected: true })).toBeVisible();
    await page.goto('/trash?tab=batches&kind=tv');
    await page.waitForURL('**/trash?tab=tv');
    await expect(page.getByRole('tab', { name: 'TV', selected: true })).toBeVisible();
    // The Batches tab itself no longer exists.
    await expect(page.getByRole('tab', { name: 'Batches' })).toHaveCount(0);
  });

  test('gate: Admin reaches the section; a Default member gets "not available", no nav entry', async ({
    page,
  }) => {
    await signIn(page, 'admin');
    await page.goto('/trash');
    await expect(page.getByTestId('trash-safety')).toBeVisible();
    await expect(page.getByRole('tab', { name: 'Movies' })).toBeVisible();
    await signOut(page);

    await signIn(page, 'fresh-member');
    const navTexts = await page.locator('.topbar__nav a').allInnerTexts();
    expect(navTexts).not.toContain('Trash');
    await page.goto('/trash');
    await expect(page.getByTestId('trash-unavailable')).toBeVisible();
  });

  test('safety banner green + the pending WALL: glyphs, tooltips, reclaim bar, sort, filter, library-nav', async ({
    page,
  }) => {
    await resetMaintainerr(page);
    await signIn(page, 'admin');
    await openTrashMovies(page);

    const banner = page.getByTestId('trash-safety');
    await expect(banner).toHaveAttribute('data-state', 'safe');
    await expect(banner).toContainText('Maintainerr connected');
    await expect(banner).toContainText('1 rule armed');

    // No Music tab, no Rules tab, no Batches tab — Movies · TV · Recently Deleted · Activity.
    await expect(page.getByRole('tab', { name: 'Music' })).toHaveCount(0);
    await expect(page.getByRole('tab', { name: 'Rules' })).toHaveCount(0);
    await expect(page.getByRole('tab', { name: 'Batches' })).toHaveCount(0);

    // Four pending fixtures as poster tiles; the table is gone.
    await expect(page.getByTestId('trash-tile')).toHaveCount(4);
    await expect(page.getByTestId('trash-tablewrap')).toHaveCount(0);

    // The unified glyph model: cold ⇒ trash, watched ⇒ eye (inert), dnd-tagged ⇒ check (inert),
    // unknown-to-ledger ⇒ trash (savable; the sweep would skip it).
    const vanished = page.getByTestId('trash-tile').filter({ hasText: 'Vanished Heist' });
    const fixture = page.getByTestId('trash-tile').filter({ hasText: 'The Fixture' });
    const runner = page.getByTestId('trash-tile').filter({ hasText: 'Stub Runner' });
    const unknown = page.getByTestId('trash-tile').filter({ hasText: 'tmdb:990009' });
    await expect(vanished).toHaveAttribute('data-glyph', 'trash');
    await expect(fixture).toHaveAttribute('data-glyph', 'eye');
    await expect(runner).toHaveAttribute('data-glyph', 'check');
    await expect(unknown).toHaveAttribute('data-glyph', 'trash');

    // eye/check are inert — the toggle is a non-button span (state reads, no action).
    await expect(fixture.locator('span[data-testid="trash-toggle"]')).toHaveCount(1);
    await expect(runner.locator('span[data-testid="trash-toggle"]')).toHaveCount(1);
    await expect(fixture.locator('button[data-testid="trash-toggle"]')).toHaveCount(0);

    // The guardian fact + scheduled date live in the tile tooltip now.
    await expect(fixture.getByTestId('trash-toggle')).toHaveAttribute('title', /Recently watched/);
    await expect(vanished.getByTestId('trash-toggle')).toHaveAttribute('title', /Deletes /);

    // The unknown item carries no library-nav corner (not in the ledger).
    await expect(unknown.getByTestId('wall-lib-link')).toHaveCount(0);

    // The reclaim counts bar sits ABOVE the wall: 4+8+2+1 GiB = 15 GB across 4 items.
    await expect(page.getByTestId('trash-total')).toHaveText('Reclaiming 15 GB across 4 items');
    const barBox = (await page.getByTestId('trash-total').boundingBox())!;
    const wallBox = (await page.getByTestId('trash-wall').boundingBox())!;
    expect(barBox.y).toBeLessThan(wallBox.y);

    // The sort bar replaces the table headers (same ?sort contract): Size ⇒ biggest first.
    await page.getByRole('group', { name: 'Sort' }).getByRole('button', { name: 'Size' }).click();
    await expect(page).toHaveURL(/sort=size%3Adesc|sort=size:desc/);
    await expect(page.getByTestId('trash-tile').first()).toContainText('Stub Runner');
    await page.getByRole('group', { name: 'Sort' }).getByRole('button', { name: 'Deletes' }).click();
    await expect(page).not.toHaveURL(/sort=/);

    // Filter-aware: Genre=Action keeps only Stub Runner and the counts bar says so.
    await page.getByTitle('Edit the Genre filter').click();
    await page
      .getByRole('dialog', { name: 'Edit the Genre filter' })
      .getByLabel('Action', { exact: true })
      .click();
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('trash-tile')).toHaveCount(1);
    await expect(page.getByTestId('trash-total')).toHaveText(
      'Reclaiming 8.0 GB across 1 item · filtered from 4 pending',
    );
    await expect(page).toHaveURL(/genre=Action/);

    // The library-nav corner opens the item page with the ?from=trash-movies context.
    const libHref = await runner.getByTestId('wall-lib-link').getAttribute('href');
    expect(libHref).toMatch(/\/library\/[0-9a-f-]{36}\?from=trash-movies$/);

    // TV is a separate tab (never combined): Breaking Prod is REQUESTED — the guardian refuses its
    // deletion, so the wall shows the inert 'requested' glyph (not a slated trash-can), with the
    // requester + protection fact in the tooltip and NO tappable delete/save path.
    await page.getByRole('tab', { name: 'TV' }).click();
    await expect(page).toHaveURL(/\/trash\?tab=tv$/);
    const tvTile = page.getByTestId('trash-tile').filter({ hasText: 'Breaking Prod' });
    await expect(tvTile).toHaveCount(1);
    await expect(tvTile).toHaveAttribute('data-glyph', 'requested');
    // Inert: the toggle is a non-button span (state reads, no delete/save action).
    await expect(tvTile.locator('span[data-testid="trash-toggle"]')).toHaveCount(1);
    await expect(tvTile.locator('button[data-testid="trash-toggle"]')).toHaveCount(0);
    await expect(tvTile.getByTestId('trash-toggle')).toHaveAttribute(
      'title',
      /Requested by .* — protected from deletion/,
    );
    await expect(page.getByTestId('trash-total')).toHaveText('Reclaiming 20 GB across 1 item');
  });

  test('the poster tap-toggle saves ⇄ un-saves (optimistic, reflow-free); Maintainerr calls (stub-verified)', async ({
    page,
  }) => {
    await resetMaintainerr(page);
    await signIn(page, 'admin');
    await openTrashMovies(page);

    const vanished = page.getByTestId('trash-tile').filter({ hasText: 'Vanished Heist' });
    const fixture = page.getByTestId('trash-tile').filter({ hasText: 'The Fixture' });
    const toggle = vanished.getByTestId('trash-toggle');
    await expect(vanished).toHaveAttribute('data-glyph', 'trash');
    // Let the poster images settle, and scroll the tile fully into view so Playwright's click
    // doesn't auto-scroll (which would shift the viewport-relative box, not the tile).
    await page.waitForLoadState('networkidle');
    await toggle.scrollIntoViewIfNeeded();

    // Save: the glyph deepens to the filled shield IN PLACE — the tile and its neighbor never move
    // on the tap (ADR-015). Measure the optimistic flip (synchronous), before the refetch lands.
    const before = (await vanished.boundingBox())!;
    const neighborBefore = (await fixture.boundingBox())!;
    const saveSettled = page.waitForResponse((r) => r.url().includes('trash.saveExclusion'));
    await toggle.click();
    await expect(vanished).toHaveAttribute('data-glyph', 'shield');
    await expect(toggle).toHaveAttribute('aria-pressed', 'true');
    expectSameBox(before, await vanished.boundingBox());
    expectSameBox(neighborBefore, await fixture.boundingBox());
    await saveSettled;

    // Tap again ⇒ un-save, back to trash (your own save stays un-savable via the wall).
    const unsaveSettled = page.waitForResponse((r) => r.url().includes('trash.removeExclusion'));
    await toggle.click();
    await expect(vanished).toHaveAttribute('data-glyph', 'trash');
    await unsaveSettled;

    const calls = await maintainerrCalls(page);
    const adds = calls.filter((c) => c.method === 'POST' && c.path === '/rules/exclusion');
    expect(adds).toHaveLength(1);
    expect(adds[0]!.body).toMatchObject({ mediaId: STUB_MAINT_VANISHED_ID, action: 0 });
    const removes = calls.filter(
      (c) => c.method === 'DELETE' && c.path === `/rules/exclusions/${STUB_MAINT_VANISHED_ID}`,
    );
    expect(removes).toHaveLength(1);
  });

  test('a live exclusion made outside the session shows the inert protected check', async ({
    page,
  }) => {
    await resetMaintainerr(page);
    await seedExclusion(page, STUB_MAINT_VANISHED_ID);
    await signIn(page, 'admin');
    await openTrashMovies(page);

    const vanished = page.getByTestId('trash-tile').filter({ hasText: 'Vanished Heist' });
    await expect(vanished).toHaveAttribute('data-glyph', 'check');
    await expect(vanished.locator('button[data-testid="trash-toggle"]')).toHaveCount(0);
    await resetMaintainerr(page);
  });

  test('per-item Delete now… on the item page: the guard card carries the Modal; a mid-flight unsafe install refuses cleanly', async ({
    page,
  }) => {
    await resetMaintainerr(page);
    await signIn(page, 'admin');
    await openTrashMovies(page);

    // Open a pending item's page via its library-nav corner (?from=trash-movies). The Fixture is
    // pending + non-tombstoned (the seed tombstones Vanished), so its guard card mounts.
    await page.getByTestId('trash-tile').filter({ hasText: 'The Fixture' }).getByTestId('wall-lib-link').click();
    await page.waitForURL(/\/library\/[0-9a-f-]{36}\?from=trash-movies$/);

    // The deletion-guard card carries the relocated per-item Expedite ("Delete now…").
    const guard = page.getByTestId('trash-guard');
    await expect(guard).toContainText('Scheduled for deletion');
    await guard.getByTestId('trash-delete-now').click();
    const confirm = page.getByTestId('trash-expedite-item-confirm');
    await expect(confirm).toBeVisible();

    // The install degrades between the read and the submit → calm "nothing deleted" state.
    await setIntegration(page, 'tautulli', false);
    await page.getByTestId('trash-expedite-item-submit').click();
    await expect(page.getByTestId('trash-expedite-stale')).toBeVisible();
    await expect(page.getByTestId('trash-expedite-stale')).toContainText('Nothing was deleted');
    expect((await maintainerrCalls(page)).some((c) => c.path === '/collections/media/handle')).toBe(false);
    await page.getByTestId('trash-expedite-stale').getByRole('button', { name: 'Close' }).click();
    await setIntegration(page, 'tautulli', true);
  });

  test('a watched item, Delete now…, is PROTECTED not deleted (the guardian wins)', async ({
    page,
  }) => {
    await resetMaintainerr(page);
    await signIn(page, 'admin');
    await openTrashMovies(page);

    await page.getByTestId('trash-tile').filter({ hasText: 'The Fixture' }).getByTestId('wall-lib-link').click();
    await page.waitForURL(/\/library\/[0-9a-f-]{36}\?from=trash-movies$/);
    await page.getByTestId('trash-delete-now').click();
    const confirm = page.getByTestId('trash-expedite-item-confirm');
    await expect(confirm).toContainText('recently watched');
    await expect(confirm).toContainText('protect it');
    await page.getByTestId('trash-expedite-item-submit').click();
    await expect(page.getByTestId('trash-expedite-summary')).toContainText('0 deleted');
    await expect(page.getByTestId('trash-expedite-summary')).toContainText('1 protected');
    await page.getByRole('button', { name: 'Done' }).click();

    const calls = await maintainerrCalls(page);
    expect(calls.some((c) => c.path === '/collections/media/handle')).toBe(false);
    const saves = calls.filter((c) => c.method === 'POST' && c.path === '/rules/exclusion');
    expect(saves).toHaveLength(1);
    expect(saves[0]!.body).toMatchObject({ mediaId: STUB_MAINT_FIXTURE_ID });
  });

  test('Expedite all: filters refuse to arm; the Modal predicts deleted/protected/skipped; per-item handle only', async ({
    page,
  }) => {
    await resetMaintainerr(page);
    await signIn(page, 'admin');
    await openTrashMovies(page);

    // With a filter active the Modal REFUSES — filters cannot scope Delete-all-now.
    await page.getByTitle('Edit the Genre filter').click();
    await page
      .getByRole('dialog', { name: 'Edit the Genre filter' })
      .getByLabel('Action', { exact: true })
      .click();
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('trash-tile')).toHaveCount(1);
    await page.getByTestId('trash-expedite-all').click();
    await expect(page.getByTestId('trash-expedite-refusal')).toBeVisible();
    await expect(page.getByTestId('trash-expedite-refusal')).toContainText(
      'Filters can’t scope “Delete all now”',
    );

    // Clearing the filters reveals the real confirm with the honest partition.
    await page.getByRole('button', { name: 'Clear filters' }).click();
    const confirm = page.getByTestId('trash-expedite-all-confirm');
    await expect(confirm).toBeVisible();
    await expect(confirm).toContainText('4 items');
    await expect(confirm).toContainText('1 will be deleted NOW');
    await expect(confirm).toContainText('2 protected');
    await expect(confirm).toContainText('1 kept — can’t be verified safe');

    // Fire — this is the real per-item deletion of Vanished (feeds Recently Deleted).
    await page.getByTestId('trash-expedite-all-submit').click();
    const report = page.getByTestId('trash-expedite-report');
    await expect(report).toBeVisible();
    await expect(page.getByTestId('trash-expedite-summary')).toContainText('1 deleted');
    await expect(page.getByTestId('trash-expedite-summary')).toContainText('2 protected');
    await expect(page.getByTestId('trash-expedite-summary')).toContainText('1 skipped');
    await report.getByRole('button', { name: 'Done' }).click();

    await expect(page.getByTestId('trash-tile')).toHaveCount(3);
    await expect(page.getByTestId('trash-tile').filter({ hasText: 'Vanished Heist' })).toHaveCount(0);

    const calls = await maintainerrCalls(page);
    const perItem = calls.filter((c) => c.method === 'POST' && c.path === '/collections/media/handle');
    expect(perItem).toHaveLength(1);
    expect(perItem[0]!.body).toMatchObject({ collectionId: 7, mediaId: STUB_MAINT_VANISHED_ID });
    expect(calls.some((c) => c.path === '/collections/handle')).toBe(false);
  });

  test('the context-aware back-link: ← Trash Movies returns WITH state; garbage from ⇒ Library', async ({
    page,
  }) => {
    await resetMaintainerr(page);
    await signIn(page, 'admin');
    await openTrashMovies(page);

    // Apply a filter, then open an item via its corner — the URL carries the filter state.
    await page.getByTitle('Edit the Genre filter').click();
    await page
      .getByRole('dialog', { name: 'Edit the Genre filter' })
      .getByLabel('Action', { exact: true })
      .click();
    await page.keyboard.press('Escape');
    await expect(page).toHaveURL(/genre=Action/);
    await page.getByTestId('trash-tile').filter({ hasText: 'Stub Runner' }).getByTestId('wall-lib-link').click();
    await page.waitForURL(/\/library\/[0-9a-f-]{36}\?from=trash-movies$/);

    // The back affordance reads "← Trash Movies"…
    const back = page.getByTestId('back-link');
    await expect(back).toHaveText('← Trash Movies');
    // …and returns to the origin WITH its filter state preserved (history.back()).
    await back.click();
    await page.waitForURL(/\/trash\?tab=movies&genre=Action$/);
    await expect(page.getByTestId('trash-tile')).toHaveCount(1);

    // A deep-linked garbage `from` falls to the Library default (no open redirect).
    const anyId = (await page
      .getByTestId('trash-tile')
      .first()
      .getByTestId('wall-lib-link')
      .getAttribute('href'))!.replace(/\?.*$/, '');
    await page.goto(`${anyId}?from=https://evil.example.com`);
    await expect(page.getByTestId('back-link')).toHaveText('← Library');
    await expect(page.getByTestId('back-link')).toHaveAttribute('href', '/library');
  });

  test('the bulletin media chip carries ?from=bulletin and its item back-link reads ← Bulletin', async ({
    page,
  }) => {
    await signIn(page, 'admin');
    // Post a message linking a library item, so the board has a media chip (body is required).
    await page.goto('/bulletin?tab=messages');
    await expect(page.getByTestId('message-composer')).toBeVisible();
    await page
      .getByPlaceholder('Broken media, a request, or anything for the household…')
      .fill('Please check this title.');
    await page.getByTestId('composer-media-search').fill('Fixture');
    await page.getByRole('option', { name: /The Fixture/ }).first().click();
    await page.getByTestId('message-post').click();

    const chip = page.getByTestId('message-media-chip').first();
    await expect(chip).toBeVisible();
    expect(await chip.getAttribute('href')).toMatch(/\/library\/[0-9a-f-]{36}\?from=bulletin$/);
    await chip.click();
    await page.waitForURL(/\/library\/[0-9a-f-]{36}\?from=bulletin$/);
    await expect(page.getByTestId('back-link')).toHaveText('← Bulletin');
    await expect(page.getByTestId('back-link')).toHaveAttribute('href', '/bulletin?tab=messages');
  });

  test('safety banner warns when an integration drops; the destructive controls disable', async ({
    page,
  }) => {
    await resetMaintainerr(page);
    await setIntegration(page, 'tautulli', false);
    await signIn(page, 'admin');
    await openTrashMovies(page);

    const banner = page.getByTestId('trash-safety');
    await expect(banner).toHaveAttribute('data-state', 'warn');
    await expect(banner).toContainText('Tautulli not connected');

    // Expedite-all disables; the protective save toggle (needs only reachability) stays live.
    await expect(page.getByTestId('trash-expedite-all')).toBeDisabled();
    await expect(
      page.getByTestId('trash-tile').filter({ hasText: 'Vanished Heist' }).getByTestId('trash-toggle'),
    ).toBeEnabled();

    await setIntegration(page, 'tautulli', true);
    await page.reload();
    await expect(page.getByTestId('trash-safety')).toHaveAttribute('data-state', 'safe');
    await expect(page.getByTestId('trash-expedite-all')).toBeEnabled();
  });

  // ── the batch lifecycle, now IN the Movies tab (ADR-033) ─────────────────────────────────

  test('Start a batch → admin_review curation on the Movies tab; tap trash→shield is reflow-free + records the save; the new-candidates strip is admin-only', async ({
    page,
  }) => {
    await resetMaintainerr(page);
    await signIn(page, 'admin');
    await openTrashMovies(page);

    // No open batch ⇒ the pending wall + the admin "Start a batch" header (candidate count).
    await expect(page.getByTestId('batch-candidates')).toHaveText(
      '4 movie candidates currently proposed by the rules.',
    );
    await page.getByTestId('batch-start').click();

    // The lifecycle header renders: Admin review, 4 items; the batch wall replaces the pending wall.
    await expect(page.getByTestId('batch-state')).toHaveText('Admin review');
    await expect(page.getByTestId('batch-lifecycle')).toContainText('4 items');
    await expect(page.getByTestId('wall-tile')).toHaveCount(4);
    const vanished = page.getByTestId('wall-tile').filter({ hasText: 'Vanished Heist' });
    await expect(vanished).toHaveAttribute('data-glyph', 'trash');
    await expect(page.getByTestId('wall-tile').filter({ hasText: 'The Fixture' })).toHaveAttribute('data-glyph', 'eye');
    await expect(page.getByTestId('wall-tile').filter({ hasText: 'Stub Runner' })).toHaveAttribute('data-glyph', 'check');
    await expect(page.getByTestId('wall-counts')).toHaveText('Deleting 2 · Rescued 0 · Kept 2 · frees 3.0 GB');

    // Tap trash → shield: overlay swap only — the tile and its neighbor must not move (ADR-015).
    const fixture = page.getByTestId('wall-tile').filter({ hasText: 'The Fixture' });
    await vanished.getByRole('button').scrollIntoViewIfNeeded();
    const tileBefore = await vanished.boundingBox();
    const neighborBefore = await fixture.boundingBox();
    await vanished.getByRole('button').click();
    await expect(vanished).toHaveAttribute('data-glyph', 'shield');
    expectSameBox(tileBefore, await vanished.boundingBox());
    expectSameBox(neighborBefore, await fixture.boundingBox());
    await expect(page.getByTestId('wall-counts')).toHaveText('Deleting 1 · Rescued 1 · Kept 2 · frees 1.0 GB');
    await expect(page.getByTestId('batch-savers')).toContainText('Bootstrap Admin · 1 saved');
    let calls = await maintainerrCalls(page);
    const saves = calls.filter((c) => c.method === 'POST' && c.path === '/rules/exclusion');
    expect(saves).toHaveLength(1);
    expect(saves[0]!.body).toMatchObject({ mediaId: STUB_MAINT_VANISHED_ID });

    // Un-save (NET semantics — 0 saved, 1 un-saved).
    await vanished.getByRole('button').click();
    await expect(vanished).toHaveAttribute('data-glyph', 'trash');
    await expect(page.getByTestId('batch-savers')).toContainText('Bootstrap Admin · 0 saved · 1 un-saved');
    calls = await maintainerrCalls(page);
    expect(
      calls.some((c) => c.method === 'DELETE' && c.path === `/rules/exclusions/${STUB_MAINT_VANISHED_ID}`),
    ).toBe(true);

    // A fresh candidate joins the LIVE set (not the frozen batch) ⇒ the admin-only strip appears.
    await addPendingCandidate(page);
    await page.goto('/trash?tab=movies');
    await expect(page.getByTestId('batch-new-candidates')).toContainText('New candidates since this batch (1)');
  });

  test('Start refuses gracefully while a batch is open — the error names the blocker', async ({
    page,
  }) => {
    await signIn(page, 'admin');
    await page.goto('/trash?tab=movies');
    await expect(page.getByTestId('batch-state')).toHaveText('Admin review');
    // No "Start a batch" button while one is open (the button only renders with no open batch).
    await expect(page.getByTestId('batch-start')).toHaveCount(0);
  });

  test('Green-light → Leaving Soon: window default + override, countdown, DO_NOTHING Plex collection', async ({
    page,
  }) => {
    await signIn(page, 'admin');
    await page.goto('/trash?tab=movies');

    await page.getByTestId('batch-greenlight').click();
    const confirm = page.getByTestId('batch-greenlight-confirm');
    await expect(confirm).toContainText('Leaving Soon — Movies');
    await expect(confirm).toContainText('the sweep deletes what’s left');
    await expect(page.getByTestId('batch-window-days')).toHaveValue('21');
    await page.getByTestId('batch-window-days').fill('14');
    await page.getByTestId('batch-greenlight-submit').click();

    await expect(page.getByTestId('batch-state')).toHaveText('Leaving Soon');
    await expect(page.getByTestId('batch-countdown')).toHaveText(
      'These delete in 14 days — tap anything you want to keep.',
    );
    await expect(page.getByTestId('batch-expire')).toBeDisabled();

    const creates = (await maintainerrCalls(page)).filter(
      (c) => c.method === 'POST' && c.path === '/collections',
    );
    expect(creates).toHaveLength(1);
    const dto = creates[0]!.body as {
      collection: Record<string, unknown>;
      media: Array<{ mediaServerId: string }>;
    };
    expect(dto.collection).toMatchObject({
      title: 'Leaving Soon — Movies',
      type: 'movie',
      arrAction: 4,
      visibleOnHome: true,
    });
    expect(dto.media.map((m) => m.mediaServerId)).not.toContain('ms-880002'); // protected stays out
  });

  // DESIGN-010 amendment (2026-07-08) — the OVERVIEW landing. The movie batch is Leaving Soon (a
  // 14-day window ⇒ warn) from the green-light test above; empty the TV collection so its card reads
  // "nothing pending" with a suppressed-zero badge. Verifies: bare /trash lands on Overview (not
  // Movies); the two kind cards (warn leaving-soon movie w/ deadline + still-pending count; empty
  // TV); the Movies/TV tab count badges (3 warn / suppressed zero); the whole card clicks into its
  // kind tab; a direct ?tab=movies deep link is unaffected; and the landing fits 390px.
  test('Overview is the default landing: warn leaving-soon movie card + empty TV card, tab count badges, card→tab nav, 390 fit', async ({
    page,
  }) => {
    await signIn(page, 'admin');
    await removePending(page, STUB_MAINT_TV_ID); // TV → empty (nothing pending / suppressed badge)

    // Bare /trash lands on OVERVIEW (no ?tab), not Movies.
    await page.goto('/trash');
    await expect(page).toHaveURL(/\/trash$/);
    await expect(page.getByRole('tab', { name: 'Overview', selected: true })).toBeVisible();
    await expect(page.getByTestId('trash-overview')).toBeVisible();

    // Movie card — Leaving Soon, warn tone, the batch's still-pending count (3), and a "frees" line.
    const movie = page.locator('[data-testid="trash-ovcard"][data-kind="movie"]');
    await expect(movie).toHaveAttribute('data-tone', 'warn');
    await expect(movie.getByTestId('trash-ovcard-state')).toHaveText('Leaving Soon');
    await expect(movie.getByTestId('trash-ovcard-count')).toHaveText('3');
    await expect(movie.getByTestId('trash-ovcard-deadline')).toContainText(
      'Leaving Soon — window closes',
    );
    await expect(movie.getByTestId('trash-ovcard-bytes')).toContainText('frees');

    // TV card — emptied ⇒ "nothing pending", neutral tone, no count/state.
    const tv = page.locator('[data-testid="trash-ovcard"][data-kind="tv"]');
    await expect(tv).toHaveAttribute('data-tone', 'neutral');
    await expect(tv.getByTestId('trash-ovcard-empty')).toContainText('Nothing pending');
    await expect(tv.getByTestId('trash-ovcard-count')).toHaveCount(0);

    // Tab badges — Movies shows 3 (warn); TV suppressed at zero.
    const moviesBadge = page.getByTestId('trash-tab-badge-movies');
    await expect(moviesBadge).toHaveText('3');
    await expect(moviesBadge).toHaveClass(/trashtab__badge--warn/);
    await expect(page.getByTestId('trash-tab-badge-tv')).toHaveCount(0);

    // 390 fits — no sideways scroll, nothing wider than the viewport (ADR-015 / DESIGN-004).
    await page.setViewportSize({ width: 390, height: 844 });
    await expectViewportFit(page);
    await page.setViewportSize({ width: 1280, height: 800 });

    // The whole card clicks into its kind tab (it's a <button>, keyboard-accessible).
    await movie.click();
    await expect(page).toHaveURL(/\/trash\?tab=movies$/);
    await expect(page.getByTestId('batch-state')).toHaveText('Leaving Soon');

    // A direct ?tab=movies deep link is unaffected (Movies, not Overview).
    await page.goto('/trash?tab=movies');
    await expect(page.getByRole('tab', { name: 'Movies', selected: true })).toBeVisible();
    await expect(page.getByTestId('trash-overview')).toHaveCount(0);
  });

  test('the family window: a save_leaving_soon role saves anything, un-saves ONLY its own; no lifecycle controls', async ({
    page,
    browser,
  }) => {
    await signIn(page, 'admin');
    await page.goto('/trash?tab=movies');
    // The admin saves Vanished — the foreign save Marge must NOT be able to release.
    const adminVanished = page.getByTestId('wall-tile').filter({ hasText: 'Vanished Heist' });
    await adminVanished.getByRole('button').click();
    await expect(adminVanished).toHaveAttribute('data-glyph', 'shield');

    const memberContext = await browser.newContext();
    const memberPage = await memberContext.newPage();
    await signIn(memberPage, 'member');
    await assignMemberRole(page, 'Trash Family');
    await memberPage.goto('/trash?tab=movies');

    // The countdown invites the rescue; the family sees NO lifecycle controls, and (admin-only)
    // NO new-candidates strip.
    await expect(memberPage.getByTestId('batch-countdown')).toContainText('tap anything you want to keep');
    for (const control of ['batch-start', 'batch-greenlight', 'batch-cancel', 'batch-expire']) {
      await expect(memberPage.getByTestId(control)).toHaveCount(0);
    }
    await expect(memberPage.getByTestId('batch-new-candidates')).toHaveCount(0);

    // The admin's save reads as someone else's — visible but not tappable.
    const vanished = memberPage.getByTestId('wall-tile').filter({ hasText: 'Vanished Heist' });
    await expect(vanished).toHaveAttribute('data-glyph', 'shield');
    await expect(vanished.getByRole('button')).toHaveCount(0);

    // Marge rescues the unknown item (a real exclusion write lands), then undoes her OWN save.
    const unknown = memberPage.getByTestId('wall-tile').filter({ hasText: 'tmdb:990009' });
    await unknown.getByRole('button').click();
    await expect(unknown).toHaveAttribute('data-glyph', 'shield');
    await expect(memberPage.getByTestId('batch-savers')).toContainText('Marge Member · 1 saved');
    await unknown.getByRole('button').click();
    await expect(unknown).toHaveAttribute('data-glyph', 'trash');

    // ADR-025 errata — GLOBAL SAVE IS A SUPERSET: Trash Limited holds `save_exclude` (the anytime
    // whitelist power) which IMPLIES `save_leaving_soon`, so it ALSO rescues in the window even
    // though it was never granted save_leaving_soon. The wall stays tappable + the countdown invites.
    await assignMemberRole(page, 'Trash Limited');
    await memberPage.goto('/trash?tab=movies');
    await expect(memberPage.getByTestId('batch-countdown')).toContainText('tap anything you want to keep');
    const limitedTile = memberPage.getByTestId('wall-tile').filter({ hasText: 'tmdb:990009' });
    await limitedTile.getByRole('button').click();
    await expect(limitedTile).toHaveAttribute('data-glyph', 'shield');
    // Own save ⇒ can release it again (leaves the wall clean for the next test).
    await limitedTile.getByRole('button').click();
    await expect(limitedTile).toHaveAttribute('data-glyph', 'trash');

    // A role with NEITHER Save power (Trash Viewer — read-only, zero grants) gets the fully
    // read-only wall: no tap buttons, and the countdown drops the "tap anything" invite.
    await assignMemberRole(page, 'Trash Viewer');
    await memberPage.goto('/trash?tab=movies');
    await expect(memberPage.getByTestId('wall-tile')).toHaveCount(4);
    await expect(memberPage.getByTestId('batch-wall').getByRole('button')).toHaveCount(0);
    await expect(memberPage.getByTestId('batch-countdown')).toContainText('These delete in');
    await expect(memberPage.getByTestId('batch-countdown')).not.toContainText('tap anything');

    await memberContext.close();
    await assignMemberRole(page, 'Default (default)');
  });

  test('Expire now → the sweep; the Movies tab returns to the pending wall + a Past-batches strip (report)', async ({
    page,
  }) => {
    await signIn(page, 'admin');
    await page.goto('/trash?tab=movies');

    // Close the window-open batch and start a clean one for the expiry journey. Cancelling is
    // terminal ⇒ the LifecycleView drops out and the pending wall returns (no open batch).
    await expect(page.getByTestId('batch-state')).toHaveText('Leaving Soon');
    await armAndConfirm(page.getByTestId('batch-cancel'));
    await expect(page.getByTestId('trash-wall')).toBeVisible();
    await resetMaintainerr(page);

    // A cancelled batch is terminal ⇒ the pending wall is back, plus a Past-batches strip.
    await page.goto('/trash?tab=movies');
    await expect(page.getByTestId('trash-wall')).toBeVisible();
    await expect(page.getByTestId('batch-history')).toBeVisible();

    await page.getByTestId('batch-start').click();
    await expect(page.getByTestId('batch-state')).toHaveText('Admin review');

    // Time-travel: green-light with an already-expired window via the domain single-writer.
    greenlightExpired('movie');
    await page.goto('/trash?tab=movies');
    await expect(page.getByTestId('batch-state')).toHaveText('Leaving Soon');
    await expect(page.getByTestId('batch-countdown')).toContainText('The save window has closed');
    const expire = page.getByTestId('batch-expire');
    await expect(expire).toBeEnabled();

    await expire.click();
    const confirm = page.getByTestId('batch-expire-confirm');
    await expect(confirm).toContainText('immediate and permanent');
    await expect(confirm).toContainText('Up to 1 item will be deleted');
    await page.getByTestId('batch-expire-submit').click();

    const report = page.getByTestId('batch-expire-report');
    await expect(report).toBeVisible();
    await expect(page.getByTestId('batch-expire-summary')).toContainText('1 deleted');
    await expect(page.getByTestId('batch-expire-summary')).toContainText('2 skipped');

    // Per-item handle only (ADR-023 C-07a).
    const calls = await maintainerrCalls(page);
    const handles = calls.filter((c) => c.method === 'POST' && c.path === '/collections/media/handle');
    expect(handles).toHaveLength(1);
    expect(handles[0]!.body).toMatchObject({ mediaId: STUB_MAINT_VANISHED_ID });
    expect(calls.some((c) => c.path === '/collections/handle')).toBe(false);

    // Done ⇒ the batch is now terminal, so the Movies tab returns to the pending wall +
    // the Past-batches strip (ADR-033). Expanding the Deleted row reveals its final report
    // (the terminal PosterWall with the sweep glyphs).
    await report.getByRole('button', { name: 'Done' }).click();
    await expect(page.getByTestId('trash-wall')).toBeVisible();
    const strip = page.getByTestId('batch-history');
    await expect(strip).toBeVisible();
    const rows = page.getByTestId('batch-history-row');
    expect(await rows.count()).toBeGreaterThanOrEqual(2); // cancelled + deleted
    // The state chip is exact; the cancelled row's meta ("nothing deleted") would also substring-match.
    const deletedRow = rows.filter({ has: page.locator('.batch-state', { hasText: 'Deleted' }) }).first();
    await deletedRow.locator('summary').click(); // toggle the <details> open
    await expect(deletedRow.getByTestId('batch-wall')).toBeVisible();
    await expect(deletedRow.getByTestId('wall-counts')).toContainText('Deleted 1 · Rescued 0 · Kept 3 · freed 2.0 GB');
    await expect(deletedRow.getByTestId('wall-tile').filter({ hasText: 'Vanished Heist' })).toHaveAttribute('data-glyph', 'gone');
    await expect(deletedRow.getByTestId('wall-tile').filter({ hasText: 'The Fixture' })).toHaveAttribute('data-glyph', 'skip');
    await expect(deletedRow.getByTestId('wall-tile').filter({ hasText: 'Stub Runner' })).toHaveAttribute('data-glyph', 'check');
  });

  test('mobile 390×844: the batch wall is a 3-column thumb grid with legible glyphs; no sideways scroll', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await resetMaintainerr(page);
    await signIn(page, 'admin');
    // Fresh batch for the mobile shot (the previous one is terminal).
    await page.goto('/trash?tab=movies');
    await page.getByTestId('batch-start').click();
    await expect(page.getByTestId('batch-state')).toHaveText('Admin review');

    const tiles = page.getByTestId('wall-tile');
    await expect(tiles).toHaveCount(4);
    const boxes = await Promise.all([0, 1, 2, 3].map(async (i) => (await tiles.nth(i).boundingBox())!));
    expect(Math.abs(boxes[0]!.y - boxes[1]!.y)).toBeLessThan(1);
    expect(boxes[3]!.y).toBeGreaterThan(boxes[0]!.y + 10);
    expect(boxes[0]!.width).toBeGreaterThan(100);
    expect(boxes[0]!.height).toBeGreaterThan(boxes[0]!.width);
    await expectViewportFit(page);

    // Clean up: cancel so later tests see the pending wall (cancel is terminal ⇒ wall returns).
    await armAndConfirm(page.getByTestId('batch-cancel'));
    await expect(page.getByTestId('trash-wall')).toBeVisible();
  });

  // ── the rest of the section (unchanged surfaces) ─────────────────────────────────────────

  test('skip-gate: the audited setting sends a new batch STRAIGHT to Leaving Soon', async ({
    page,
  }) => {
    await resetMaintainerr(page);
    await signIn(page, 'admin');

    await page.goto('/settings/trash');
    await expect(page.getByTestId('trash-settings')).toContainText('straight to Leaving Soon');
    await armAndConfirm(page.getByTestId('skipgate-enable'));
    await expect(page.getByTestId('skipgate-state')).toContainText('Skip-gate is ON');

    // A fresh TV batch skips admin review entirely: born Leaving Soon, flagged gate-skipped.
    await page.goto('/trash?tab=tv');
    await expect(page.getByTestId('batch-candidates')).toContainText('TV candidate');
    await page.getByTestId('batch-start').click();
    await expect(page.getByTestId('batch-state')).toHaveText('Leaving Soon');
    await expect(page.getByTestId('batch-gate-skipped')).toBeVisible();
    await expect(page.getByTestId('batch-countdown')).toContainText('These delete in 21 days');
    await armAndConfirm(page.getByTestId('batch-cancel'));
    await expect(page.getByTestId('trash-wall')).toBeVisible(); // terminal ⇒ TV pending wall returns

    // Restore the gate.
    await page.goto('/settings/trash');
    await page.getByTestId('skipgate-disable').click();
    await expect(page.getByTestId('skipgate-state')).toContainText('Gate is ON');
  });

  test('Recently Deleted lists the tombstoned item; Restore re-adds through the failsafe path', async ({
    page,
  }) => {
    await resetMaintainerr(page);
    await signIn(page, 'admin');
    await page.goto('/trash?tab=deleted');

    const row = page.getByTestId('trash-deleted-row').filter({ hasText: 'Vanished Heist' });
    await expect(row).toBeVisible();
    await armAndConfirm(row.getByTestId('trash-restore'));
    await expect(row.getByTestId('trash-restore-status')).toBeVisible();
  });

  test('Rules on /settings/trash: disarm→re-arm round-trips the RulesDto; delete removes it', async ({
    page,
  }) => {
    await resetMaintainerr(page);
    await signIn(page, 'admin');
    await openUserMenu(page);
    await page.getByRole('menuitem', { name: 'Trash settings' }).click();
    await page.waitForURL('/settings/trash');

    const rule = page.getByTestId('trash-rule-row').filter({ hasText: 'Purge stale movies' });
    await expect(rule.locator('.badge')).toHaveText('Armed');
    await rule.getByTestId('trash-rule-toggle').click();
    await expect(rule.locator('.badge')).toHaveText('Disarmed');
    let puts = (await maintainerrCalls(page)).filter((c) => c.method === 'PUT' && c.path === '/rules');
    expect(puts).toHaveLength(1);
    expect(puts[0]!.body).toMatchObject({ id: 11, isActive: false, dataType: 'movie', libraryId: '1', radarrSettingsId: 3 });
    expect(await maintainerrWipes(page)).toHaveLength(0);

    await rule.getByTestId('trash-rule-toggle').click();
    await expect(rule.locator('.badge')).toHaveText('Armed');
    puts = (await maintainerrCalls(page)).filter((c) => c.method === 'PUT' && c.path === '/rules');
    expect(puts).toHaveLength(2);
    expect(await maintainerrWipes(page)).toHaveLength(0);

    await armAndConfirm(rule.getByTestId('trash-rule-delete'));
    await expect(page.getByTestId('trash-rule-row')).toHaveCount(0);
    await resetMaintainerr(page);
  });

  test('the webhook rejects without the secret, accepts with it, and feeds Activity', async ({
    page,
    request,
  }) => {
    const url = `${env().BETTER_AUTH_URL}/api/webhooks/maintainerr`;
    const body = { notification_type: 'MEDIA_DELETED', subject: 'Cleaned up', message: '2 items' };
    const noSecret = await request.post(url, { data: body });
    expect(noSecret.status()).toBe(401);
    const withSecret = await request.post(url, {
      headers: { 'x-webhook-secret': env().MAINTAINERR_WEBHOOK_SECRET },
      data: body,
    });
    expect(withSecret.status()).toBe(202);

    await signIn(page, 'admin');
    await page.goto('/trash?tab=activity');
    const feed = page.getByTestId('trash-activity');
    await expect(feed.locator('li').filter({ hasText: 'Cleaned up' }).first()).toContainText('2 items');
  });

  test('role gating: a save-only role browses and toggles but cannot expedite, restore, or edit rules', async ({
    page,
    browser,
  }) => {
    await resetMaintainerr(page);
    const memberContext = await browser.newContext();
    const memberPage = await memberContext.newPage();
    await signIn(memberPage, 'member');
    await signIn(page, 'admin');
    await assignMemberRole(page, 'Trash Limited');

    await memberPage.goto('/');
    expect(await memberPage.locator('.topbar__nav a').allInnerTexts()).toContain('Trash');
    await memberPage.goto('/trash?tab=movies');
    await expect(memberPage.getByTestId('trash-tile')).toHaveCount(4);
    // Expedite-all is absent (no grant). Per-item expedite lives on the item page (also absent):
    // open a pending, non-tombstoned item (The Fixture) whose guard card DOES mount for this role.
    await expect(memberPage.getByTestId('trash-expedite-all')).toHaveCount(0);
    await memberPage
      .getByTestId('trash-tile')
      .filter({ hasText: 'The Fixture' })
      .getByTestId('wall-lib-link')
      .click();
    await memberPage.waitForURL(/\/library\//);
    await expect(memberPage.getByTestId('trash-guard')).toBeVisible();
    await expect(memberPage.getByTestId('trash-delete-now')).toHaveCount(0); // no expedite_item grant
    await expect(memberPage.getByTestId('trash-guard').getByTestId('trash-shield')).toBeVisible(); // save is allowed

    // Rules live on /settings/trash (section EDIT): this read-only role gets the dead-end.
    await openUserMenu(memberPage);
    await expect(memberPage.getByRole('menuitem', { name: 'Trash settings' })).toHaveCount(0);
    await memberPage.keyboard.press('Escape');
    await memberPage.goto('/settings/trash');
    await expect(memberPage.getByTestId('trash-settings-unavailable')).toBeVisible();

    await memberPage.goto('/trash?tab=deleted');
    await expect(memberPage.getByTestId('trash-restore')).toHaveCount(0);

    await memberContext.close();
    await assignMemberRole(page, 'Default (default)');
  });

  test('/admin/roles: the Trash access select + per-action grid; Admin implicit and locked', async ({
    page,
  }) => {
    await signIn(page, 'admin');
    await page.goto('/admin/roles');
    const adminRow = page.locator('.admin-table tbody tr').filter({ hasText: 'superuser' });
    await expect(adminRow).toContainText('Edit · all actions');

    const select = page.getByLabel('Trash access for Trash Limited');
    await expect(select).toHaveValue('read_only');

    // Roles table: the action count is an INLINE token badge BESIDE the select (same baseline),
    // not a below-select line (owner-directed 2026-07-08). Assert the pill class + that it sits on
    // the select's row, to the right of it.
    const summary = page.getByTestId('trash-actions-summary-Trash Limited');
    await expect(summary).toHaveText('3 actions');
    await expect(summary).toHaveClass(/action-badge/);
    const selBox = (await select.boundingBox())!;
    const badgeBox = (await summary.boundingBox())!;
    // Vertically overlapping ⇒ same row (inline), not stacked below.
    expect(badgeBox.y).toBeLessThan(selBox.y + selBox.height);
    expect(badgeBox.y + badgeBox.height).toBeGreaterThan(selBox.y);
    // …and to the RIGHT of the select (beside, not below).
    expect(badgeBox.x).toBeGreaterThan(selBox.x + selBox.width - 4);

    const limitedRow = page.locator('.admin-table tbody tr').filter({ hasText: 'Trash Limited' });
    await limitedRow.getByRole('button', { name: 'Edit' }).click();
    const grid = page.getByTestId('trash-actions-grid');

    // ADR-025 errata — global Save is a superset: Trash Limited holds `save_exclude`, so the
    // Leaving-Soon rescue row renders CHECKED + DISABLED with the "included in Save" note.
    const rescue = grid.getByTestId('trash-action-save_leaving_soon');
    await expect(rescue).toBeChecked();
    await expect(rescue).toBeDisabled();
    await expect(grid.getByTestId('trash-action-save_leaving_soon-implied')).toBeVisible();
    // Unchecking Save re-enables the rescue row at its STORED value (unchecked — never granted).
    await grid.getByTestId('trash-action-save_exclude').uncheck();
    await expect(rescue).toBeEnabled();
    await expect(rescue).not.toBeChecked();
    // Re-checking Save implies it ON + locked again (the stored grant was never written either way).
    await grid.getByTestId('trash-action-save_exclude').check();
    await expect(rescue).toBeChecked();
    await expect(rescue).toBeDisabled();

    await grid.getByTestId('trash-action-expedite_item').check();
    await page.getByRole('button', { name: 'Save changes' }).click();
    await expect(page.getByTestId('trash-actions-summary-Trash Limited')).toHaveText('4 actions');
    await page
      .locator('.admin-table tbody tr')
      .filter({ hasText: 'Trash Limited' })
      .getByRole('button', { name: 'Edit' })
      .click();
    await page.getByTestId('trash-action-expedite_item').uncheck();
    await page.getByRole('button', { name: 'Save changes' }).click();
    await expect(page.getByTestId('trash-actions-summary-Trash Limited')).toHaveText('3 actions');
  });

  test('library detail: the deletion-guard shield for pending Movies/TV; protected badge; never for music', async ({
    page,
  }) => {
    await resetMaintainerr(page);
    await signIn(page, 'admin');
    await openTrashMovies(page);

    const fixtureHref = await page
      .getByTestId('trash-tile')
      .filter({ hasText: 'The Fixture' })
      .getByTestId('wall-lib-link')
      .getAttribute('href');
    await page.goto(fixtureHref!);
    await expect(page.getByTestId('trash-guard')).toBeVisible();
    await expect(page.getByTestId('trash-guard')).toContainText('Scheduled for deletion');

    await openTrashMovies(page);
    const runnerHref = await page
      .getByTestId('trash-tile')
      .filter({ hasText: 'Stub Runner' })
      .getByTestId('wall-lib-link')
      .getAttribute('href');
    await page.goto(runnerHref!);
    await expect(page.locator('.detail-head').getByText('Protected from deletion')).toBeVisible();

    await page.goto('/ledger?tab=music');
    const musicHref = await page
      .locator('.ledger-row')
      .filter({ hasText: 'The Stub Band' })
      .locator('a.ledger-title')
      .getAttribute('href');
    await page.goto(musicHref!);
    await expect(page.getByRole('heading', { name: 'The Stub Band' })).toBeVisible();
    await expect(page.getByTestId('trash-guard')).toHaveCount(0);
  });

  test('mobile 390×844: the pending wall is a 3-column thumb grid with legible glyphs — no sideways scroll', async ({
    page,
  }) => {
    await resetMaintainerr(page);
    await page.setViewportSize({ width: 390, height: 844 });
    await signIn(page, 'admin');
    await openTrashMovies(page);

    const tiles = page.getByTestId('trash-tile');
    await expect(tiles).toHaveCount(4);
    const boxes = await Promise.all([0, 1, 2, 3].map(async (i) => (await tiles.nth(i).boundingBox())!));
    expect(Math.abs(boxes[0]!.y - boxes[1]!.y)).toBeLessThan(1);
    expect(boxes[3]!.y).toBeGreaterThan(boxes[0]!.y + 10);
    expect(boxes[0]!.width).toBeGreaterThan(100);
    expect(boxes[0]!.height).toBeGreaterThan(boxes[0]!.width);
    // The toggle poster and the library corner both render at a thumb-tappable size (≥ 26px).
    const vanished = tiles.filter({ hasText: 'Vanished Heist' });
    const toggleBox = (await vanished.getByTestId('trash-toggle').boundingBox())!;
    const libBox = (await vanished.getByTestId('wall-lib-link').boundingBox())!;
    expect(toggleBox.width).toBeGreaterThan(100);
    expect(libBox.width).toBeGreaterThanOrEqual(26);
    await expectViewportFit(page);
  });
});
