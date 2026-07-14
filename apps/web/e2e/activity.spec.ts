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

/** Reset the *arr stub (clears the staged queue, recorded writes, AND the Activity-read fault). */
async function resetArr(): Promise<void> {
  const env = readRuntimeEnv();
  await fetch(`${env.STUB_ARR_URL}/_stub/reset`, { method: 'POST' });
}

/** Toggle the *arr Activity-read fault (500 on /queue + /history) — the per-source-isolation lever. */
async function faultArr(on: boolean): Promise<void> {
  const env = readRuntimeEnv();
  await fetch(`${env.STUB_ARR_URL}/_stub/fault`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ on }),
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

  // fix/activity-robustness — PER-SOURCE FAILURE ISOLATION. One source down (the *arr stub 500s its Activity
  // reads) must NOT blank the tab: the reachable books + comics still render, and a small non-blocking notice
  // names the down family. This is the prod incident made hermetic (a missing SABNZBD_API_KEY made the books
  // adapter throw and blanked everything) — proven here via the universal *arr leg for determinism.
  test('unavailable source: *arr down → books + comics still render + a non-blocking notice (no blank tab)', async ({
    page,
  }, testInfo) => {
    await resetLl();
    await resetArr();
    await stageComicQueue();
    await faultArr(true); // the *arr Activity reads now 500 → the adapter degrades
    try {
      await signIn(page, 'admin');
      await page.goto('/library?tab=activity');
      await expect(page.getByTestId('activity-panel')).toBeVisible();

      // The degraded-source notice names the *arr family (never a total error — the tab lives).
      const notice = page.getByTestId('activity-unavailable-arr');
      await expect(notice).toBeVisible();
      await expect(notice).toContainText(/unavailable/i);

      // The reachable sources STILL flow: a stranded book (LL/SAB) + a comic (Kapowarr) both render…
      const grid = page.getByTestId('activity-grid');
      await expect(grid.locator('.poster-card', { hasText: 'The Stranded Import' })).toHaveCount(1);
      await expect(grid.locator('.poster-card', { hasText: 'Saga' })).toHaveCount(1);
      // …while the faulted *arr items are absent (degraded, not fabricated).
      await expect(grid.locator('.poster-card', { hasText: 'Vanished Heist' })).toHaveCount(0);

      // Hermetic captures (dark, desktop + 390) of the unavailable-notice state.
      await setDark(page);
      await expect(page.getByTestId('activity-unavailable-arr')).toBeVisible();
      for (const [label, w, h] of [
        ['desktop', 1280, 900],
        ['390', 390, 844],
      ] as const) {
        await page.setViewportSize({ width: w, height: h });
        const path = testInfo.outputPath(`activity-unavailable-${label}-dark.png`);
        await page.screenshot({ path, fullPage: true });
        await testInfo.attach(`activity-unavailable-${label}-dark`, { path, contentType: 'image/png' });
      }
      await page.setViewportSize({ width: 1280, height: 900 });
    } finally {
      await resetArr(); // clear the fault for the following tests
    }
  });

  // fix/activity-robustness — the HONEST empty state. A member (books/comics gated) with an empty *arr queue
  // has a genuinely idle pipeline → the designed "Nothing in flight" card, NOT a skeleton wall and NOT a bare
  // "0 items" flash. Also proves the skeleton does not reappear on the background poll (no re-flicker).
  test('empty state: an idle pipeline shows the designed "Nothing in flight" card (no skeleton re-flicker)', async ({
    page,
  }, testInfo) => {
    await resetArr(); // empty *arr queue; /history is [] for the activity read → member sees nothing in flight
    await signIn(page, 'member');
    await page.goto('/library?tab=activity');
    await expect(page.getByTestId('activity-panel')).toBeVisible();

    const empty = page.getByTestId('activity-empty');
    await expect(empty).toBeVisible();
    await expect(empty).toContainText(/nothing in flight/i);
    await expect(page.getByTestId('activity-grid')).toHaveCount(0);

    // The skeleton showed at most on the FIRST paint; across a poll cycle it must never reappear (the flicker
    // the owner saw is impossible now — refetches keep the resolved view, they don't flip back to skeletons).
    await page.waitForTimeout(6000); // > the 5s poll interval
    await expect(page.getByTestId('activity-skeleton')).toHaveCount(0);
    await expect(empty).toBeVisible();

    await setDark(page);
    await expect(page.getByTestId('activity-empty')).toBeVisible();
    for (const [label, w, h] of [
      ['desktop', 1280, 900],
      ['390', 390, 844],
    ] as const) {
      await page.setViewportSize({ width: w, height: h });
      const path = testInfo.outputPath(`activity-empty-${label}-dark.png`);
      await page.screenshot({ path, fullPage: true });
      await testInfo.attach(`activity-empty-${label}-dark`, { path, contentType: 'image/png' });
    }
    await page.setViewportSize({ width: 1280, height: 900 });
  });

  // fix/activity-robustness — EXACTLY ONE active Library tab. The bug: selecting Activity left the prior kind
  // tab (e.g. TV) lit too, because the hover style was identical to the selected style (a hovered / touch
  // sticky-hovered neighbour looked "active"). Now hover is a low-emphasis preview; only the ONE selected tab
  // carries the committed nav-active underline. D-19: a tab switch PUSHES, so Back restores the prior tab.
  test('exactly one Library tab reads as active; Activity replaces the prior tab; Back restores it (D-19)', async ({
    page,
  }) => {
    await signIn(page, 'admin');
    await page.goto('/library');
    const tablist = page.getByRole('tablist', { name: 'Library sections' });

    // The default landing tab (a kind tab) is the single selected tab.
    await expect(tablist.getByRole('tab', { selected: true })).toHaveCount(1);
    const priorName = ((await tablist.getByRole('tab', { selected: true }).textContent()) ?? '').trim();

    // Switch to Activity — still EXACTLY ONE selected, and it's Activity (the prior tab is deselected).
    await tablist.getByRole('tab', { name: 'Activity' }).click();
    await expect(page).toHaveURL(/tab=activity/);
    await expect(tablist.getByRole('tab', { selected: true })).toHaveCount(1);
    await expect(tablist.getByRole('tab', { name: 'Activity' })).toHaveAttribute('aria-selected', 'true');
    // The prior tab is no longer selected (no double-active).
    await expect(tablist.getByRole('tab', { name: priorName, exact: true })).toHaveAttribute(
      'aria-selected',
      'false',
    );

    // The CSS de-dup: HOVER the (now-unselected) prior tab. Only the ONE selected (Activity) tab may carry the
    // committed nav-active underline colour — the hovered neighbour must read as a preview, never "active".
    const priorTab = tablist.getByRole('tab', { name: priorName, exact: true });
    await priorTab.hover();
    const selectedColor = await tablist
      .getByRole('tab', { name: 'Activity' })
      .evaluate((el) => getComputedStyle(el).borderBottomColor);
    const borderColors = await tablist
      .getByRole('tab')
      .evaluateAll((els) => els.map((el) => getComputedStyle(el).borderBottomColor));
    expect(borderColors.filter((c) => c === selectedColor)).toHaveLength(1);

    // D-19: Back restores the prior tab as the single active tab.
    await page.goBack();
    await expect(tablist.getByRole('tab', { selected: true })).toHaveCount(1);
    await expect(tablist.getByRole('tab', { name: priorName, exact: true })).toHaveAttribute(
      'aria-selected',
      'true',
    );
  });
});
