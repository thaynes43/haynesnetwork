// ADR-028 / DESIGN-005 D-20/D-21 / PLAN-015 end to end — the live *arr action
// feedback: a fix walks searching → queued → downloading (meter + ETA) → importing →
// completed as the scriptable stub queue advances; the item's action slot LOCKS
// (chip in place of the Fix button, no reflow) while the fix is in flight and
// re-arms on the terminal; My Fixes rows go live; a Force Search that finds nothing
// lands the honest nothing_found terminal with a working retry; a season roll-up
// cascades per-child phases. All admin (bypasses the shared fix/search hourly
// budget, keeping this file order-independent), and every fix it opens is CLOSED
// via the real completeFixRequests matcher (ingest-import.ts) so no forever-open
// row leaks into later specs.
//
// NB: file name keeps this suite alphabetically AFTER library.spec.ts — the events
// this file lands (search_requested / imported / fix_completed, dated now) must not
// outrank the seeded history in specs that assert timeline order.
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { test, expect, type Page } from '@playwright/test';
import { signIn } from './support/helpers';
import { readRuntimeEnv } from './support/env';
import { STUB_MOVIE_ID, STUB_SERIES_ID, type RecordedArrWrite } from './support/stub-arr';

const FIX_EPISODE_ID = 50105; // S01E05 · Chapter 5 (on disk) — untouched by other specs.
const SEASON2_MISSING_EPISODE_ID = 50302; // S02E02 · Reckoning — the roll-up's mover.

// ---------------------------------------------------------------------------
// Stub-arr controls
// ---------------------------------------------------------------------------

async function stubArrCalls(): Promise<RecordedArrWrite[]> {
  const env = readRuntimeEnv();
  const res = await fetch(`${env.STUB_ARR_URL}/_stub/calls`);
  if (!res.ok) throw new Error(`stub-arr calls fetch failed: ${res.status}`);
  return ((await res.json()) as { calls: RecordedArrWrite[] }).calls;
}

async function resetStubArr(): Promise<void> {
  const env = readRuntimeEnv();
  const res = await fetch(`${env.STUB_ARR_URL}/_stub/reset`, { method: 'POST' });
  if (!res.ok) throw new Error(`stub-arr reset failed: ${res.status}`);
}

/** Stage the scriptable download queue (replaces all records; [] empties it). */
async function stageQueue(records: Record<string, unknown>[]): Promise<void> {
  const env = readRuntimeEnv();
  const res = await fetch(`${env.STUB_ARR_URL}/_stub/queue`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ records }),
  });
  if (!res.ok) throw new Error(`stub-arr queue staging failed: ${res.status}`);
}

/** A sonarr queue record for the fix episode (defaults: actively downloading). */
function episodeQueueRecord(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 91,
    seriesId: STUB_SERIES_ID,
    episodeId: FIX_EPISODE_ID,
    seasonNumber: 1,
    status: 'downloading',
    trackedDownloadStatus: 'ok',
    trackedDownloadState: 'downloading',
    size: 1_000_000_000,
    sizeleft: 380_000_000, // 62% done
    estimatedCompletionTime: new Date(Date.now() + 4 * 60_000).toISOString(),
    title: 'Breaking.Prod.S01E05.REPACK.1080p.WEB-DL',
    ...overrides,
  };
}

/**
 * Land the `imported` milestone + run the real completeFixRequests matcher (the
 * production closure the sync cron performs) via the domain single-writers.
 */
function ingestImport(mediaItemId: string, source: 'sonarr' | 'radarr' | 'lidarr', childId?: number) {
  const env = readRuntimeEnv();
  const args = [
    join(process.cwd(), 'e2e', 'support', 'ingest-import.ts'),
    mediaItemId,
    source,
    ...(childId !== undefined ? [String(childId)] : []),
  ];
  const run = spawnSync(join(process.cwd(), 'node_modules', '.bin', 'tsx'), args, {
    env: { ...process.env, DATABASE_URL: env.DATABASE_URL },
    stdio: 'inherit',
    cwd: process.cwd(),
  });
  expect(run.status, 'ingest-import subprocess must succeed').toBe(0);
}

// ---------------------------------------------------------------------------
// Navigation helpers
// ---------------------------------------------------------------------------

async function openSeries(page: Page): Promise<string> {
  await page.goto('/library');
  await page.getByRole('tab', { name: 'TV' }).click();
  await page.locator('.media-card').filter({ hasText: 'Breaking Prod' }).click();
  await page.waitForURL(/\/library\/[0-9a-f-]{36}$/);
  await expect(page.locator('.detail-head__title')).toContainText('Breaking Prod');
  return page.url().split('/').pop()!;
}

async function openMovie(page: Page): Promise<string> {
  await page.goto('/library');
  await page.locator('.media-card').filter({ hasText: 'The Fixture' }).click();
  await page.waitForURL(/\/library\/[0-9a-f-]{36}$/);
  await expect(page.locator('.detail-head__title')).toContainText('The Fixture');
  return page.url().split('/').pop()!;
}

async function expandSeason(page: Page, name: string) {
  const season = page.locator('.season').filter({ hasText: name });
  await season.locator('.season__title').click();
  await expect(season).toHaveJSProperty('open', true);
  return season;
}

test.describe('live *arr action feedback (ADR-028 / PLAN-015)', () => {
  test('a fix reports searching → queued → downloading (meter+ETA) → importing → completed, locking the row in flight', async ({
    page,
  }) => {
    test.setTimeout(120_000);
    await resetStubArr();
    await signIn(page, 'admin');
    const mediaItemId = await openSeries(page);
    await expandSeason(page, 'Season 1');

    const row = page.locator('.child-row').filter({ hasText: 'S01E05 · Chapter 5' });
    await expect(row).toContainText('On disk');
    await row.getByRole('button', { name: 'Fix' }).click();
    const dialog = page.getByRole('dialog', { name: 'Fix Breaking Prod' });
    await dialog.getByRole('radio', { name: 'Wrong version or quality' }).check();
    await dialog.getByRole('button', { name: 'Submit fix' }).click();

    // Wire-ack: the mutation resolved ⇒ the live view opens at `searching`.
    const live = dialog.locator('.action-progress');
    await expect(live).toBeVisible({ timeout: 15_000 });
    await expect(live).toContainText('Searching for a release…');
    await expect(live.locator('.phase-chip')).toHaveAttribute('data-phase', 'searching');

    // Stage: queued in Sonarr (a queue record exists but the client is waiting).
    await stageQueue([
      episodeQueueRecord({ status: 'queued', sizeleft: 1_000_000_000, estimatedCompletionTime: null }),
    ]);
    await expect(live).toContainText('Queued in Sonarr');

    // Stage: actively downloading — the meter fills to 62% and the ETA reads out.
    await stageQueue([episodeQueueRecord()]);
    await expect(live).toContainText('Downloading — 62%');
    await expect(live).toContainText('min left');
    await expect(live.locator('.progress-meter [role="progressbar"]')).toHaveAttribute(
      'aria-valuenow',
      '62',
    );

    // The dialog can be closed — the state lives on the item (D-21): the row's action
    // slot is LOCKED (live chip in place of the Fix button, Force Search gone too).
    await dialog.getByRole('button', { name: 'Done' }).click();
    await expect(row.locator('.phase-chip')).toHaveAttribute('data-phase', 'downloading', {
      timeout: 15_000,
    });
    await expect(row.getByRole('button', { name: 'Fix' })).toHaveCount(0);
    await expect(row.getByRole('button', { name: 'Force Search' })).toHaveCount(0);
    const lockedBox = await row.boundingBox();

    // Stage: download finished, importing — the chip advances IN PLACE (no reflow:
    // the row's box must not move or resize — ADR-015 / hard rule 9).
    await stageQueue([
      episodeQueueRecord({ status: 'completed', trackedDownloadState: 'importing', sizeleft: 0 }),
    ]);
    await expect(row.locator('.phase-chip')).toHaveAttribute('data-phase', 'importing', {
      timeout: 15_000,
    });
    const importingBox = await row.boundingBox();
    const round = (b: { x: number; y: number; width: number; height: number } | null) =>
      b === null ? null : [b.x, b.y, b.width, b.height].map(Math.round);
    expect(round(importingBox)).toEqual(round(lockedBox));

    // The real closure: the imported milestone lands (as the sync cron would ingest
    // it) and completeFixRequests flips the row — the action buttons re-arm.
    await stageQueue([]);
    ingestImport(mediaItemId, 'sonarr', FIX_EPISODE_ID);
    await expect(row.getByRole('button', { name: 'Fix' })).toBeVisible({ timeout: 20_000 });
    await expect(row.getByRole('button', { name: 'Force Search' })).toBeVisible();

    // Read-only guarantee: all that polling recorded NO extra *arr writes — the fix's
    // own blocklist + search command are the ONLY mutating calls of the whole journey.
    const calls = await stubArrCalls();
    const commands = calls.filter((c) => c.path === '/command');
    expect(commands).toHaveLength(1);
    expect(commands[0]!.body).toEqual({ name: 'EpisodeSearch', episodeIds: [FIX_EPISODE_ID] });
    expect(calls.filter((c) => c.path.startsWith('/history/failed/'))).toHaveLength(1);
    expect(calls).toHaveLength(2);
  });

  test('the fix dialog rides to the completed terminal, the re-armed button allows a REAL second fix, and My Fixes rows are live', async ({
    page,
  }) => {
    test.setTimeout(120_000);
    await resetStubArr();
    await signIn(page, 'admin');
    const mediaItemId = await openMovie(page);

    // Fix #1: watch it through to the terminal INSIDE the dialog.
    const actions = page.locator('.detail-head__actions');
    await actions.getByRole('button', { name: 'Fix' }).click();
    const dialog = page.getByRole('dialog', { name: 'Fix The Fixture' });
    await dialog.getByRole('radio', { name: "Won't play / corrupt" }).check();
    await dialog.getByRole('button', { name: 'Submit fix' }).click();
    const live = dialog.locator('.action-progress');
    await expect(live).toContainText('Searching for a release…', { timeout: 15_000 });

    await stageQueue([
      {
        id: 92,
        movieId: STUB_MOVIE_ID,
        status: 'downloading',
        trackedDownloadStatus: 'ok',
        trackedDownloadState: 'downloading',
        size: 2_000_000_000,
        sizeleft: 1_100_000_000, // 45%
        estimatedCompletionTime: new Date(Date.now() + 9 * 60_000).toISOString(),
        title: 'The.Fixture.2022.REPACK.1080p.WEB-DL',
      },
    ]);
    await expect(live).toContainText('Downloading — 45%');

    await stageQueue([]);
    ingestImport(mediaItemId, 'radarr');
    await expect(live).toContainText('Done — the new copy imported.', { timeout: 20_000 });
    await expect(live.locator('.phase-chip')).toHaveAttribute('data-phase', 'completed');
    await dialog.getByRole('button', { name: 'Done' }).click();

    // The completed fix re-armed the header — and a SECOND fix actually goes through
    // (the anti-mashing lock is a live gate, not a dead end).
    await actions.getByRole('button', { name: 'Fix' }).click();
    await dialog.getByRole('radio', { name: "Won't play / corrupt" }).check();
    await dialog.getByRole('button', { name: 'Submit fix' }).click();
    await expect(live).toContainText('Searching for a release…', { timeout: 15_000 });
    await dialog.getByRole('button', { name: 'Done' }).click();

    // My Fixes: the in-flight row carries the LIVE chip; stage a download and the
    // compact meter percent ticks in the table.
    await stageQueue([
      {
        id: 93,
        movieId: STUB_MOVIE_ID,
        status: 'downloading',
        trackedDownloadStatus: 'ok',
        trackedDownloadState: 'downloading',
        size: 2_000_000_000,
        sizeleft: 760_000_000, // 62%
        title: 'The.Fixture.2022.PROPER.1080p.WEB-DL',
      },
    ]);
    await page.goto('/library');
    await page.getByRole('tab', { name: 'My Fixes' }).click();
    const rows = page.locator('.admin-table tbody tr').filter({ hasText: 'The Fixture' });
    const liveRow = rows.first(); // newest first — the open fix
    await expect(liveRow.locator('.phase-chip')).toHaveAttribute('data-phase', 'downloading', {
      timeout: 15_000,
    });
    await expect(liveRow.locator('.phase-chip')).toContainText('62%');
    // The completed fix keeps its static badge — terminal rows are never polled.
    await expect(rows.nth(1)).toContainText('Completed');

    // Close the loop so no open row leaks into later specs.
    await stageQueue([]);
    ingestImport(mediaItemId, 'radarr');
    await expect(liveRow.locator('.phase-chip')).toHaveAttribute('data-phase', 'completed', {
      timeout: 20_000,
    });
  });

  test('a Force Search that finds nothing lands the honest nothing_found terminal with a working retry', async ({
    page,
  }) => {
    test.setTimeout(150_000);
    await resetStubArr(); // queue stays EMPTY — nothing is ever found
    await signIn(page, 'admin');
    await openMovie(page);

    const actions = page.locator('.detail-head__actions');
    await actions.getByRole('button', { name: 'Force Search' }).click();
    const dialog = page.getByRole('dialog', { name: 'Force search The Fixture' });
    await dialog.getByRole('button', { name: 'Force search' }).click();

    const live = dialog.locator('.action-progress');
    await expect(live).toContainText('Searching for a release…', { timeout: 15_000 });

    // While the search is live, the header's Force Search is locked behind the chip.
    await expect(actions.locator('.phase-chip')).toBeVisible();
    await expect(actions.getByRole('button', { name: 'Force Search' })).toHaveCount(0);

    // Wait out the (test-shortened, 30 s) found-nothing window: the never-stuck
    // terminal lands with plain-language copy and a retry.
    await expect(live).toContainText('No release found yet', { timeout: 60_000 });
    await expect(live.locator('.phase-chip')).toHaveAttribute('data-phase', 'nothing_found');
    const retry = live.getByRole('button', { name: 'Search again' });
    await expect(retry).toBeVisible();

    // Retry re-issues the SAME search (a real second command) and re-opens the window.
    await retry.click();
    await expect(live).toContainText('Searching for a release…', { timeout: 15_000 });
    const commands = (await stubArrCalls()).filter((c) => c.path === '/command');
    expect(commands).toHaveLength(2);
    expect(commands[0]!.body).toEqual(commands[1]!.body);
    await dialog.getByRole('button', { name: 'Done' }).click();
  });

  test('a season Force Search cascades per-child phases (roll-up), headline = least advanced', async ({
    page,
  }) => {
    test.setTimeout(120_000);
    await resetStubArr();
    // S02E02 is mid-download before the search even starts; S02E01 has nothing yet.
    await stageQueue([
      {
        id: 94,
        seriesId: STUB_SERIES_ID,
        episodeId: SEASON2_MISSING_EPISODE_ID,
        seasonNumber: 2,
        status: 'downloading',
        trackedDownloadStatus: 'ok',
        trackedDownloadState: 'downloading',
        size: 800_000_000,
        sizeleft: 400_000_000, // 50%
        title: 'Breaking.Prod.S02E02.1080p.WEB-DL',
      },
    ]);
    await signIn(page, 'admin');
    await openSeries(page);

    const season2 = page.locator('.season').filter({ hasText: 'Season 2' });
    await season2.locator('.season__head').getByRole('button', { name: 'Force Search' }).click();
    const dialog = page.getByRole('dialog', { name: 'Force search Breaking Prod' });
    await dialog.getByRole('button', { name: 'Force search' }).click();

    // The roll-up expands per child: the downloading episode shows its own meter+pct,
    // the quiet one is still searching — and the HEADLINE is the least-advanced child.
    const live = dialog.locator('.action-progress');
    await expect(live).toBeVisible({ timeout: 15_000 });
    const rollupRows = live.locator('.rollup__row');
    await expect(rollupRows).toHaveCount(2, { timeout: 15_000 });
    const e1 = rollupRows.filter({ hasText: 'S02E01 · Return' });
    const e2 = rollupRows.filter({ hasText: 'S02E02 · Reckoning' });
    await expect(e2.locator('.phase-chip')).toHaveAttribute('data-phase', 'downloading');
    await expect(e2.locator('.phase-chip')).toContainText('50%');
    await expect(e1.locator('.phase-chip')).toHaveAttribute('data-phase', 'searching');
    await expect(live.locator('.action-progress__head .phase-chip')).toHaveAttribute(
      'data-phase',
      'searching',
    );
    await dialog.getByRole('button', { name: 'Done' }).click();

    // The season header slot carries the live headline chip while in flight.
    await expect(season2.locator('.season__actions .phase-chip')).toBeVisible();

    // Clean the stage for later specs.
    await stageQueue([]);
  });
});
