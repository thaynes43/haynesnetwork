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
import { signIn } from './support/helpers';
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

test.describe('Integrations hub + Goodreads sub-section', () => {
  test('a fresh member sees no Integrations tab and a not-available state (hub AND sub-section)', async ({ page }) => {
    await signIn(page, 'fresh-member');
    await expect(page.getByRole('navigation', { name: 'Primary' }).getByRole('link', { name: 'Integrations' })).toHaveCount(0);
    await page.goto('/integrations');
    await expect(page.getByTestId('integrations-unavailable')).toBeVisible();
    await page.goto('/integrations/goodreads');
    await expect(page.getByTestId('integrations-unavailable')).toBeVisible();
  });

  test('admin: hub → sub-section → link → ALL-shelves sync → stats → items wall + chips → force-search → Library Wanted', async ({ page }, testInfo) => {
    await resetLl();
    await signIn(page, 'admin');

    // ── The HUB: a provider card, pushing into the sub-section (D-19). ──
    await page.getByRole('navigation', { name: 'Primary' }).getByRole('link', { name: 'Integrations' }).click();
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
    //    items merge INLINE into the flat wall as the SAME poster card as an on-disk book — no strip. ──
    await page.goto('/library?tab=books&view=flat');
    // The ebook leg: ToG (missing) + PHM + Hyperion (wanted) — matched/landed wants never compose.
    await expect(page.getByTestId('wanted-card')).toHaveCount(3);
    const wantedTog = page.getByTestId('wanted-card').filter({ hasText: 'Throne of Glass' });
    await expect(wantedTog).toContainText('Missing');
    // NO force-search button and NO requester line on the Library card face (both live on the detail page
    // now) — the card is a plain click-through.
    await expect(wantedTog.getByTestId('format-search-btn')).toHaveCount(0);
    await expect(wantedTog).not.toContainText('for ');

    // The Wanted-only chip narrows the wall to the wanted cards (the Movies "Wanted only" idiom).
    await page.getByTestId('books-wanted-toggle').click();
    await expect(page).toHaveURL(/wanted=1/);
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
});
