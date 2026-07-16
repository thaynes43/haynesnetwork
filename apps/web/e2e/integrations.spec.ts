// ADR-055/056/057 / DESIGN-028/029 (PLAN-044/045/046) end to end — the Integrations HUB + the
// Goodreads sub-section + the Library composed-Wanted journey:
//   • the section gate (fresh member: NO tab + a "not available" state; admin implied edit);
//   • the hub → sub-section navigation (a provider card PUSH — D-19);
//   • the link flow (vanity URL → resolved + probed → linked) and the ALL-SHELVES goodreads-sync
//     (to-read + currently-reading + read; did-not-finish 404s → tolerated as EMPTY, A3) with the
//     A1-OVERRULED acquisition proof: READ-shelf + CURRENTLY-READING unmet wants push to LL too;
//   • the stats page (want-shelf headline coverage + per-shelf breakdown + phase tiles);
//   • the ITEMS wall (cohesive poster cards + the Helpdesk-semantics shelf chips) whose cards now
//     click-through to the WANTED DETAIL PAGE (PLAN-047 — the Movies/TV poster→detail parity), where the
//     audited per-format force-search lives (book → LL searchBook per format; comic → Kapowarr auto_search);
//   • the Library Books/Comics walls' Wanted cards merged INLINE as the same poster block as an
//     on-disk book (owner-corrected), the Wanted-only chip, and the click-through into the Wanted detail.
//
// NB: the file name keeps this suite ordering-stable; it links the admin's Goodreads account into the
// shared DB, which only this spec queries.
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { test, expect } from '@playwright/test';
import { signIn, openUserMenu } from './support/helpers';
import { readRuntimeEnv } from './support/env';

interface LlCall {
  cmd: string;
  id: string | null;
  type: string | null;
}

function runGoodreadsSync(): void {
  const env = readRuntimeEnv();
  const run = spawnSync(
    join(process.cwd(), 'node_modules', '.bin', 'tsx'),
    [join(process.cwd(), '..', '..', 'packages', 'sync', 'src', 'scripts', 'sync.ts'), '--mode=goodreads-sync'],
    { env: { ...process.env, ...env }, stdio: 'inherit', cwd: process.cwd() },
  );
  expect(run.status, 'goodreads-sync subprocess must succeed').toBe(0);
}

async function llCalls(): Promise<LlCall[]> {
  const env = readRuntimeEnv();
  const res = await fetch(`${env.STUB_LAZYLIBRARIAN_URL}/_stub/calls`);
  const body = (await res.json()) as { calls: LlCall[] };
  return body.calls;
}

async function resetLl(): Promise<void> {
  const env = readRuntimeEnv();
  await fetch(`${env.STUB_LAZYLIBRARIAN_URL}/_stub/reset`, { method: 'POST' });
}

// ADR-056 (PLAN-046) — the Kapowarr stub call recorder (comic add + auto_search force-search).
interface KapowarrCall {
  method: string;
  path: string;
  comicvineId?: number;
  volumeId?: number;
  cmd?: string;
}
async function kapowarrCalls(): Promise<KapowarrCall[]> {
  const env = readRuntimeEnv();
  const res = await fetch(`${env.STUB_KAPOWARR_URL}/_stub/calls`);
  const body = (await res.json()) as { calls: KapowarrCall[] };
  return body.calls;
}

// fix/live-status-precedence — force the synced Scott Pilgrim comic to a STALE comic_status='missing' (the drift
// the owner reported) and return its Kapowarr volume id, so the e2e can stage a matching LIVE download.
function seedComicMissing(): string {
  const env = readRuntimeEnv();
  const run = spawnSync(
    join(process.cwd(), 'node_modules', '.bin', 'tsx'),
    [join(process.cwd(), 'e2e', 'support', 'seed-comic-missing.ts')],
    { env: { ...process.env, ...env }, encoding: 'utf8', cwd: process.cwd() },
  );
  expect(run.status, run.stderr || 'seed-comic-missing must succeed').toBe(0);
  const m = /KAPOWARR_VOLUME_ID=(\d+)/.exec(run.stdout ?? '');
  expect(m, 'seed-comic-missing must print the Kapowarr volume id').not.toBeNull();
  return m![1]!;
}

/** Stage the live Kapowarr Activity read (queue / history) — the comics leg of `activity.wallStages`/`itemStatus`. */
async function stageKapowarr(body: {
  queue?: Record<string, unknown>[];
  history?: Record<string, unknown>[];
}): Promise<void> {
  const env = readRuntimeEnv();
  await fetch(`${env.STUB_KAPOWARR_URL}/_stub/queue`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

test.describe('Integrations hub + Goodreads sub-section', () => {
  test('a fresh member sees no Integrations entry (nav or menu) and a not-available state (hub AND sub-section)', async ({ page }) => {
    await signIn(page, 'fresh-member');
    // DESIGN-004 D-22 — Integrations is a user-menu entry now (never a top-row tab); a role without
    // the `integrations` section sees it in NEITHER place.
    await expect(page.getByRole('navigation', { name: 'Primary' }).getByRole('link', { name: 'Integrations' })).toHaveCount(0);
    await openUserMenu(page);
    await expect(page.getByRole('menuitem', { name: 'Integrations' })).toHaveCount(0);
    await page.keyboard.press('Escape');
    await page.goto('/integrations');
    await expect(page.getByTestId('integrations-unavailable')).toBeVisible();
    await page.goto('/integrations/goodreads');
    await expect(page.getByTestId('integrations-unavailable')).toBeVisible();
  });

  test('admin: hub → sub-section → link → ALL-shelves sync → stats → items wall + chips → force-search → Library Wanted', async ({ page }, testInfo) => {
    await resetLl();
    await signIn(page, 'admin');

    // ── Reach the HUB via the user menu (DESIGN-004 D-22 — Integrations moved off the top row);
    //    a menu-item Link push (D-19). Then a provider card pushes into the sub-section. ──
    await openUserMenu(page);
    await page.getByRole('menuitem', { name: 'Integrations' }).click();
    await expect(page.getByTestId('integrations-hub')).toBeVisible();
    await page.getByTestId('hub-card-goodreads').click();
    await expect(page).toHaveURL(/\/integrations\/goodreads/);
    await expect(page.getByTestId('integrations-link-card')).toBeVisible();

    // ── Link via the VANITY URL — resolved server-side to the numeric id, want shelf probed. ──
    await page.getByTestId('integrations-profile-input').fill('https://www.goodreads.com/haynesnetwork');
    await page.getByTestId('integrations-link-btn').click();
    await expect(page.getByTestId('integrations-linked')).toBeVisible();

    // Run the real goodreads-sync — ALL FOUR shelves (did-not-finish 404s → tolerated, A3).
    runGoodreadsSync();

    // A1 OVERRULED — EVERY shelf acquires: the READ-shelf want (Hyperion) and the CURRENTLY-READING
    // want (Project Hail Mary) hit LazyLibrarian with the mandatory both-format queueBook, exactly
    // like the to-read want (Throne of Glass). Comics never touch LL.
    const calls = await llCalls();
    for (const id of ['gb-tog', 'gb-hyp', 'gb-phm']) {
      expect(calls.some((c) => c.cmd === 'addBook' && c.id === id), `addBook ${id}`).toBe(true);
      const queued = calls.filter((c) => c.cmd === 'queueBook' && c.id === id);
      expect(queued.some((c) => c.type === 'eBook'), `queueBook eBook ${id}`).toBe(true);
      expect(queued.some((c) => c.type === 'AudioBook'), `queueBook AudioBook ${id}`).toBe(true);
    }
    expect(calls.some((c) => c.id === 'gb-scottpilgrim')).toBe(false);
    expect(calls.some((c) => c.id === 'gb-batman')).toBe(false);

    // ADR-056 — the comic was routed to KAPOWARR: a volume was ADDED (its own GetComics-DDL source).
    const kapo = await kapowarrCalls();
    expect(kapo.some((c) => c.path === '/api/volumes' && c.method === 'POST')).toBe(true);

    await page.reload();

    // ── The STATS page: the want-shelf HEADLINE (Q-02 — 1 of 4 = 25%), the per-shelf breakdown,
    //    and the request-phase tiles. ──
    await expect(page.getByTestId('integrations-coverage')).toContainText('25%');
    await expect(page.getByTestId('gr-shelf-card-to-read')).toContainText('4');
    await expect(page.getByTestId('gr-shelf-card-read')).toContainText('50%'); // 1 of 2 in the library
    await expect(page.getByTestId('gr-shelf-card-currently-reading')).toBeVisible();
    // No did-not-finish card — the ABSENT shelf is populated-value-gated (A3).
    await expect(page.getByTestId('gr-shelf-card-did-not-finish')).toHaveCount(0);
    await expect(page.getByTestId('gr-phase-have')).toContainText('2'); // RPO + The Martian landed
    await expect(page.getByTestId('gr-phase-missing')).toContainText('1'); // Throne of Glass
    await expect(page.getByTestId('gr-phase-parked')).toContainText('1'); // Batman (no ComicVine match)

    // ── The ITEMS wall: one poster tile per distinct book + the Helpdesk-semantics shelf chips. ──
    await page.getByTestId('gr-tab-items').click();
    await expect(page.getByTestId('gr-item')).toHaveCount(7);

    // Chips: All + the three POPULATED shelves with counts (DNF absent ⇒ no chip at all).
    await expect(page.getByTestId('shelf-chip-all')).toContainText('All · 7');
    await expect(page.getByTestId('shelf-chip-to-read')).toContainText('To read · 4');
    await expect(page.getByTestId('shelf-chip-read')).toContainText('Read · 2');
    await expect(page.getByTestId('shelf-chip-did-not-finish')).toHaveCount(0);
    // Default = every populated shelf selected ⇒ the All chip lights (the superset indicator).
    await expect(page.getByTestId('shelf-chip-all')).toHaveAttribute('aria-pressed', 'true');

    // Toggle OFF to-read → the union narrows to currently-reading + read (3 tiles), All un-lights,
    // and the URL carries the explicit combination (a REPLACE — shareable, Back-safe).
    await page.getByTestId('shelf-chip-to-read').click();
    await expect(page.getByTestId('gr-item')).toHaveCount(3);
    await expect(page.getByTestId('shelf-chip-all')).toHaveAttribute('aria-pressed', 'false');
    await expect(page).toHaveURL(/shelf=currently-reading/);
    await expect(page).toHaveURL(/shelf=read/);

    // Toggle read back off too ⇒ only currently-reading remains selected.
    await page.getByTestId('shelf-chip-read').click();
    await expect(page.getByTestId('gr-item')).toHaveCount(1);
    await expect(page.getByTestId('gr-item')).toContainText('Project Hail Mary');

    // "All" re-selects every shelf (the superset select — canonical default writes NO param).
    await page.getByTestId('shelf-chip-all').click();
    await expect(page.getByTestId('gr-item')).toHaveCount(7);
    await expect(page).not.toHaveURL(/shelf=/);

    // ── Force-search now lives on the WANTED DETAIL PAGE (the Movies/TV poster→detail parity, PLAN-047):
    //    every non-have-it items-wall card click-throughs to it; the corner puck is retired. ──
    // Throne of Glass is Missing (LL Skipped) — its card badge reads Missing; the card opens the detail.
    const tog = page.getByTestId('gr-item').filter({ hasText: 'Throne of Glass' });
    await expect(tog).toHaveAttribute('data-phase', 'missing');
    await expect(tog).toContainText('Missing');
    await tog.click();
    await expect(page).toHaveURL(/\/library\/books\/wanted\//);
    await expect(page.getByTestId('wanted-detail-head')).toContainText('Throne of Glass');

    // The per-format rows (Ebook + Audiobook) each carry their own status + Force-Search (the per-grain idiom).
    await resetLl();
    const ebookRow = page.getByTestId('format-row').filter({ hasText: 'Ebook' });
    await expect(ebookRow).toContainText('Missing');
    await ebookRow.getByTestId('format-search-btn').click();
    await expect(async () => {
      const after = await llCalls();
      expect(after.some((c) => c.cmd === 'searchBook' && c.id === 'gb-tog' && c.type === 'eBook')).toBe(true);
    }).toPass({ timeout: 10_000 });
    // PLAN-015-style feedback in the RESERVED slot — the button swaps to a fired PhaseChip, no reflow (ADR-015).
    await expect(ebookRow.locator('.phase-chip[data-phase="fired"]')).toBeVisible();
    await expect(ebookRow.locator('.phase-chip[data-phase="fired"]')).toHaveAttribute(
      'title',
      /Search fired — LazyLibrarian/,
    );

    // Scott Pilgrim IS routed (Comic, monitored Wanted) — its detail carries the single Comic leg → KAPOWARR.
    await page.goto('/integrations/goodreads?tab=items');
    await page.getByTestId('gr-item').filter({ hasText: 'Scott Pilgrim' }).click();
    await expect(page.getByTestId('wanted-detail-head')).toContainText('Scott Pilgrim');
    const comicRow = page.getByTestId('format-row').filter({ hasText: 'Comic' });
    await comicRow.getByTestId('format-search-btn').click();
    await expect(async () => {
      const after = await kapowarrCalls();
      expect(after.some((c) => c.path === '/api/system/tasks' && c.cmd === 'auto_search')).toBe(true);
    }).toPass({ timeout: 10_000 });
    await expect(comicRow.locator('.phase-chip[data-phase="fired"]')).toHaveAttribute(
      'title',
      /Search fired — Kapowarr/,
    );

    // Batman "Zero Year" has NO ComicVine match → PARKED; its detail shows the honest "waiting on ComicVine"
    // note and NO Force-Search button (nothing to fire).
    await page.goto('/integrations/goodreads?tab=items');
    const zeroYear = page.getByTestId('gr-item').filter({ hasText: 'Zero Year' });
    await expect(zeroYear).toHaveAttribute('data-phase', 'parked');
    await zeroYear.click();
    await expect(page.getByTestId('wanted-detail-head')).toContainText('Zero Year');
    await expect(page.getByText(/waiting on a ComicVine match/i)).toBeVisible();
    await expect(page.getByTestId('format-search-btn')).toHaveCount(0);

    // ── fix/activity-robustness (Fix 5) — the SHELF-chip row (All / To read / Read) now wears the SAME snug
    //    surface-2 pill treatment as its sibling STATUS-chip row (Have it / Searching / Missing), instead of
    //    the misaligned full-width dark box it was. Capture the aligned chip area (dark, desktop + 390). ──
    await page.evaluate(() => localStorage.setItem('hnet-theme', 'hnet-dark'));
    await page.goto('/integrations/goodreads?tab=items');
    await page.locator('html[data-theme="hnet-dark"]').waitFor();
    await expect(page.getByTestId('shelf-chip-all')).toBeVisible();
    await expect(page.getByTestId('gr-state-have')).toBeVisible();
    for (const [label, w] of [
      ['desktop', 1280],
      ['390', 390],
    ] as const) {
      await page.setViewportSize({ width: w, height: 900 });
      const path = testInfo.outputPath(`goodreads-items-chips-${label}-dark.png`);
      await page.locator('.library-toolbar').first().screenshot({ path });
      await testInfo.attach(`goodreads-items-chips-${label}-dark`, { path, contentType: 'image/png' });
    }
    await page.setViewportSize({ width: 1280, height: 900 });

    // ── The Library composed-Wanted journey (books-section-gated; ADR-046 mirror untouched). Wanted
    //    items compose INTO the flat wall as the SAME poster card as an on-disk book — no strip, and
    //    since PLAN-056 no head-of-grid pinning: they land where the active sort puts them. ──
    await page.goto('/library?tab=books&view=flat');
    // The ebook leg: ToG (missing) + PHM + Hyperion (wanted) — matched/landed wants never compose.
    await expect(page.getByTestId('wanted-card')).toHaveCount(3);
    const wantedTog = page.getByTestId('wanted-card').filter({ hasText: 'Throne of Glass' });
    await expect(wantedTog).toContainText('Missing');
    // NO force-search button and NO requester line on the Library card face (both live on the detail page
    // now) — the card is a plain click-through.
    await expect(wantedTog.getByTestId('format-search-btn')).toHaveCount(0);
    await expect(wantedTog).not.toContainText('for ');

    // PLAN-056 — sort participation (the old pinning asserted GONE): under the default Title A–Z
    // 'Throne of Glass' lands at the END of the wall, and the on-disk 'Penny Dreadfuls' precedes
    // the wanted 'Project Hail Mary'.
    const cardTitles = await page.locator('[data-testid="books-grid"] .poster-card').allInnerTexts();
    expect(cardTitles.findIndex((c) => c.includes('Throne of Glass'))).toBe(cardTitles.length - 1);
    expect(cardTitles.findIndex((c) => c.includes('Penny Dreadfuls'))).toBeLessThan(
      cardTitles.findIndex((c) => c.includes('Project Hail Mary')),
    );

    // PLAN-056 — the THREE-state Wanted selector (All · Wanted only · Hide wanted; `?wanted=` is a
    // replace-in-place refinement). Wanted-only: the wants ARE the wall (on-disk rows excluded
    // server-side, not CSS-hidden).
    await page.getByTestId('books-wanted-only').click();
    await expect(page).toHaveURL(/wanted=only/);
    await expect(page.getByTestId('wanted-card')).toHaveCount(3);
    await expect(page.locator('[data-testid="books-grid"] .poster-card')).toHaveCount(3);
    // Hide wanted: the wants drop out server-side — only on-disk rows remain.
    await page.getByTestId('books-wanted-hide').click();
    await expect(page).toHaveURL(/wanted=hide/);
    await expect(page.getByTestId('wanted-card')).toHaveCount(0);
    await expect(page.locator('[data-testid="books-grid"] .poster-card').first()).toBeVisible();
    // Back to All (the default): the param clears and both kinds compose again.
    await page.getByTestId('books-wanted-all').click();
    await expect(page).not.toHaveURL(/wanted=/);
    await expect(page.getByTestId('wanted-card')).toHaveCount(3);

    // The Comics wall composes the comic legs inline: routed Scott Pilgrim + parked Batman.
    await page.goto('/library?tab=comics');
    await expect(page.getByTestId('wanted-card')).toHaveCount(2);

    // A Library Wanted card now click-throughs into the in-app Wanted DETAIL page (the Movies poster→detail
    // idiom) — the SAME route both walls open, reachable by any books-visible viewer. The requester
    // attribution + the per-format status rows live here (off the card face).
    await page.goto('/library?tab=books&view=flat');
    await page.getByTestId('wanted-card').filter({ hasText: 'Hyperion' }).click();
    await expect(page).toHaveURL(/\/library\/books\/wanted\//);
    const head = page.getByTestId('wanted-detail-head');
    await expect(head).toContainText('Hyperion');
    await expect(head).toContainText('Requested by');
    await expect(page.getByTestId('format-row')).toHaveCount(2); // Ebook + Audiobook legs
  });

  // fix/live-status-precedence (v0.55.0 owner report) — LIVE-STATE-WINS. A comic whose reconciled snapshot reads
  // "Missing" (the hourly goodreads-sync lagging behind a fresh grab) but which Kapowarr is ACTIVELY downloading
  // must show the LIVE stage on the Goodreads items wall AND on the Wanted detail on FIRST load (not only after a
  // search fires), then flip to landed on the poll — the wall and the detail can never disagree, and an active
  // grab never reads "Missing". Hermetic captures (dark, desktop + 390): the detail with a live downloading Comic
  // row (was "Missing").
  test('live-status precedence: a downloading comic overrides the stale "Missing" snapshot on the wall + detail, then lands', async ({
    page,
  }, testInfo) => {
    // Self-contained: ensure the admin's Goodreads is linked (idempotent with the journey above), reconcile, then
    // MANUFACTURE the drift — comic_status='missing' while Kapowarr actively downloads the same volume.
    await signIn(page, 'admin');
    await page.goto('/integrations/goodreads');
    await page
      .getByTestId('integrations-linked')
      .or(page.getByTestId('integrations-profile-input'))
      .first()
      .waitFor();
    if (await page.getByTestId('integrations-profile-input').isVisible()) {
      await page.getByTestId('integrations-profile-input').fill('https://www.goodreads.com/haynesnetwork');
      await page.getByTestId('integrations-link-btn').click();
      await expect(page.getByTestId('integrations-linked')).toBeVisible();
    }
    runGoodreadsSync();
    const volumeId = seedComicMissing();
    await stageKapowarr({
      queue: [{ id: 93001, volume_id: Number(volumeId), status: 'downloading', progress: 30, web_title: 'Scott Pilgrim' }],
    });
    await page.evaluate(() => localStorage.setItem('hnet-theme', 'hnet-dark'));

    // ── The WALL sweep (point 2): the Goodreads items card overlays the LIVE stage over the stale snapshot —
    //    it reads "Downloading 30%" (the filling badge), never "Missing". ──
    await page.goto('/integrations/goodreads?tab=items');
    await page.locator('html[data-theme="hnet-dark"]').waitFor();
    const spCard = page.getByTestId('gr-item').filter({ hasText: 'Scott Pilgrim' });
    await expect(spCard.locator('.badge--live')).toContainText('30%');
    await expect(spCard).not.toContainText('Missing');

    // ── The DETAIL (point 1): the Comic row shows the LIVE downloading meter on FIRST load (no search fired),
    //    overriding the reconciled "Missing"; the hero collapse is live-aware too (never "Missing"). ──
    await spCard.click();
    await expect(page.getByTestId('wanted-detail-head')).toContainText('Scott Pilgrim');
    const comicRow = page.getByTestId('format-row').filter({ hasText: 'Comic' });
    await expect(comicRow.locator('.phase-chip[data-phase="downloading"]')).toContainText('Downloading');
    await expect(comicRow.locator('.phase-chip__fill')).toHaveCount(1); // the filling meter (the Fix grammar)
    await expect(comicRow).not.toContainText('Missing');
    await expect(page.getByTestId('wanted-detail-head')).not.toContainText('Missing');

    // Hermetic captures — the detail with a live downloading Comic row (was "Missing").
    for (const [label, w, h] of [
      ['desktop', 1280, 900],
      ['390', 390, 844],
    ] as const) {
      await page.setViewportSize({ width: w, height: h });
      const path = testInfo.outputPath(`live-precedence-comic-downloading-${label}-dark.png`);
      await page.screenshot({ path, fullPage: true });
      await testInfo.attach(`live-precedence-comic-downloading-${label}-dark`, { path, contentType: 'image/png' });
    }
    await page.setViewportSize({ width: 1280, height: 900 });

    // ── Flip to LANDED on the poll: the queue clears + a completed-recent history lands → the Comic row shows the
    //    landed state IMMEDIATELY (before any hourly reconcile), still never "Missing". ──
    await stageKapowarr({
      queue: [],
      history: [
        { volume_id: Number(volumeId), web_title: 'Scott Pilgrim', downloaded_at: Math.floor(Date.now() / 1000), success: true },
      ],
    });
    await expect(comicRow.locator('.phase-chip[data-phase="completed"]')).toContainText('Landed', {
      timeout: 20_000,
    });
    await expect(comicRow).not.toContainText('Missing');
  });
});
