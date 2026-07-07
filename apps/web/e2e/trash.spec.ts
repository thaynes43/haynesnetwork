// ADR-023 / DESIGN-010 end to end — the Trash section, the app's ONLY user-facing deletion
// surface: the safety banner (safe / integration-down states, destructive controls disabling),
// the Movies/TV pending tables (badges + the filter-aware reclaim footer), Save → protected →
// un-save through the shield (stub-verified exclusion calls), the Expedite Modal with its
// deleted / protected / skipped partition (per-item /collections/media/handle calls ONLY —
// the estate-wide /collections/handle must be ABSENT, C-07a), the stale "no longer safe"
// refusal, Recently-Deleted → Restore, the Rules list (arm/disarm/delete), the Activity feed,
// the /admin/roles per-action grid, and role gating (disabled ⇒ no nav; a save-only role can't
// expedite; edit_rules needs section Edit). Plus the retired /admin/restore → /trash redirect
// and the webhook receiver. Serial — the suite shares one stack and the stub's mutable state.
import { test, expect, type Page } from '@playwright/test';
import { armAndConfirm, expectViewportFit, signIn, signOut } from './support/helpers';
import { readRuntimeEnv } from './support/env';
import {
  STUB_MAINT_FIXTURE_ID,
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

/** Crucial-change wipes the stub would have enacted (a correct isActive toggle produces none). */
async function maintainerrWipes(page: Page): Promise<unknown[]> {
  const res = await page.request.get(`${env().STUB_MAINTAINERR_URL}/_stub/wipes`);
  return ((await res.json()) as { wipes: unknown[] }).wipes;
}

async function setIntegration(page: Page, name: string, connected: boolean): Promise<void> {
  await page.request.post(`${env().STUB_MAINTAINERR_URL}/_stub/integrations`, {
    data: { name, connected },
  });
}

/** Pre-seed a live Maintainerr exclusion (outside the app's save flow) — its `dnd` tag has NOT synced. */
async function seedExclusion(page: Page, mediaServerId: string): Promise<void> {
  await page.request.post(`${env().STUB_MAINTAINERR_URL}/_stub/exclude`, { data: { mediaServerId } });
}

async function openTrashMovies(page: Page): Promise<void> {
  await page.goto('/trash');
  await expect(page.getByTestId('trash-row').filter({ hasText: 'Vanished Heist' })).toHaveCount(1);
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

test.describe('trash section (DESIGN-010)', () => {
  test.describe.configure({ mode: 'serial' });

  test('the Admin → Restore nav item is gone and /admin/restore redirects to /trash', async ({
    page,
  }) => {
    await signIn(page, 'admin');
    await page.goto('/admin');
    await expect(page.locator('.admin-nav').getByRole('link', { name: 'Restore' })).toHaveCount(0);
    await page.goto('/admin/restore');
    await page.waitForURL('**/trash');
    await expect(page.getByRole('heading', { name: 'Trash' })).toBeVisible();
  });

  test('gate: Admin reaches the section; a Default member gets "not available", no nav entry', async ({
    page,
  }) => {
    await signIn(page, 'admin');
    await page.goto('/trash');
    await expect(page.getByTestId('trash-safety')).toBeVisible();
    await expect(page.getByRole('tab', { name: 'Movies' })).toBeVisible();
    await signOut(page);

    // A plain member's Default role has Trash Disabled → no nav entry, and the direct URL
    // renders the friendly dead-end, never a raw 403.
    await signIn(page, 'fresh-member');
    const navTexts = await page.locator('.topbar__nav a').allInnerTexts();
    expect(navTexts).not.toContain('Trash');
    await page.goto('/trash');
    await expect(page.getByTestId('trash-unavailable')).toBeVisible();
  });

  test('safety banner is green when SAFE; Movies/TV pending tables show badges + the reclaim footer', async ({
    page,
  }) => {
    await resetMaintainerr(page);
    await signIn(page, 'admin');
    await openTrashMovies(page);

    // The banner reads SAFE with the audit facts (D-04).
    const banner = page.getByTestId('trash-safety');
    await expect(banner).toHaveAttribute('data-state', 'safe');
    await expect(banner).toContainText('Maintainerr connected');
    await expect(banner).toContainText('1 rule armed');

    // No Music tab exists — music is structurally undeletable (R-87).
    await expect(page.getByRole('tab', { name: 'Music' })).toHaveCount(0);

    // Movies: all four pending fixtures, each with its guardian badge.
    await expect(page.getByTestId('trash-row')).toHaveCount(4);
    const fixture = page.getByTestId('trash-row').filter({ hasText: 'The Fixture' });
    await expect(fixture.getByTestId('badge-watched')).toBeVisible();
    const runner = page.getByTestId('trash-row').filter({ hasText: 'Stub Runner' });
    await expect(runner.getByTestId('badge-protected')).toBeVisible();
    const unknown = page.getByTestId('trash-row').filter({ hasText: 'tmdb:990009' });
    await expect(unknown.getByTestId('badge-unverified')).toBeVisible();
    const vanished = page.getByTestId('trash-row').filter({ hasText: 'Vanished Heist' });
    await expect(vanished.locator('.badge')).toHaveCount(0); // cold — no protection badge

    // Scheduled-delete column: a date plus the days-left pill.
    await expect(vanished.locator('.trash-days')).toBeVisible();

    // Ledger-joined titles link to the library detail; the unknown item has no link.
    await expect(fixture.locator('a.ledger-title')).toHaveAttribute(
      'href',
      /^\/library\/[0-9a-f-]{36}$/,
    );
    await expect(unknown.locator('a.ledger-title')).toHaveCount(0);

    // The total-space footer: 4+8+2+1 GiB = 15 GB across 4 items.
    await expect(page.getByTestId('trash-total')).toHaveText('Reclaiming 15 GB across 4 items');

    // Filter-aware: Genre=Action keeps only Stub Runner and the footer says so.
    await page.getByTitle('Edit the Genre filter').click();
    await page
      .getByRole('dialog', { name: 'Edit the Genre filter' })
      .getByLabel('Action', { exact: true })
      .click();
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('trash-row')).toHaveCount(1);
    await expect(page.getByTestId('trash-total')).toHaveText(
      'Reclaiming 8.0 GB across 1 item · filtered from 4 pending',
    );
    await expect(page).toHaveURL(/genre=Action/);

    // TV is a separate tab (never combined): Breaking Prod, requested → protected.
    await page.getByRole('tab', { name: 'TV' }).click();
    await expect(page).toHaveURL(/\/trash\?tab=tv$/); // tab switch keeps ONLY ?tab
    const tvRow = page.getByTestId('trash-row').filter({ hasText: 'Breaking Prod' });
    await expect(tvRow).toHaveCount(1);
    await expect(tvRow.getByTestId('badge-requested')).toBeVisible();
    await expect(page.getByTestId('trash-total')).toHaveText('Reclaiming 20 GB across 1 item');
  });

  test('Save → protected → un-save: the shield drives Maintainerr exclusion calls (stub-verified)', async ({
    page,
  }) => {
    await resetMaintainerr(page);
    await signIn(page, 'admin');
    await openTrashMovies(page);

    const vanished = page.getByTestId('trash-row').filter({ hasText: 'Vanished Heist' });
    const shield = vanished.getByTestId('trash-shield');
    await expect(shield).not.toHaveAttribute('data-on', 'true');

    // Save (protective — plain toggle, no confirm): the row turns Protected.
    await shield.click();
    await expect(shield).toHaveAttribute('data-on', 'true');
    await expect(vanished.getByTestId('badge-protected')).toBeVisible();

    // Un-save puts it back under the rules.
    await shield.click();
    await expect(shield).not.toHaveAttribute('data-on', 'true');
    await expect(vanished.getByTestId('badge-protected')).toHaveCount(0);

    // The stub saw exactly the sanctioned writes: one exclusion add, one exclusion delete.
    const calls = await maintainerrCalls(page);
    const adds = calls.filter((c) => c.method === 'POST' && c.path === '/rules/exclusion');
    expect(adds).toHaveLength(1);
    expect(adds[0]!.body).toMatchObject({ mediaId: STUB_MAINT_VANISHED_ID, action: 0 });
    const removes = calls.filter(
      (c) => c.method === 'DELETE' && c.path === `/rules/exclusions/${STUB_MAINT_VANISHED_ID}`,
    );
    expect(removes).toHaveLength(1);
  });

  // Bug 2 (live-repro fix) — an exclusion created OUTSIDE this session (no `dnd` tag synced yet) must
  // still render Protected in the pending list; the pending read ORs the LIVE exclusion set into the
  // badge. Vanished Heist is the cold, unbadged fixture (see the pending-table test), so a pre-seeded
  // exclusion for it is a clean before/after.
  test('a live exclusion made outside the session shows Protected before the dnd tag syncs', async ({
    page,
  }) => {
    await resetMaintainerr(page);
    await seedExclusion(page, STUB_MAINT_VANISHED_ID); // excluded upstream — no save flow, no tag
    await signIn(page, 'admin');
    await openTrashMovies(page);

    const vanished = page.getByTestId('trash-row').filter({ hasText: 'Vanished Heist' });
    await expect(vanished.getByTestId('badge-protected')).toBeVisible();

    await resetMaintainerr(page); // clear the seeded exclusion for later tests
  });

  test('Expedite all: filters refuse to arm; the Modal predicts deleted/protected/skipped; per-item handle calls only (C-07a)', async ({
    page,
  }) => {
    await resetMaintainerr(page);
    await signIn(page, 'admin');
    await openTrashMovies(page);

    // With a filter active the Modal REFUSES — filters cannot scope Expedite all.
    await page.getByTitle('Edit the Genre filter').click();
    await page
      .getByRole('dialog', { name: 'Edit the Genre filter' })
      .getByLabel('Action', { exact: true })
      .click();
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('trash-row')).toHaveCount(1);
    await page.getByTestId('trash-expedite-all').click();
    await expect(page.getByTestId('trash-expedite-refusal')).toBeVisible();
    await expect(page.getByTestId('trash-expedite-refusal')).toContainText(
      'Filters can’t scope “Expedite all”',
    );
    await expect(page.getByTestId('trash-expedite-all-submit')).toHaveCount(0);

    // Clearing the filters from inside the Modal reveals the real confirm with the honest
    // partition: 1 deletes NOW (cold), 2 protected (watched + dnd-tag), 1 kept-unverifiable.
    await page.getByRole('button', { name: 'Clear filters' }).click();
    const confirm = page.getByTestId('trash-expedite-all-confirm');
    await expect(confirm).toBeVisible();
    await expect(confirm).toContainText('4 items');
    await expect(confirm).toContainText('1 will be deleted NOW');
    await expect(confirm).toContainText('freeing 2.0 GB');
    await expect(confirm).toContainText('2 protected');
    await expect(confirm).toContainText('1 kept — can’t be verified safe');

    // Fire. The report distinguishes deleted / protected / skipped (skipped ≠ protected).
    await page.getByTestId('trash-expedite-all-submit').click();
    const report = page.getByTestId('trash-expedite-report');
    await expect(report).toBeVisible();
    await expect(page.getByTestId('trash-expedite-summary')).toContainText('1 deleted');
    await expect(page.getByTestId('trash-expedite-summary')).toContainText('2 protected');
    await expect(page.getByTestId('trash-expedite-summary')).toContainText('1 skipped');
    await expect(report).toContainText('could not be verified safe');
    await report.getByRole('button', { name: 'Done' }).click();

    // The deleted item left the pending set on refetch; the protected/skipped ones remain.
    await expect(page.getByTestId('trash-row')).toHaveCount(3);
    await expect(page.getByTestId('trash-row').filter({ hasText: 'Vanished Heist' })).toHaveCount(
      0,
    );

    // Stub-verified: deletion went through the PER-ITEM handler for exactly the cold item,
    // the guardian auto-whitelisted the watched item, and the estate-wide handler that
    // processes EVERY collection was NEVER called (ADR-023 C-07a).
    const calls = await maintainerrCalls(page);
    const perItem = calls.filter(
      (c) => c.method === 'POST' && c.path === '/collections/media/handle',
    );
    expect(perItem).toHaveLength(1);
    expect(perItem[0]!.body).toMatchObject({ collectionId: 7, mediaId: STUB_MAINT_VANISHED_ID });
    expect(calls.some((c) => c.path === '/collections/handle')).toBe(false);
    const guardianSaves = calls.filter((c) => c.method === 'POST' && c.path === '/rules/exclusion');
    expect(guardianSaves).toHaveLength(1);
    expect(guardianSaves[0]!.body).toMatchObject({ mediaId: STUB_MAINT_FIXTURE_ID, action: 0 });
  });

  test('Expedite one item: the Modal is unavoidable; a mid-flight unsafe install refuses cleanly', async ({
    page,
  }) => {
    await resetMaintainerr(page);
    await signIn(page, 'admin');
    await openTrashMovies(page);

    // The cold row's Modal carries the immediate-and-permanent warning.
    const vanished = page.getByTestId('trash-row').filter({ hasText: 'Vanished Heist' });
    await vanished.getByTestId('trash-expedite-item').click();
    const confirm = page.getByTestId('trash-expedite-item-confirm');
    await expect(confirm).toBeVisible();
    await expect(confirm).toContainText('immediate and permanent');

    // The install degrades BETWEEN the banner read and the submit (the between-check
    // regression ADR-023 names) — the server refuses (PRECONDITION_FAILED) and the UI shows
    // the calm "nothing was deleted — refreshed" state, never a raw error.
    await setIntegration(page, 'tautulli', false);
    await page.getByTestId('trash-expedite-item-submit').click();
    await expect(page.getByTestId('trash-expedite-stale')).toBeVisible();
    await expect(page.getByTestId('trash-expedite-stale')).toContainText('Nothing was deleted');
    const midCalls = await maintainerrCalls(page);
    expect(midCalls.some((c) => c.path === '/collections/media/handle')).toBe(false);
    await page.getByTestId('trash-expedite-stale').getByRole('button', { name: 'Close' }).click();

    // Restore the integration; the deletable item's Modal now deletes for real.
    await setIntegration(page, 'tautulli', true);
    await page.reload();
    const row = page.getByTestId('trash-row').filter({ hasText: 'Vanished Heist' });
    await row.getByTestId('trash-expedite-item').click();
    await page.getByTestId('trash-expedite-item-submit').click();
    await expect(page.getByTestId('trash-expedite-summary')).toContainText('1 deleted');
    await page.getByRole('button', { name: 'Done' }).click();
    await expect(page.getByTestId('trash-row').filter({ hasText: 'Vanished Heist' })).toHaveCount(
      0,
    );
  });

  test('a watched item expedited alone is PROTECTED, not deleted (the guardian wins)', async ({
    page,
  }) => {
    await resetMaintainerr(page);
    await signIn(page, 'admin');
    await openTrashMovies(page);

    const fixture = page.getByTestId('trash-row').filter({ hasText: 'The Fixture' });
    await fixture.getByTestId('trash-expedite-item').click();
    const confirm = page.getByTestId('trash-expedite-item-confirm');
    await expect(confirm).toContainText('recently watched');
    await expect(confirm).toContainText('protect it');
    await page.getByTestId('trash-expedite-item-submit').click();
    await expect(page.getByTestId('trash-expedite-summary')).toContainText('0 deleted');
    await expect(page.getByTestId('trash-expedite-summary')).toContainText('1 protected');
    await page.getByRole('button', { name: 'Done' }).click();

    const calls = await maintainerrCalls(page);
    expect(calls.some((c) => c.path === '/collections/media/handle')).toBe(false);
    expect(calls.some((c) => c.path === '/collections/handle')).toBe(false);
    const saves = calls.filter((c) => c.method === 'POST' && c.path === '/rules/exclusion');
    expect(saves).toHaveLength(1);
    expect(saves[0]!.body).toMatchObject({ mediaId: STUB_MAINT_FIXTURE_ID });
  });

  test('F1 — a just-SAVED item survives BOTH Expedite paths: no per-item handle, reported protected (save→expedite race)', async ({
    page,
  }) => {
    await resetMaintainerr(page);
    await signIn(page, 'admin');
    await openTrashMovies(page);

    // Save the cold item. Its Maintainerr exclusion lands NOW, but its protective dnd tag would only
    // reach our ledger on the next *arr sync — the window the review flagged. The server-side
    // live-exclusion seam (F1a) must protect it across every expedite regardless of the tag lag.
    const vanished = page.getByTestId('trash-row').filter({ hasText: 'Vanished Heist' });
    await vanished.getByTestId('trash-shield').click();
    await expect(vanished.getByTestId('trash-shield')).toHaveAttribute('data-on', 'true');

    // Expedite it as a SINGLE item immediately. The confirm no longer short-circuits on the session
    // shield (F1b) — it shows the honest guardian verdict — but the SERVER protects the saved item,
    // so the report says protected (not deleted) and NO per-item handle fires for it.
    await vanished.getByTestId('trash-expedite-item').click();
    await page.getByTestId('trash-expedite-item-submit').click();
    await expect(page.getByTestId('trash-expedite-summary')).toContainText('0 deleted');
    await expect(page.getByTestId('trash-expedite-summary')).toContainText('1 protected');
    await page.getByRole('button', { name: 'Done' }).click();
    await expect(vanished).toHaveCount(1); // still pending — never deleted

    // Now Expedite ALL. The saved item must again be protected, never handled.
    await page.getByTestId('trash-expedite-all').click();
    await page.getByTestId('trash-expedite-all-submit').click();
    await expect(page.getByTestId('trash-expedite-report')).toBeVisible();
    await expect(page.getByTestId('trash-expedite-summary')).toContainText('0 deleted');
    await page.getByRole('button', { name: 'Done' }).click();

    // Stub-verified across BOTH runs: the estate-wide handler never fired, and the per-item delete
    // handler was NEVER called for the saved item.
    const calls = await maintainerrCalls(page);
    expect(calls.some((c) => c.path === '/collections/handle')).toBe(false);
    const handledSaved = calls.filter(
      (c) =>
        c.method === 'POST' &&
        c.path === '/collections/media/handle' &&
        (c.body as { mediaId?: string }).mediaId === STUB_MAINT_VANISHED_ID,
    );
    expect(handledSaved).toHaveLength(0);
    await expect(page.getByTestId('trash-row').filter({ hasText: 'Vanished Heist' })).toHaveCount(1);
  });

  test('safety banner warns when an integration drops, and every destructive control disables', async ({
    page,
  }) => {
    await resetMaintainerr(page);
    await setIntegration(page, 'tautulli', false);
    await signIn(page, 'admin');
    await openTrashMovies(page);

    const banner = page.getByTestId('trash-safety');
    await expect(banner).toHaveAttribute('data-state', 'warn');
    await expect(banner).toContainText('Tautulli not connected');

    // Expedite (destructive) disables everywhere; the shield (protective, needs only
    // reachability) stays live.
    await expect(page.getByTestId('trash-expedite-all')).toBeDisabled();
    const vanished = page.getByTestId('trash-row').filter({ hasText: 'Vanished Heist' });
    await expect(vanished.getByTestId('trash-expedite-item')).toBeDisabled();
    await expect(vanished.getByTestId('trash-shield')).toBeEnabled();

    // Restore → green again, controls re-arm.
    await setIntegration(page, 'tautulli', true);
    await page.reload();
    await expect(page.getByTestId('trash-safety')).toHaveAttribute('data-state', 'safe');
    await expect(page.getByTestId('trash-expedite-all')).toBeEnabled();
  });

  test('Recently Deleted lists the tombstoned item; Restore re-adds through the failsafe path', async ({
    page,
  }) => {
    await resetMaintainerr(page);
    await signIn(page, 'admin');
    await page.goto('/trash?tab=deleted');

    const row = page.getByTestId('trash-deleted-row').filter({ hasText: 'Vanished Heist' });
    await expect(row).toBeVisible();
    await expect(row.locator('.badge').filter({ hasText: 'Movie' })).toBeVisible();

    // Two-step confirm (ADR-014) → the failsafe executeRestore run; the row reports inline.
    await armAndConfirm(row.getByTestId('trash-restore'));
    await expect(row.getByTestId('trash-restore-status')).toBeVisible();
  });

  test('Rules: readable list; disarm→re-arm round-trips the encoded RulesDto; delete removes it', async ({
    page,
  }) => {
    await resetMaintainerr(page);
    await signIn(page, 'admin');
    await page.goto('/trash?tab=rules');

    const rule = page.getByTestId('trash-rule-row').filter({ hasText: 'Purge stale movies' });
    await expect(rule).toBeVisible();
    await expect(rule).toContainText('Movies');
    await expect(rule).toContainText('30 days');
    // NB exact text — hasText 'Armed' would ALSO substring-match "Disarmed".
    await expect(rule.locator('.badge')).toHaveText('Armed');

    // Disarm → PUT /rules with the full round-tripped payload, isActive false. The GET rule carries
    // an ENCODED `ruleJson`; the app must DECODE it to the RuleDto shape Maintainerr's PUT validates,
    // else the write 502s (the live arm/disarm bug). A successful disarm proves the decode ran. The
    // rule references Radarr (firstVal[0]=1), so the disarm ALSO proves the group-level radarrSettingsId
    // was lifted from the nested collection (else the stub returns {code:0,"Radarr rules require…"} → 502).
    await rule.getByTestId('trash-rule-toggle').click();
    await expect(rule.locator('.badge')).toHaveText('Disarmed');
    let puts = (await maintainerrCalls(page)).filter((c) => c.method === 'PUT' && c.path === '/rules');
    expect(puts).toHaveLength(1);
    expect(puts[0]!.body).toMatchObject({ id: 11, name: 'Purge stale movies', isActive: false });
    // Server selection is lifted to the group level (Bug: live re-verify 502).
    expect(puts[0]!.body).toMatchObject({ radarrSettingsId: 3 });
    // HAZARD guard: dataType + libraryId are carried back VERBATIM (the GET-derived canonical strings),
    // never coerced — else Maintainerr's updateRules sees a crucial-setting change and WIPES the
    // collection. Asserting the exact representation catches a would-be-wipe payload.
    expect(puts[0]!.body).toMatchObject({ dataType: 'movie', libraryId: '1' });
    expect(await maintainerrWipes(page)).toHaveLength(0); // no crucial-change wipe happened
    // the PUT body's rules[] are DECODED (firstVal present, the encoded ruleJson is gone).
    const disarmRules = (puts[0]!.body as { rules: Array<Record<string, unknown>> }).rules;
    expect(disarmRules.length).toBeGreaterThan(0);
    expect(disarmRules[0]).toHaveProperty('firstVal');
    expect(disarmRules[0]).not.toHaveProperty('ruleJson');

    // Re-arm → a SECOND full GET→PUT round-trip (the stub re-encoded the rule to the DB shape on the
    // disarm, so re-arm decodes again), isActive true. Waiting for the exact "Armed" badge gates on
    // the re-arm refetch completing, so the second PUT is recorded by the time we read the calls.
    await rule.getByTestId('trash-rule-toggle').click();
    await expect(rule.locator('.badge')).toHaveText('Armed');
    puts = (await maintainerrCalls(page)).filter((c) => c.method === 'PUT' && c.path === '/rules');
    expect(puts).toHaveLength(2);
    expect(puts[1]!.body).toMatchObject({ id: 11, isActive: true, dataType: 'movie', libraryId: '1', radarrSettingsId: 3 });
    const rearmRules = (puts[1]!.body as { rules: Array<Record<string, unknown>> }).rules;
    expect(rearmRules[0]).toHaveProperty('firstVal');
    expect(rearmRules[0]).not.toHaveProperty('ruleJson');
    expect(await maintainerrWipes(page)).toHaveLength(0); // still no crucial-change wipe across the round-trip

    // Delete (two-step) → DELETE /rules/11 and the row leaves the list.
    await armAndConfirm(rule.getByTestId('trash-rule-delete'));
    await expect(page.getByTestId('trash-rule-row')).toHaveCount(0);
    const afterDelete = await maintainerrCalls(page);
    expect(afterDelete.some((c) => c.method === 'DELETE' && c.path === '/rules/11')).toBe(true);

    await resetMaintainerr(page); // put the fixture rule back for later tests
  });

  test('the webhook rejects without the shared secret, accepts with it, and feeds Activity', async ({
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
    const json = (await withSecret.json()) as { ok: boolean; id: string };
    expect(json.ok).toBe(true);
    expect(json.id).toBeTruthy();

    // The stored notification surfaces on the Activity tab (D-07).
    await signIn(page, 'admin');
    await page.goto('/trash?tab=activity');
    const feed = page.getByTestId('trash-activity');
    await expect(feed).toBeVisible();
    await expect(feed.locator('li').filter({ hasText: 'Cleaned up' }).first()).toContainText(
      '2 items',
    );
  });

  test('role gating: a save-only role browses and shields but cannot expedite, restore, or edit rules', async ({
    page,
    browser,
  }) => {
    await resetMaintainerr(page);
    const memberContext = await browser.newContext();
    const memberPage = await memberContext.newPage();
    await signIn(memberPage, 'member');

    await signIn(page, 'admin');
    await assignMemberRole(page, 'Trash Limited');

    // Nav shows Trash (read_only ≥ visible); the pending table renders with shields…
    await memberPage.goto('/');
    expect(await memberPage.locator('.topbar__nav a').allInnerTexts()).toContain('Trash');
    await memberPage.goto('/trash');
    await expect(memberPage.getByTestId('trash-row')).toHaveCount(4);
    await expect(
      memberPage
        .getByTestId('trash-row')
        .filter({ hasText: 'Vanished Heist' })
        .getByTestId('trash-shield'),
    ).toBeVisible();
    // …but NOTHING destructive is reachable: no per-row Expedite, no Expedite-all.
    await expect(memberPage.getByTestId('trash-expedite-item')).toHaveCount(0);
    await expect(memberPage.getByTestId('trash-expedite-all')).toHaveCount(0);

    // edit_rules is granted but the section is Read-only ⇒ the rules stay UNEDITABLE
    // (edit_rules additionally requires section Edit — ADR-023 C-03).
    await memberPage.goto('/trash?tab=rules');
    await expect(
      memberPage.getByTestId('trash-rule-row').filter({ hasText: 'Purge stale movies' }),
    ).toBeVisible();
    await expect(memberPage.getByTestId('trash-rule-toggle')).toHaveCount(0);
    await expect(memberPage.getByTestId('trash-rule-delete')).toHaveCount(0);

    // No restore grant ⇒ no Restore control.
    await memberPage.goto('/trash?tab=deleted');
    await expect(memberPage.getByTestId('trash-restore')).toHaveCount(0);

    await memberContext.close();
    // Restore the member to Default — later spec files depend on the seeded grants.
    await assignMemberRole(page, 'Default (default)');
  });

  test('/admin/roles: the Trash access select + per-action grid; Admin implicit and locked', async ({
    page,
  }) => {
    await signIn(page, 'admin');
    await page.goto('/admin/roles');

    // Admin: implicit Edit + all actions, uneditable.
    const adminRow = page.locator('.admin-table tbody tr').filter({ hasText: 'superuser' });
    await expect(adminRow).toContainText('Edit · all actions');

    // The seeded Trash Limited role: level select reads read_only; the summary counts grants.
    const select = page.getByLabel('Trash access for Trash Limited');
    await expect(select).toHaveValue('read_only');
    await expect(page.getByTestId('trash-actions-summary-Trash Limited')).toHaveText('3 actions');

    // The per-action grid lives in the row editor: grant expedite_item, save, verify persistence.
    const limitedRow = page.locator('.admin-table tbody tr').filter({ hasText: 'Trash Limited' });
    await limitedRow.getByRole('button', { name: 'Edit' }).click();
    const grid = page.getByTestId('trash-actions-grid');
    await expect(grid).toBeVisible();
    await expect(grid.getByTestId('trash-action-save_exclude')).toBeChecked();
    await expect(grid.getByTestId('trash-action-expedite_item')).not.toBeChecked();
    await grid.getByTestId('trash-action-expedite_item').check();
    await page.getByRole('button', { name: 'Save changes' }).click();
    await expect(page.getByTestId('trash-actions-summary-Trash Limited')).toHaveText('4 actions');
    await page.reload();
    await expect(page.getByTestId('trash-actions-summary-Trash Limited')).toHaveText('4 actions');

    // Put the seeded grant set back (the suite treats seeded roles as canonical).
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

    // A pending, ledger-joined movie → its detail page mounts the guard panel + shield.
    const fixtureHref = await page
      .getByTestId('trash-row')
      .filter({ hasText: 'The Fixture' })
      .locator('a.ledger-title')
      .getAttribute('href');
    await page.goto(fixtureHref!);
    await expect(page.getByTestId('trash-guard')).toBeVisible();
    await expect(page.getByTestId('trash-guard')).toContainText('Scheduled for deletion');
    await expect(page.getByTestId('trash-guard').getByTestId('trash-shield')).toBeVisible();

    // The dnd-tagged movie shows the protected badge in its header (read off arrTags).
    await openTrashMovies(page);
    const runnerHref = await page
      .getByTestId('trash-row')
      .filter({ hasText: 'Stub Runner' })
      .locator('a.ledger-title')
      .getAttribute('href');
    await page.goto(runnerHref!);
    await expect(page.locator('.detail-head').getByText('Protected from deletion')).toBeVisible();

    // Music (Lidarr) never mounts a shield or guard panel (R-87).
    await page.goto('/ledger?tab=music');
    const musicHref = await page
      .locator('.ledger-row')
      .filter({ hasText: 'The Stub Band' })
      .locator('a.ledger-title')
      .getAttribute('href');
    await page.goto(musicHref!);
    await expect(page.getByRole('heading', { name: 'The Stub Band' })).toBeVisible();
    await expect(page.getByTestId('trash-guard')).toHaveCount(0);
    await expect(page.getByTestId('trash-shield')).toHaveCount(0);
  });

  test('mobile 390×844: the pending sheet pans internally — the page never scrolls sideways', async ({
    page,
  }) => {
    await resetMaintainerr(page);
    await page.setViewportSize({ width: 390, height: 844 });
    await signIn(page, 'admin');
    await openTrashMovies(page);

    const wrap = page.getByTestId('trash-tablewrap');
    const overflow = await wrap.evaluate((el) => el.scrollWidth - el.clientWidth);
    expect(overflow).toBeGreaterThan(50);
    await expectViewportFit(page);
  });
});
