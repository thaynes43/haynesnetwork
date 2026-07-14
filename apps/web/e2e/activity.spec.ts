// ADR-059 / DESIGN-030 (PLAN-048 — Activity / In-Flight) end to end — the pipeline made visible:
//   • the admin Activity journey: Library → Activity shows every in-flight stage (searching / downloading %
//     / importing / stranded-FAILED) over the stub LL wanted-table + SAB queue/history, with stage chips +
//     server counts (D-02);
//   • the STRANDED import (the OPS-013 §11 42-book incident): its failed tile links to the failure detail,
//     which shows the reason + the ROLE-CONTROLLED Retry import — firing it records the confined LL
//     forceProcess (R2);
//   • the ROLE gate: a plain member sees the (always-on) Activity tab but NO book items (books-section
//     gated), and a book failure detail is FORBIDDEN (read-only stuck view, never the action).
// Hermetic screenshots (dark, desktop + 390): the Activity tab with mixed stages + a failure detail.
import { test, expect, type Page } from '@playwright/test';
import { signIn } from './support/helpers';
import { readRuntimeEnv } from './support/env';

interface LlCall {
  cmd: string;
  id: string | null;
  type: string | null;
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

/** Force the dark theme (the capture convention) — the shots are the standing reference. */
async function setDark(page: Page): Promise<void> {
  await page.evaluate(() => localStorage.setItem('hnet-theme', 'hnet-dark'));
  await page.reload();
  await page.locator('html[data-theme="hnet-dark"]').waitFor();
}

/** The failure detail id extracted from the admin journey (workers=1 → shared across tests, in order). */
let strandedFailureId: string | null = null;

test.describe('Activity / In-Flight (PLAN-048)', () => {
  test('admin: mixed in-flight stages, chip counts, and the stranded failure detail + retry', async ({
    page,
  }, testInfo) => {
    await resetLl();
    await signIn(page, 'admin');
    await page.goto('/library?tab=activity');

    const panel = page.getByTestId('activity-panel');
    await expect(panel).toBeVisible();

    // The stub fixture produces 5 in-flight items: searching, downloading, stranded(failed),
    // postprocess-failed(failed), download-failed(failed) → 3 failed.
    await expect(page.getByTestId('activity-stage-all')).toContainText('· 5');
    await expect(page.getByTestId('activity-stage-failed')).toContainText('· 3');
    await expect(page.getByTestId('activity-stage-downloading')).toContainText('· 1');
    const grid = page.getByTestId('activity-grid');
    await expect(grid.locator('.poster-card')).toHaveCount(5);

    // Dark, desktop + 390 captures of the Activity tab with mixed stages.
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

    // Open the STRANDED failure (the incident). Its tile links to the failure detail.
    const stranded = grid.locator('.poster-card', { hasText: 'The Stranded Import' });
    await expect(stranded).toHaveCount(1);
    await stranded.click();
    await expect(page).toHaveURL(/\/library\/activity\//);
    strandedFailureId = new URL(page.url()).pathname.split('/').pop() ?? null;

    await expect(page.getByTestId('activity-failure-reason')).toContainText(/never imported/i);
    await expect(page.getByTestId('activity-failure-head')).toContainText('Stuck');

    const failurePath = testInfo.outputPath('activity-failure-detail-desktop-dark.png');
    await page.screenshot({ path: failurePath, fullPage: true });
    await testInfo.attach('activity-failure-detail-desktop-dark', { path: failurePath, contentType: 'image/png' });

    // Retry import — the admin action fires the confined LL forceProcess (R2).
    await resetLl();
    await page.getByTestId('activity-retry').click();
    await expect(page.getByTestId('activity-retry-slot')).toContainText('Requested');
    await expect
      .poll(async () => (await llCalls()).some((c) => c.cmd === 'forceProcess'))
      .toBe(true);
  });

  test('member: Activity tab is empty (books gated) and a book failure detail is forbidden', async ({
    page,
  }) => {
    await signIn(page, 'member');
    await page.goto('/library?tab=activity');
    // The tab is always-on, but a member cannot see the books section → no book activity items.
    await expect(page.getByTestId('activity-panel')).toBeVisible();
    await expect(page.getByTestId('activity-empty')).toBeVisible();
    await expect(page.getByTestId('activity-grid')).toHaveCount(0);

    // A member reaching a book failure detail directly is FORBIDDEN → the unavailable note (never the action).
    test.skip(strandedFailureId === null, 'needs the admin journey to have captured a failure id');
    await page.goto(`/library/activity/${strandedFailureId}`);
    await expect(page.getByTestId('activity-failure-error')).toBeVisible();
    await expect(page.getByTestId('activity-retry')).toHaveCount(0);
  });
});
