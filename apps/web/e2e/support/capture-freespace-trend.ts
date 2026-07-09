// Screenshot harness for the native free-space trend chart (ADR-030 C-04 amendment 2026-07-09 /
// DESIGN-013 D-07 — owner visual sign-off). Boots the SAME hermetic stack the e2e suite uses
// (stub Prometheus synthesizes the exportarr matrix), then captures the Storage tab's trend card:
// desktop dark + light, the 7d window, 390px mobile, and the Prometheus-down degraded state.
//
//   pnpm --filter web exec tsx e2e/support/capture-freespace-trend.ts <output-dir>
//
// Each state lands as a full PNG plus a compressed -small.jpg (< 300 KB) for chat review.
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { chromium, type Browser, type Locator, type Page } from '@playwright/test';
import { startStack } from './harness';

const OUT = process.argv[2] ?? '';
if (OUT === '') {
  console.error('usage: tsx e2e/support/capture-freespace-trend.ts <output-dir>');
  process.exit(1);
}
mkdirSync(OUT, { recursive: true });

const PORT = 3214;

async function settle(page: Page): Promise<void> {
  await page.addStyleTag({ content: 'nextjs-portal { display: none !important; }' });
  await page.waitForTimeout(400);
}

async function shoot(target: Page | Locator, page: Page, name: string): Promise<void> {
  await settle(page);
  await target.screenshot({ path: join(OUT, `${name}.png`) });
  await target.screenshot({ path: join(OUT, `${name}-small.jpg`), type: 'jpeg', quality: 70 });
  console.log(`[capture] ${name}`);
}

async function setTheme(page: Page, theme: 'hnet-dark' | 'hnet-light'): Promise<void> {
  await page.evaluate((t) => localStorage.setItem('hnet-theme', t), theme);
  await page.reload();
  await page.locator(`html[data-theme="${theme}"]`).waitFor();
}

async function login(page: Page): Promise<void> {
  await page.goto('/login');
  await page.getByRole('button', { name: 'Sign in with Plex (Authentik)' }).click();
  await page.waitForURL('**/');
  await page.locator('.greeting').waitFor();
}

async function openStorageTab(page: Page): Promise<void> {
  await page.goto('/settings/trash?tab=storage');
  await page.getByTestId('storage-trend').waitFor();
}

async function main(): Promise<void> {
  const stack = await startStack({ port: PORT, prewarm: false, cwd: process.cwd() });
  const promMode = (mode: 'ok' | 'down') =>
    fetch(`${stack.prometheus.baseUrl}/_stub/state`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ mode }),
    });
  await fetch(`${stack.oidc.baseUrl}/_control/user`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ persona: 'admin' }),
  });

  let browser: Browser | undefined;
  try {
    browser = await chromium.launch();

    // ── Desktop 1280 — dark, light, and the 7d window ────────────────────────────────────
    const desktop = await browser.newContext({
      viewport: { width: 1280, height: 900 },
      baseURL: stack.appUrl,
    });
    const dpage = await desktop.newPage();
    await login(dpage);
    await setTheme(dpage, 'hnet-dark');
    await openStorageTab(dpage);
    await dpage.getByTestId('trend-chart').waitFor();
    const darkCard = dpage.getByTestId('storage-trend');
    await shoot(darkCard, dpage, 'trend-desktop-dark');
    await shoot(dpage, dpage, 'storage-tab-desktop-dark');

    await dpage.getByTestId('trend-window-7d').click();
    await dpage.locator('.storage-trend__plotwrap[data-window="7d"]').waitFor();
    await dpage.locator('.storage-trend__plotwrap:not([data-refreshing])').waitFor();
    await shoot(darkCard, dpage, 'trend-desktop-dark-7d');
    await dpage.getByTestId('trend-window-30d').click();
    await dpage.locator('.storage-trend__plotwrap[data-window="30d"]').waitFor();

    await setTheme(dpage, 'hnet-light');
    await openStorageTab(dpage);
    await dpage.getByTestId('trend-chart').waitFor();
    await shoot(dpage.getByTestId('storage-trend'), dpage, 'trend-desktop-light');

    // ── Degraded: Prometheus down ⇒ the note, meters unaffected ──────────────────────────
    await promMode('down');
    await setTheme(dpage, 'hnet-dark');
    await openStorageTab(dpage);
    await dpage.getByTestId('trend-degraded').waitFor();
    await shoot(dpage.getByTestId('storage-trend'), dpage, 'trend-desktop-dark-degraded');
    await promMode('ok');
    await desktop.close();

    // ── Mobile 390 — the chart + stacked legend must stay legible ────────────────────────
    const mobile = await browser.newContext({
      viewport: { width: 390, height: 844 },
      baseURL: stack.appUrl,
    });
    const mpage = await mobile.newPage();
    await login(mpage);
    await setTheme(mpage, 'hnet-dark');
    await openStorageTab(mpage);
    await mpage.getByTestId('trend-chart').waitFor();
    await mpage.getByTestId('storage-trend').scrollIntoViewIfNeeded();
    await shoot(mpage.getByTestId('storage-trend'), mpage, 'trend-mobile390-dark');
    await setTheme(mpage, 'hnet-light');
    await openStorageTab(mpage);
    await mpage.getByTestId('trend-chart').waitFor();
    await mpage.getByTestId('storage-trend').scrollIntoViewIfNeeded();
    await shoot(mpage.getByTestId('storage-trend'), mpage, 'trend-mobile390-light');
    await mobile.close();
  } finally {
    await browser?.close().catch(() => undefined);
    await stack.stop();
  }
  console.log(`[capture] done → ${OUT}`);
}

main().catch((err: unknown) => {
  console.error('[capture] failed:', err);
  process.exit(1);
});
