// PLAN-048 / ADR-059 / DESIGN-030 D-10 — the LIVE-PROGRESS PARITY capture: a hermetic side-by-side of the
// Activity/wall in-flight badge (this pass) against the ledger Fix / Force-Search feedback (the reference the
// owner judges consistency against). Pure fixtures — no stubs, no auth. Emits dark desktop + 390 full-page
// shots (the standing artifact) and asserts the parity anatomy renders: the downloading badge carries the
// live mini-meter + pulse, exactly like the Fix PhaseChip.
import { test, expect, type Page } from '@playwright/test';

async function openParity(page: Page): Promise<void> {
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.goto('/e2e/activity-progress');
  await page.locator('html[data-theme="hnet-dark"]').waitFor();
  await expect(page.getByTestId('activity-progress-parity')).toBeVisible();
}

test.describe('Activity ↔ Fix live-progress parity (PLAN-048 D-10)', () => {
  test('the Activity in-flight badge renders the Fix idiom (pulse + filling meter), side by side', async ({
    page,
  }) => {
    await openParity(page);

    // The Activity downloading tile carries the live mini-meter (fill) + pulsing dot — one badge, no extra
    // anatomy (ADR-058). This is the exact vocabulary of the Fix PhaseChip beside it.
    const downloading = page
      .getByTestId('parity-activity-grid')
      .locator('.poster-card', { hasText: 'Downloading Now' });
    await expect(downloading.locator('.media-card__badges .badge')).toHaveCount(1);
    await expect(downloading.locator('.badge--live .badge__fill')).toHaveCount(1);
    await expect(downloading.locator('.badge--pulse .badge__dot')).toHaveCount(1);

    // The wall posters wear the same badge (the #272 residual, now wired).
    await expect(
      page.getByTestId('parity-wall-grid').locator('.poster-card', { hasText: 'A Wanted Book' }).locator('.badge__fill'),
    ).toHaveCount(1);

    // The reference column renders the Fix PhaseChip + ProgressMeter (the idiom parity is a single glance).
    await expect(page.getByTestId('parity-fix').locator('.phase-chip')).not.toHaveCount(0);
    await expect(page.getByTestId('parity-fix').locator('.progress-meter')).toHaveCount(1);
  });

  test('reference captures — dark × desktop/390 (the standing side-by-side artifact)', async ({
    browser,
  }, testInfo) => {
    for (const [label, viewport] of [
      ['desktop', { width: 1280, height: 900 }],
      ['390', { width: 390, height: 844 }],
    ] as const) {
      const context = await browser.newContext({ viewport, baseURL: testInfo.project.use.baseURL });
      const page = await context.newPage();
      await openParity(page);
      await page.addStyleTag({ content: 'nextjs-portal { display: none !important; }' });
      const path = testInfo.outputPath(`activity-fix-parity-${label}-dark.png`);
      await page.screenshot({ path, fullPage: true });
      await testInfo.attach(`activity-fix-parity-${label}-dark`, { path, contentType: 'image/png' });
      await context.close();
    }
  });
});
