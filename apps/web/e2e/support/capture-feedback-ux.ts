// Screenshot harness for the PLAN-015 action-feedback UX (owner visual sign-off — the
// memory rule: screenshot approval before ship). Boots the SAME hermetic stack the e2e
// suite uses and captures the states the owner judges: the fix dialog mid-download
// (meter + ETA), the item row LOCKED behind the live chip, live My Fixes rows, a season
// roll-up with per-child phases, and the nothing_found terminal with its retry — dark +
// light + mobile 390.
//
//   pnpm --filter web exec tsx e2e/support/capture-feedback-ux.ts /path/to/outdir
//
// Each state lands as a full PNG plus a compressed -small.jpg (< 300 KB) for review.
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { chromium, type Page } from '@playwright/test';
import { startStack } from './harness';
import { STUB_SERIES_ID } from './stub-arr';

const OUT = process.argv[2] ?? '';
if (OUT === '') {
  console.error('usage: tsx e2e/support/capture-feedback-ux.ts <output-dir>');
  process.exit(1);
}
mkdirSync(OUT, { recursive: true });

const PORT = 3211;

async function shoot(page: Page, name: string): Promise<void> {
  await page.addStyleTag({ content: 'nextjs-portal { display: none !important; }' });
  await page.waitForTimeout(400);
  await page.screenshot({ path: join(OUT, `${name}.png`) });
  await page.screenshot({ path: join(OUT, `${name}-small.jpg`), type: 'jpeg', quality: 70 });
  console.log(`[capture] ${name}`);
}

async function setTheme(page: Page, theme: 'hnet-dark' | 'hnet-light'): Promise<void> {
  await page.evaluate((t) => localStorage.setItem('hnet-theme', t), theme);
  await page.reload();
  await page.locator(`html[data-theme="${theme}"]`).waitFor();
}

interface QueueStage {
  records: Record<string, unknown>[];
}
const staged: QueueStage = { records: [] };

async function stage(stubUrl: string, add: Record<string, unknown>[]): Promise<void> {
  staged.records = [...staged.records.filter((r) => !add.some((a) => a.id === r.id)), ...add];
  const res = await fetch(`${stubUrl}/_stub/queue`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ records: staged.records }),
  });
  if (!res.ok) throw new Error(`queue staging failed: ${res.status}`);
}

function episodeRecord(id: number, episodeId: number, pct: number, etaMin: number) {
  const size = 1_000_000_000;
  return {
    id,
    seriesId: STUB_SERIES_ID,
    episodeId,
    seasonNumber: episodeId >= 50_300 ? 2 : 1, // stub id scheme: 5010x = S1, 5030x = S2
    status: 'downloading',
    trackedDownloadStatus: 'ok',
    trackedDownloadState: 'downloading',
    size,
    sizeleft: Math.round(size * (1 - pct / 100)),
    estimatedCompletionTime: new Date(Date.now() + etaMin * 60_000).toISOString(),
    title: `Breaking.Prod.E${episodeId}.1080p.WEB-DL`,
  };
}

async function signIn(page: Page): Promise<void> {
  await page.goto('/login');
  await page.getByRole('button', { name: 'Sign in with Plex (Authentik)' }).click();
  await page.waitForURL('**/');
}

async function openSeries(page: Page): Promise<void> {
  await page.goto('/library');
  await page.getByRole('tab', { name: 'TV' }).click();
  await page.locator('.media-card').filter({ hasText: 'Breaking Prod' }).click();
  await page.waitForURL(/\/library\/[0-9a-f-]{36}$/);
  await page.locator('.detail-head__title').waitFor();
}

async function expandSeason(page: Page, name: string): Promise<void> {
  const season = page.locator('.season').filter({ hasText: name });
  await season.locator('.season__title').click();
}

/** Fix an episode, stage its download, and leave the dialog showing the live meter. */
async function fixEpisodeToDownloading(
  page: Page,
  stubUrl: string,
  episodeLabel: string,
  queueId: number,
  episodeId: number,
  pct: number,
  etaMin: number,
): Promise<void> {
  await openSeries(page);
  await expandSeason(page, 'Season 1');
  const row = page.locator('.child-row').filter({ hasText: episodeLabel });
  await row.getByRole('button', { name: 'Fix' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('radio', { name: 'Wrong version or quality' }).check();
  await dialog.getByRole('button', { name: 'Submit fix' }).click();
  await dialog.locator('.action-progress').waitFor({ timeout: 15_000 });
  await stage(stubUrl, [episodeRecord(queueId, episodeId, pct, etaMin)]);
  await dialog
    .locator('.phase-chip[data-phase="downloading"]')
    .waitFor({ timeout: 20_000 });
}

async function main(): Promise<void> {
  const stack = await startStack({ port: PORT, prewarm: false, cwd: process.cwd() });
  try {
    await fetch(`${stack.oidc.baseUrl}/_control/user`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ persona: 'admin' }),
    });
    const stubUrl = stack.arr.baseUrl;

    const browser = await chromium.launch();
    const context = await browser.newContext({
      viewport: { width: 1280, height: 860 },
      baseURL: stack.appUrl,
    });
    const page = await context.newPage();
    await signIn(page);
    await setTheme(page, 'hnet-dark');

    // 1) DARK — fix dialog mid-download (meter + ETA), then the locked row behind it.
    await fixEpisodeToDownloading(page, stubUrl, 'S01E05 · Chapter 5', 91, 50105, 62, 4);
    await shoot(page, 'fix-dialog-downloading-dark');
    await page.getByRole('dialog').getByRole('button', { name: 'Done' }).click();
    const lockedRow = page.locator('.child-row').filter({ hasText: 'S01E05 · Chapter 5' });
    await lockedRow.locator('.phase-chip[data-phase="downloading"]').waitFor({ timeout: 20_000 });
    await lockedRow.scrollIntoViewIfNeeded();
    await shoot(page, 'item-lock-downloading-dark');

    // 2) DARK — season roll-up: S02E02 already pulling bytes, S02E01 still searching.
    await stage(stubUrl, [episodeRecord(94, 50302, 50, 11)]);
    const season2 = page.locator('.season').filter({ hasText: 'Season 2' });
    await season2.locator('.season__head').getByRole('button', { name: 'Force Search' }).click();
    const rollDialog = page.getByRole('dialog');
    await rollDialog.getByRole('button', { name: 'Force search' }).click();
    await rollDialog.locator('.rollup__row .phase-chip[data-phase="downloading"]').waitFor({
      timeout: 20_000,
    });
    await shoot(page, 'season-rollup-expanded-dark');
    await rollDialog.getByRole('button', { name: 'Done' }).click();

    // 3) DARK — live My Fixes rows (compact chip + mini-meter in the table).
    await page.goto('/library');
    await page.getByRole('tab', { name: 'My Fixes' }).click();
    await page
      .locator('.admin-table .phase-chip[data-phase="downloading"]')
      .first()
      .waitFor({ timeout: 20_000 });
    await shoot(page, 'my-fixes-live-dark');

    // 4) DARK — the nothing_found terminal + retry (empty queue for the movie; the
    //    harness shortens the found-nothing window to 30 s).
    await page.goto('/library');
    await page.locator('.media-card').filter({ hasText: 'The Fixture' }).click();
    await page.waitForURL(/\/library\/[0-9a-f-]{36}$/);
    await page.locator('.detail-head__actions').getByRole('button', { name: 'Force Search' }).click();
    const searchDialog = page.getByRole('dialog');
    await searchDialog.getByRole('button', { name: 'Force search' }).click();
    await searchDialog.locator('.action-progress').waitFor({ timeout: 15_000 });
    await searchDialog
      .locator('.phase-chip[data-phase="nothing_found"]')
      .waitFor({ timeout: 60_000 });
    await shoot(page, 'nothing-found-retry-dark');
    await searchDialog.getByRole('button', { name: 'Done' }).click();

    // 5) LIGHT — repeat the money shots on a fresh grain (S01E06).
    await setTheme(page, 'hnet-light');
    await fixEpisodeToDownloading(page, stubUrl, 'S01E06 · Chapter 6', 92, 50106, 38, 12);
    await shoot(page, 'fix-dialog-downloading-light');
    await page.getByRole('dialog').getByRole('button', { name: 'Done' }).click();
    const lockedRowLight = page.locator('.child-row').filter({ hasText: 'S01E06 · Chapter 6' });
    await lockedRowLight
      .locator('.phase-chip[data-phase="downloading"]')
      .waitFor({ timeout: 20_000 });
    await lockedRowLight.scrollIntoViewIfNeeded();
    await shoot(page, 'item-lock-downloading-light');
    await page.goto('/library');
    await page.getByRole('tab', { name: 'My Fixes' }).click();
    await page
      .locator('.admin-table .phase-chip[data-phase="downloading"]')
      .first()
      .waitFor({ timeout: 20_000 });
    await shoot(page, 'my-fixes-live-light');

    // 6) MOBILE 390 (dark) — the dialog meter and the locked row at phone width.
    const mobile = await browser.newContext({
      viewport: { width: 390, height: 844 },
      baseURL: stack.appUrl,
    });
    const mpage = await mobile.newPage();
    await signIn(mpage);
    await setTheme(mpage, 'hnet-dark');
    await fixEpisodeToDownloading(mpage, stubUrl, 'S01E07 · Chapter 7', 93, 50107, 45, 7);
    await shoot(mpage, 'fix-dialog-downloading-mobile-390-dark');
    await mpage.getByRole('dialog').getByRole('button', { name: 'Done' }).click();
    const mrow = mpage.locator('.child-row').filter({ hasText: 'S01E07 · Chapter 7' });
    await mrow.locator('.phase-chip[data-phase="downloading"]').waitFor({ timeout: 20_000 });
    await mrow.scrollIntoViewIfNeeded();
    await shoot(mpage, 'item-lock-downloading-mobile-390-dark');
    await mobile.close();

    await browser.close();
  } finally {
    await stack.stop();
  }
  console.log(`[capture] done → ${OUT}`);
}

main().catch((err: unknown) => {
  console.error('[capture] failed:', err);
  process.exit(1);
});
