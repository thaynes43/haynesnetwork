// ADR-025 / DESIGN-011 end to end — the Trash CURATION pipeline UX (PLAN-012): the Batches tab,
// THE POSTER WALL (X → lock rescue taps, optimistic + stub-verified exclusion writes, reflow-free
// per ADR-015), the Green-light Modal → Leaving Soon countdown, the family save window
// (save_leaving_soon role: lock anything, unlock only your own), the skip-gate setting
// (straight-to-Leaving-Soon + audited), Cancel, and Expire-now → the SweepReport partition
// (deleted / rescued / protected / skipped; per-item handle calls ONLY — C-07a) with the terminal
// wall glyphs. Serial — shares one stack, one DB (batches persist across tests by design: the
// suite walks one batch through its whole lifecycle), and the stub's mutable state.
import { test, expect, type Page } from '@playwright/test';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { armAndConfirm, expectViewportFit, signIn } from './support/helpers';
import { readRuntimeEnv } from './support/env';
import {
  STUB_MAINT_UNKNOWN_ID,
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

/** Assign the Marge Member persona's user to a role by name (admin user-detail select). */
async function assignMemberRole(page: Page, roleLabel: string): Promise<void> {
  await page.goto('/admin');
  await page.getByRole('link', { name: 'Marge Member' }).click();
  await expect(page.getByRole('heading', { name: 'Marge Member' })).toBeVisible();
  const settled = page.waitForResponse((r) => r.url().includes('users.setRole'));
  await page.locator('#user-role').selectOption({ label: roleLabel });
  await settled;
}

async function openBatches(page: Page, kind: 'movie' | 'tv' = 'movie'): Promise<void> {
  await page.goto(kind === 'tv' ? '/trash?tab=batches&kind=tv' : '/trash?tab=batches');
  await expect(page.getByTestId('batches-tab')).toBeVisible();
}

/** Green-light the open admin_review batch with an ALREADY-EXPIRED window, through the domain
 *  single-writer (see support/greenlight-expired.ts) — the e2e stand-in for waiting out a window. */
function greenlightExpired(kind: 'movie' | 'tv'): void {
  const res = spawnSync(
    join(process.cwd(), 'node_modules', '.bin', 'tsx'),
    [join(process.cwd(), 'e2e', 'support', 'greenlight-expired.ts'), kind],
    { env: { ...process.env, ...env() }, encoding: 'utf8' },
  );
  if (res.status !== 0) {
    throw new Error(`greenlight-expired failed:\n${res.stdout}\n${res.stderr}`);
  }
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

test.describe('trash curation batches (DESIGN-011 D-07)', () => {
  test.describe.configure({ mode: 'serial' });

  test('create from candidates → the wall renders X/eye/shield; tap X→lock is reflow-free, optimistic, and records the save', async ({
    page,
  }) => {
    await resetMaintainerr(page);
    await signIn(page, 'admin');
    await openBatches(page);

    // Fresh DB ⇒ no batches yet; the admin sees the candidate count and the Create affordance.
    await expect(page.getByTestId('batches-empty')).toBeVisible();
    await expect(page.getByTestId('batch-candidates')).toHaveText(
      '4 movie candidates currently proposed by the rules.',
    );
    await page.getByTestId('batch-create').click();

    // The lifecycle strip: Admin review, 4 items.
    await expect(page.getByTestId('batch-state')).toHaveText('Admin review');
    await expect(page.getByTestId('batch-lifecycle')).toContainText('4 items');

    // THE WALL — every guardian partition has its honest overlay: cold ⇒ X, watched ⇒ eye,
    // dnd-tagged ⇒ shield, unknown-to-ledger ⇒ X (rescuable; the sweep will skip it).
    const wall = page.getByTestId('batch-wall');
    await expect(page.getByTestId('wall-tile')).toHaveCount(4);
    const vanished = page.getByTestId('wall-tile').filter({ hasText: 'Vanished Heist' });
    const fixture = page.getByTestId('wall-tile').filter({ hasText: 'The Fixture' });
    const runner = page.getByTestId('wall-tile').filter({ hasText: 'Stub Runner' });
    const unknown = page.getByTestId('wall-tile').filter({ hasText: 'tmdb:990009' });
    await expect(vanished).toHaveAttribute('data-glyph', 'x');
    await expect(fixture).toHaveAttribute('data-glyph', 'eye');
    await expect(runner).toHaveAttribute('data-glyph', 'shield');
    await expect(unknown).toHaveAttribute('data-glyph', 'x');
    // eye/shield are inert — no button to tap toward a delete state.
    await expect(fixture.getByRole('button')).toHaveCount(0);
    await expect(runner.getByRole('button')).toHaveCount(0);
    // Caption carries size + rating (The Fixture: 4 GiB, IMDb 7.7).
    await expect(fixture.locator('.bwall-meta')).toHaveText('4.0 GB · ★ 7.7');

    // Running counts agree with the glyphs.
    await expect(page.getByTestId('wall-counts')).toHaveText(
      'Deleting 2 · Rescued 0 · Kept 2 · frees 3.0 GB',
    );

    // Tap X → lock: overlay swap only — the tile and its neighbor must not move (ADR-015).
    const tileBefore = await vanished.boundingBox();
    const neighborBefore = await fixture.boundingBox();
    await vanished.getByRole('button').click();
    await expect(vanished).toHaveAttribute('data-glyph', 'lock');
    await expect(vanished.getByRole('button')).toHaveAttribute('aria-pressed', 'true');
    expectSameBox(tileBefore, await vanished.boundingBox());
    expectSameBox(neighborBefore, await fixture.boundingBox());
    await expect(page.getByTestId('wall-counts')).toHaveText(
      'Deleting 1 · Rescued 1 · Kept 2 · frees 1.0 GB',
    );

    // Server-confirmed: the tuning record (trash_batch_saves) surfaces in "Who rescued what"…
    await expect(page.getByTestId('batch-savers')).toContainText('Bootstrap Admin · 1 saved');
    // …and the protective exclusion write reached Maintainerr.
    let calls = await maintainerrCalls(page);
    const saves = calls.filter((c) => c.method === 'POST' && c.path === '/rules/exclusion');
    expect(saves).toHaveLength(1);
    expect(saves[0]!.body).toMatchObject({ mediaId: STUB_MAINT_VANISHED_ID });

    // Tap lock → X (un-save): exclusion released, un-save recorded. NET semantics — the un-saved title
    // no longer counts as a save (0 saved), just the net un-save (it must not inflate the rescue count).
    await vanished.getByRole('button').click();
    await expect(vanished).toHaveAttribute('data-glyph', 'x');
    await expect(page.getByTestId('batch-savers')).toContainText(
      'Bootstrap Admin · 0 saved · 1 un-saved',
    );
    calls = await maintainerrCalls(page);
    expect(
      calls.some(
        (c) => c.method === 'DELETE' && c.path === `/rules/exclusions/${STUB_MAINT_VANISHED_ID}`,
      ),
    ).toBe(true);
    await expect(wall).toBeVisible();
  });

  test('Create refuses gracefully while a batch is open — the error names the blocker', async ({
    page,
  }) => {
    await signIn(page, 'admin');
    await openBatches(page);
    await expect(page.getByTestId('batch-state')).toHaveText('Admin review');
    await page.getByTestId('batch-create').click();
    const error = page.getByTestId('batch-create-error');
    await expect(error).toBeVisible();
    await expect(error).toContainText('An open movie batch already exists');
    await expect(error).toContainText("state 'admin_review'");
  });

  test('Green-light Modal → Leaving Soon: window default + override, countdown, and the DO_NOTHING Plex collection', async ({
    page,
  }) => {
    await signIn(page, 'admin');
    await openBatches(page);

    await page.getByTestId('batch-greenlight').click();
    const confirm = page.getByTestId('batch-greenlight-confirm');
    await expect(confirm).toBeVisible();
    // The Modal names the consequences: the Plex collection, the window, the sweep.
    await expect(confirm).toContainText('Leaving Soon — Movies');
    await expect(confirm).toContainText('the sweep deletes what’s left');
    // The window input defaults from trash_default_window_days (21); override to 14.
    await expect(page.getByTestId('batch-window-days')).toHaveValue('21');
    await page.getByTestId('batch-window-days').fill('14');
    await page.getByTestId('batch-greenlight-submit').click();

    // Leaving Soon: state pill + the countdown banner with the family invitation.
    await expect(page.getByTestId('batch-state')).toHaveText('Leaving Soon');
    const countdown = page.getByTestId('batch-countdown');
    await expect(countdown).toHaveText(
      'These delete in 14 days — tap the ✕ on anything you want to keep.',
    );
    // Expire is honest about the window: disabled until it closes.
    await expect(page.getByTestId('batch-expire')).toBeDisabled();

    // Stub-verified: the manual collection carries the SAFETY-CRITICAL create contract (ADR-025
    // C-04): STRING type, arrAction 4 (DO_NOTHING — the aging worker's only skip), Plex Home
    // visibility, and ONLY the pending items as members (the protected one never rides along).
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
      visibleOnRecommended: true,
    });
    expect(dto.media).toHaveLength(3); // vanished + fixture + unknown; Stub Runner is protected
    expect(dto.media.map((m) => m.mediaServerId)).not.toContain('ms-880002');
  });

  test('the family window: a save_leaving_soon role locks anything, unlocks ONLY its own; no lifecycle controls; read-only without the grant', async ({
    page,
    browser,
  }) => {
    await signIn(page, 'admin');
    await openBatches(page);
    // The admin locks Vanished Heist — the foreign lock Marge must NOT be able to release. NET stats:
    // the earlier save→unsave of this same title (test above, shared serial DB) nets to 0, so re-locking
    // it leaves the admin holding exactly ONE current rescue (the old raw counter double-counted to 2).
    const adminVanished = page.getByTestId('wall-tile').filter({ hasText: 'Vanished Heist' });
    await adminVanished.getByRole('button').click();
    await expect(adminVanished).toHaveAttribute('data-glyph', 'lock');
    await expect(page.getByTestId('batch-savers')).toContainText('Bootstrap Admin · 1 saved');

    // Marge must exist before the admin can assign her a role (users are minted on first
    // sign-in), so the member context signs in FIRST — then gets the family grant.
    const memberContext = await browser.newContext();
    const memberPage = await memberContext.newPage();
    await signIn(memberPage, 'member');
    await assignMemberRole(page, 'Trash Family');
    await openBatches(memberPage);

    // The countdown invites the rescue; no batch-lifecycle controls exist for the family.
    await expect(memberPage.getByTestId('batch-countdown')).toContainText(
      'tap the ✕ on anything you want to keep',
    );
    for (const control of ['batch-create', 'batch-greenlight', 'batch-cancel', 'batch-expire']) {
      await expect(memberPage.getByTestId(control)).toHaveCount(0);
    }

    // The admin's lock reads as someone else's save — visible but not tappable.
    const vanished = memberPage.getByTestId('wall-tile').filter({ hasText: 'Vanished Heist' });
    await expect(vanished).toHaveAttribute('data-glyph', 'lock');
    await expect(vanished.getByRole('button')).toHaveCount(0);
    await expect(vanished.locator('.bwall-tap')).toHaveAttribute(
      'title',
      /saved by Bootstrap Admin/,
    );

    // Marge rescues the unknown item: X → lock (a real exclusion write lands)…
    const unknown = memberPage.getByTestId('wall-tile').filter({ hasText: 'tmdb:990009' });
    await unknown.getByRole('button').click();
    await expect(unknown).toHaveAttribute('data-glyph', 'lock');
    await expect(memberPage.getByTestId('batch-savers')).toContainText('Marge Member · 1 saved');
    const calls = await maintainerrCalls(memberPage);
    expect(
      calls.some(
        (c) =>
          c.method === 'POST' &&
          c.path === '/rules/exclusion' &&
          (c.body as { mediaId?: string }).mediaId === STUB_MAINT_UNKNOWN_ID,
      ),
    ).toBe(true);
    // …may undo her OWN lock, and lock it again (leaving it rescued). While it is un-saved the NET
    // stats read 0 saved (the churn must not inflate her rescue count), just the net un-save.
    await unknown.getByRole('button').click();
    await expect(unknown).toHaveAttribute('data-glyph', 'x');
    await expect(memberPage.getByTestId('batch-savers')).toContainText(
      'Marge Member · 0 saved · 1 un-saved',
    );
    await unknown.getByRole('button').click();
    await expect(unknown).toHaveAttribute('data-glyph', 'lock');

    // Without save_leaving_soon (Trash Limited) the SAME wall is fully read-only, and the
    // countdown drops the tap invitation.
    await assignMemberRole(page, 'Trash Limited');
    await openBatches(memberPage);
    await expect(memberPage.getByTestId('wall-tile')).toHaveCount(4);
    await expect(memberPage.getByTestId('batch-wall').getByRole('button')).toHaveCount(0);
    await expect(memberPage.getByTestId('batch-countdown')).toContainText('These delete in');
    await expect(memberPage.getByTestId('batch-countdown')).not.toContainText('tap the');

    await memberContext.close();
    // Restore the seeded default — later spec files treat the personas as canonical.
    await assignMemberRole(page, 'Default (default)');
  });

  test('skip-gate: the audited setting sends a new batch STRAIGHT to Leaving Soon; settings round-trip', async ({
    page,
  }) => {
    await signIn(page, 'admin');

    // The settings card lives on /settings/trash now (ADR-032) — no longer under the
    // Batches tab. Enable the skip-gate there — consequential, so it is a two-step
    // confirm with the explanation.
    await page.goto('/settings/trash');
    const settings = page.getByTestId('trash-settings');
    await expect(settings).toContainText('straight to Leaving Soon');
    await armAndConfirm(page.getByTestId('skipgate-enable'));
    await expect(page.getByTestId('skipgate-state')).toContainText('Skip-gate is ON');

    // A fresh TV batch (back on the Batches tab) skips admin review entirely: born
    // Leaving Soon, flagged as gate-skipped.
    await openBatches(page);
    await page.locator('.seg').getByRole('button', { name: 'TV' }).click();
    // The kind rides the URL (router.replace) — wait for the TV context to commit before
    // creating, or a fast click still targets movies (the server would refuse safely).
    await expect(page.getByTestId('batch-candidates')).toContainText('TV candidate');
    await page.getByTestId('batch-create').click();
    await expect(page.getByTestId('batch-state')).toHaveText('Leaving Soon');
    await expect(page.getByTestId('batch-gate-skipped')).toBeVisible();
    await expect(page.getByTestId('batch-countdown')).toContainText('These delete in 21 days');

    // Cancel it (two-step) — the Leaving-Soon collection is released.
    await armAndConfirm(page.getByTestId('batch-cancel'));
    await expect(page.getByTestId('batch-state')).toHaveText('Cancelled');
    const calls = await maintainerrCalls(page);
    expect(
      calls.some((c) => c.method === 'POST' && c.path === '/collections/removeCollection'),
    ).toBe(true);

    // Restore the gate + round-trip the default window (14 → sticks → back to 21),
    // back on the settings page.
    await page.goto('/settings/trash');
    await page.getByTestId('skipgate-disable').click();
    await expect(page.getByTestId('skipgate-state')).toContainText('Gate is ON');
    await page.getByTestId('settings-window').fill('14');
    // Wait for the write to land BEFORE reloading — the draft makes toHaveValue pass instantly,
    // and a reload would abort the in-flight POST (the flake this guards against).
    await Promise.all([
      page.waitForResponse((r) => r.url().includes('trash.settings.set')),
      page.getByTestId('settings-window-save').click(),
    ]);
    await expect(page.getByTestId('settings-window')).toHaveValue('14');
    await page.reload();
    await expect(page.getByTestId('settings-window')).toHaveValue('14');
    await page.getByTestId('settings-window').fill('21');
    await page.getByTestId('settings-window-save').click();
    await expect(page.getByTestId('settings-window')).toHaveValue('21');
  });

  test('Expire now: the sweep deletes verified-cold survivors only, per-item handles only (C-07a); the terminal wall shows final glyphs', async ({
    page,
  }) => {
    await signIn(page, 'admin');
    await openBatches(page);

    // Close out the window-open movie batch (its locks served the family test) and start a
    // clean batch for the expiry journey.
    await expect(page.getByTestId('batch-state')).toHaveText('Leaving Soon');
    await armAndConfirm(page.getByTestId('batch-cancel'));
    await expect(page.getByTestId('batch-state')).toHaveText('Cancelled');
    await resetMaintainerr(page); // fresh exclusions/collections/calls for the sweep assertions

    await page.getByTestId('batch-create').click();
    await expect(page.getByTestId('batch-state')).toHaveText('Admin review');

    // Time-travel: green-light with an already-expired window via the domain single-writer.
    greenlightExpired('movie');
    await openBatches(page);
    await expect(page.getByTestId('batch-state')).toHaveText('Leaving Soon');
    // Window closed ⇒ calm read-only wall + an actionable Expire.
    await expect(page.getByTestId('batch-countdown')).toContainText('The save window has closed');
    await expect(page.getByTestId('batch-wall').getByRole('button')).toHaveCount(0);
    const expire = page.getByTestId('batch-expire');
    await expect(expire).toBeEnabled();

    // The DANGER Modal predicts the honest partition before anything runs.
    await expire.click();
    const confirm = page.getByTestId('batch-expire-confirm');
    await expect(confirm).toBeVisible();
    await expect(confirm).toContainText('immediate and permanent');
    await expect(confirm).toContainText('Up to 1 item will be deleted');
    await expect(confirm).toContainText('At least 2 will be kept');
    await page.getByTestId('batch-expire-submit').click();

    // The report separates the four fates — and this clean run has no abort/race caveats.
    const report = page.getByTestId('batch-expire-report');
    await expect(report).toBeVisible();
    const summary = page.getByTestId('batch-expire-summary');
    await expect(summary).toContainText('1 deleted');
    await expect(summary).toContainText('0 rescued');
    await expect(summary).toContainText('1 protected');
    await expect(summary).toContainText('2 skipped');
    await expect(page.getByTestId('batch-expire-aborted')).toHaveCount(0);
    await report.getByRole('button', { name: 'Done' }).click();

    // Terminal wall: the cold item is gone, watched/unverifiable were SKIPPED (kept, never
    // deleted — not the same as rescued), the dnd item stayed protected.
    await expect(page.getByTestId('batch-state')).toHaveText('Deleted');
    await expect(
      page.getByTestId('wall-tile').filter({ hasText: 'Vanished Heist' }),
    ).toHaveAttribute('data-glyph', 'gone');
    await expect(page.getByTestId('wall-tile').filter({ hasText: 'The Fixture' })).toHaveAttribute(
      'data-glyph',
      'skip',
    );
    await expect(page.getByTestId('wall-tile').filter({ hasText: 'tmdb:990009' })).toHaveAttribute(
      'data-glyph',
      'skip',
    );
    await expect(page.getByTestId('wall-tile').filter({ hasText: 'Stub Runner' })).toHaveAttribute(
      'data-glyph',
      'shield',
    );
    await expect(page.getByTestId('wall-counts')).toHaveText(
      'Deleted 1 · Rescued 0 · Kept 3 · freed 2.0 GB',
    );

    // Stub-verified: exactly ONE per-item handle, for the cold item; the estate-wide handler
    // that would process EVERY collection was never called (ADR-023 C-07a).
    const calls = await maintainerrCalls(page);
    const handles = calls.filter(
      (c) => c.method === 'POST' && c.path === '/collections/media/handle',
    );
    expect(handles).toHaveLength(1);
    expect(handles[0]!.body).toMatchObject({ mediaId: STUB_MAINT_VANISHED_ID });
    expect(calls.some((c) => c.path === '/collections/handle')).toBe(false);

    // The lifecycle history now tells the whole story (cancelled + deleted batches).
    await expect(page.getByTestId('batch-history')).toBeVisible();
    expect(await page.getByTestId('batch-history-row').count()).toBeGreaterThanOrEqual(2);
  });

  test('mobile 390×844: the wall is a 3-column thumb grid and the page never scrolls sideways', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await signIn(page, 'admin');
    await openBatches(page);

    const tiles = page.getByTestId('wall-tile');
    await expect(tiles).toHaveCount(4);
    const boxes = await Promise.all(
      [0, 1, 2, 3].map(async (i) => (await tiles.nth(i).boundingBox())!),
    );
    // 3 columns: the first three tiles share a row, the fourth wraps below.
    expect(Math.abs(boxes[0]!.y - boxes[1]!.y)).toBeLessThan(1);
    expect(Math.abs(boxes[1]!.y - boxes[2]!.y)).toBeLessThan(1);
    expect(boxes[3]!.y).toBeGreaterThan(boxes[0]!.y + 10);
    // Thumb-sized targets: each tile is a ~120px-wide, taller-than-wide poster.
    expect(boxes[0]!.width).toBeGreaterThan(100);
    expect(boxes[0]!.height).toBeGreaterThan(boxes[0]!.width);

    await expectViewportFit(page);
  });
});
