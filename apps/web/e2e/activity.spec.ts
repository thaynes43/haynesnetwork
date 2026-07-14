// ADR-059 / DESIGN-030 (PLAN-048 — Activity / In-Flight) end to end — the pipeline made visible, now with
// the *arr leg (DESIGN-030 D-08):
//   • the admin Activity journey: Library → Activity shows every in-flight stage across BOTH source families
//     — the books LL/SAB items (searching / downloading % / importing / stranded-FAILED) AND the *arr
//     Radarr items (a downloading movie + a manual-import BLOCKED movie), with stage chips + server counts;
//   • the STRANDED book import (OPS-013 §11) → retry fires the confined LL forceProcess (R2);
//   • the *arr MANUAL-IMPORT BLOCKED movie → its detail shows the reason + the ROLE-CONTROLLED Retry import,
//     which fires the confined *arr ProcessMonitoredDownloads (R2);
//   • the ROLE gate: a plain member sees the UNIVERSAL *arr items (no section) but NO book items (books
//     gated); an *arr failure detail is VIEWABLE read-only (no action), a book failure detail is FORBIDDEN.
// Hermetic screenshots (dark, desktop + 390): the Activity tab with MIXED *arr + books sources.
import { test, expect, type Page } from '@playwright/test';
import { signIn } from './support/helpers';
import { readRuntimeEnv } from './support/env';
import { arrActivityQueueFixture } from './support/stub-arr';
import { kapowarrActivityQueueFixture } from './support/stub-kapowarr';

interface LlCall {
  cmd: string;
  id: string | null;
  type: string | null;
}
interface ArrCall {
  method: string;
  path: string;
  query: Record<string, string>;
  body: unknown;
}

async function llCalls(): Promise<LlCall[]> {
  const env = readRuntimeEnv();
  const res = await fetch(`${env.STUB_LAZYLIBRARIAN_URL}/_stub/calls`);
  return ((await res.json()) as { calls: LlCall[] }).calls;
}
async function resetLl(): Promise<void> {
  const env = readRuntimeEnv();
  await fetch(`${env.STUB_LAZYLIBRARIAN_URL}/_stub/reset`, { method: 'POST' });
}
async function arrCalls(): Promise<ArrCall[]> {
  const env = readRuntimeEnv();
  const res = await fetch(`${env.STUB_ARR_URL}/_stub/calls`);
  return ((await res.json()) as { calls: ArrCall[] }).calls;
}
/** Stage the live *arr queue (a downloading + a manual-import-blocked movie); leaves recorded writes intact. */
async function stageArrQueue(): Promise<void> {
  const env = readRuntimeEnv();
  await fetch(`${env.STUB_ARR_URL}/_stub/queue`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ records: arrActivityQueueFixture() }),
  });
}

/** Stage the live Kapowarr comics queue (a downloading + a failed comic); the comics leg of the mixed list. */
async function stageComicQueue(): Promise<void> {
  const env = readRuntimeEnv();
  await fetch(`${env.STUB_KAPOWARR_URL}/_stub/queue`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ queue: kapowarrActivityQueueFixture() }),
  });
}

/** Force the dark theme (the capture convention) — the shots are the standing reference. */
async function setDark(page: Page): Promise<void> {
  await page.evaluate(() => localStorage.setItem('hnet-theme', 'hnet-dark'));
  await page.reload();
  await page.locator('html[data-theme="hnet-dark"]').waitFor();
}

/** Failure detail ids extracted from the admin journey (workers=1 → shared across tests, in order). */
let strandedFailureId: string | null = null;
let arrBlockedFailureId: string | null = null;

test.describe('Activity / In-Flight (PLAN-048)', () => {
  test('admin: mixed *arr + books stages, chip counts, and the stranded + blocked failure detail + retry', async ({
    page,
  }, testInfo) => {
    await resetLl();
    await stageArrQueue();
    await stageComicQueue();
    await signIn(page, 'admin');
    await page.goto('/library?tab=activity');

    const panel = page.getByTestId('activity-panel');
    await expect(panel).toBeVisible();

    // Books (5): searching, downloading, stranded(failed), postprocess-failed(failed), download-failed(failed).
    // *arr (2): a downloading movie + a manual-import BLOCKED movie (failed).
    // Comics (2, Kapowarr): a downloading comic + a failed comic (download_failed).
    // Mixed → 9 total, 5 failed, 3 downloading.
    await expect(page.getByTestId('activity-stage-all')).toContainText('· 9');
    await expect(page.getByTestId('activity-stage-failed')).toContainText('· 5');
    await expect(page.getByTestId('activity-stage-downloading')).toContainText('· 3');
    const grid = page.getByTestId('activity-grid');
    await expect(grid.locator('.poster-card')).toHaveCount(9);

    // The *arr leg is present with Radarr attribution + a populated Movies kind chip (mixed kinds).
    await expect(page.getByTestId('activity-kind-movie')).toBeVisible();
    const radarrCard = grid.locator('.poster-card', { hasText: 'Vanished Heist' });
    await expect(radarrCard).toHaveCount(1);
    await expect(radarrCard).toContainText('Radarr');

    // The COMICS leg (Kapowarr) rides the books gate — an admin sees it: a Comics kind chip + a comic card
    // with Kapowarr attribution (DESIGN-030 D-08 — the contract-shaped fan-out, no card/tab/chip change).
    await expect(page.getByTestId('activity-kind-comic')).toBeVisible();
    const comicCard = grid.locator('.poster-card', { hasText: 'Saga' });
    await expect(comicCard).toHaveCount(1);
    await expect(comicCard).toContainText('Kapowarr');

    // Dark, desktop + 390 captures of the Activity tab with MIXED *arr + books sources.
    await setDark(page);
    await expect(page.getByTestId('activity-panel')).toBeVisible();
    for (const [label, w, h] of [
      ['desktop', 1280, 900],
      ['390', 390, 844],
    ] as const) {
      await page.setViewportSize({ width: w, height: h });
      const path = testInfo.outputPath(`activity-tab-${label}-dark.png`);
      await page.screenshot({ path, fullPage: true });
      await testInfo.attach(`activity-tab-${label}-dark`, { path, contentType: 'image/png' });
    }
    await page.setViewportSize({ width: 1280, height: 900 });

    // --- the STRANDED book (the OPS-013 §11 incident) → confined LL forceProcess retry ---
    const stranded = grid.locator('.poster-card', { hasText: 'The Stranded Import' });
    await expect(stranded).toHaveCount(1);
    await stranded.click();
    await expect(page).toHaveURL(/\/library\/activity\//);
    strandedFailureId = new URL(page.url()).pathname.split('/').pop() ?? null;
    await expect(page.getByTestId('activity-failure-reason')).toContainText(/never imported/i);
    await expect(page.getByTestId('activity-failure-head')).toContainText('Stuck');
    await resetLl();
    await page.getByTestId('activity-retry').click();
    await expect(page.getByTestId('activity-retry-slot')).toContainText('Requested');
    await expect
      .poll(async () => (await llCalls()).some((c) => c.cmd === 'forceProcess'))
      .toBe(true);

    // --- the *arr MANUAL-IMPORT BLOCKED movie → confined ProcessMonitoredDownloads retry ---
    await page.goto('/library?tab=activity');
    const blocked = page.getByTestId('activity-grid').locator('.poster-card', { hasText: 'Vanished Heist' });
    await blocked.click();
    await expect(page).toHaveURL(/\/library\/activity\//);
    arrBlockedFailureId = new URL(page.url()).pathname.split('/').pop() ?? null;
    const head = page.getByTestId('activity-failure-head');
    await expect(head).toContainText('Stuck');
    await expect(head).toContainText('Blocked');
    await expect(page.getByTestId('activity-failure-reason')).toContainText(/not imported/i);

    const failurePath = testInfo.outputPath('activity-failure-detail-arr-desktop-dark.png');
    await page.screenshot({ path: failurePath, fullPage: true });
    await testInfo.attach('activity-failure-detail-arr-desktop-dark', {
      path: failurePath,
      contentType: 'image/png',
    });

    await page.getByTestId('activity-retry').click();
    await expect(page.getByTestId('activity-retry-slot')).toContainText('Requested');
    await expect
      .poll(async () =>
        (await arrCalls()).some(
          (c) => c.path === '/command' && (c.body as { name?: string })?.name === 'ProcessMonitoredDownloads',
        ),
      )
      .toBe(true);
  });

  test('member: sees the universal *arr items but no book items; *arr failure read-only, book failure forbidden', async ({
    page,
  }) => {
    await stageArrQueue();
    await signIn(page, 'member');
    await page.goto('/library?tab=activity');
    await expect(page.getByTestId('activity-panel')).toBeVisible();

    // The *arr walls are UNIVERSAL (no section) — a member sees the 2 *arr items, but NO book items (gated).
    await expect(page.getByTestId('activity-stage-all')).toContainText('· 2');
    const grid = page.getByTestId('activity-grid');
    await expect(grid.locator('.poster-card', { hasText: 'Vanished Heist' })).toHaveCount(1);
    await expect(grid.locator('.poster-card', { hasText: 'The Stranded Import' })).toHaveCount(0);

    // A member reaching the *arr failure detail CAN view it (universal), but sees the read-only note (no action).
    test.skip(arrBlockedFailureId === null, 'needs the admin journey to have captured the *arr failure id');
    await page.goto(`/library/activity/${arrBlockedFailureId}`);
    await expect(page.getByTestId('activity-failure-head')).toContainText('Blocked');
    await expect(page.getByTestId('activity-readonly-note')).toBeVisible();
    await expect(page.getByTestId('activity-retry')).toHaveCount(0);

    // A member reaching a BOOK failure detail directly is FORBIDDEN (books gated) → the unavailable note.
    test.skip(strandedFailureId === null, 'needs the admin journey to have captured a book failure id');
    await page.goto(`/library/activity/${strandedFailureId}`);
    await expect(page.getByTestId('activity-failure-error')).toBeVisible();
    await expect(page.getByTestId('activity-retry')).toHaveCount(0);
  });
});
