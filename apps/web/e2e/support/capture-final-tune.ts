// DESIGN-015/011 amendment screenshot harness — the two owner-review shots for the final fine-tune:
//   1. the "Last-call warning" setting row in the General Trash-settings Notifications area;
//   2. a CLOSED-window batch header + countdown showing the honest next-sweep time.
// Boots the SAME hermetic stack the e2e suite uses (startStack), signs in as admin, and captures each
// as a full PNG plus a compressed -small.jpg (< 300 KB) for chat-sized review.
//
//   pnpm --filter web exec tsx e2e/support/capture-final-tune.ts <output-dir>
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { chromium, expect, type Locator, type Page } from '@playwright/test';
import { startStack, type RunningStack } from './harness';

const OUT = process.argv[2] ?? '';
if (OUT === '') {
  console.error('usage: tsx e2e/support/capture-final-tune.ts <output-dir>');
  process.exit(1);
}
mkdirSync(OUT, { recursive: true });

const PORT = 3221;

async function settle(page: Page): Promise<void> {
  await page.addStyleTag({ content: 'nextjs-portal { display: none !important; }' });
  await page.waitForTimeout(300);
}

async function shootEl(loc: Locator, name: string): Promise<void> {
  await loc.scrollIntoViewIfNeeded();
  await settle(loc.page());
  await loc.screenshot({ path: join(OUT, `${name}.png`) });
  await loc.screenshot({ path: join(OUT, `${name}-small.jpg`), type: 'jpeg', quality: 70 });
  console.log(`[capture] ${name}`);
}

async function shootClip(
  page: Page,
  clip: { x: number; y: number; width: number; height: number },
  name: string,
): Promise<void> {
  await settle(page);
  await page.screenshot({ path: join(OUT, `${name}.png`), clip });
  await page.screenshot({ path: join(OUT, `${name}-small.jpg`), clip, type: 'jpeg', quality: 70 });
  console.log(`[capture] ${name}`);
}

async function login(page: Page): Promise<void> {
  await page.goto('/login');
  await page.getByRole('button', { name: 'Sign in with Plex (Authentik)' }).click();
  await page.waitForURL('**/');
}

async function main(): Promise<void> {
  const stack: RunningStack = await startStack({ port: PORT, prewarm: false, cwd: process.cwd() });
  try {
    await fetch(`${stack.oidc.baseUrl}/_control/user`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ persona: 'admin' }),
    });

    const browser = await chromium.launch();
    const desktop = await browser.newContext({
      viewport: { width: 1180, height: 1000 },
      baseURL: stack.appUrl,
    });
    const page = await desktop.newPage();
    await page.evaluate(() => localStorage.setItem('hnet-theme', 'hnet-dark')).catch(() => undefined);
    await login(page);
    await page.evaluate(() => localStorage.setItem('hnet-theme', 'hnet-dark'));

    // ── SHOT 1 — the Last-call warning setting row (General → Notifications) ────────────────
    await page.goto('/settings/trash?tab=general');
    await page.locator('html[data-theme="hnet-dark"]').waitFor();
    await page.getByTestId('final-warning-row').waitFor();
    // Wait for the settings query to POPULATE the fields (the defaults: delivery window 0/24, final
    // warning ON + 2h) before shooting, so the row shows real values not empty loading placeholders.
    await expect(page.getByTestId('notify-start')).toHaveValue('0');
    await expect(page.getByTestId('final-warning-hours')).toHaveValue('2');
    await shootEl(page.getByTestId('notify-window'), 'final-warning-notifications-dark');
    await shootEl(page.getByTestId('final-warning-row'), 'final-warning-row-dark');

    // ── Green-light a Movies batch (dev-server-driven Maintainerr) with a 14-day window ─────
    await page.goto('/trash?tab=movies');
    await page.getByTestId('batch-start').waitFor();
    await page.getByTestId('batch-start').click();
    await page.getByTestId('batch-start-modal').waitFor();
    await page.getByTestId('batch-start-submit').click();
    await page.getByTestId('batch-greenlight').waitFor();
    await page.getByTestId('batch-greenlight').click();
    await page.getByTestId('batch-greenlight-submit').waitFor();
    await page.getByTestId('batch-window-days').fill('14');
    await page.getByTestId('batch-greenlight-submit').click();
    await page.getByTestId('batch-countdown').waitFor();

    // ── SHOT 2 (pre-expiry) — the OPEN countdown naming the concrete next-sweep time ────────
    await shootEl(page.getByTestId('batch-countdown'), 'open-window-countdown-dark');

    // ── SHOT 3 (post-expiry) — fast-forward the CLIENT clock 20 days past the deadline (a fresh
    // page in the same authed context) so the window reads CLOSED and the "window closed — deletes
    // at 11:45 PM" sweep copy shows, WITHOUT touching server data (the batch stays leaving_soon). ──
    const cp = await desktop.newPage();
    await cp.clock.install({ time: new Date(Date.now() + 20 * 24 * 60 * 60 * 1000) });
    await cp.evaluate(() => localStorage.setItem('hnet-theme', 'hnet-dark')).catch(() => undefined);
    await cp.goto('/trash?tab=movies');
    await cp.locator('html[data-theme="hnet-dark"]').waitFor().catch(() => undefined);
    await cp.getByTestId('batch-countdown').waitFor();

    const panel = cp.getByTestId('batch-panel');
    const box = await panel.boundingBox();
    if (box) {
      await shootClip(
        cp,
        { x: box.x, y: box.y, width: box.width, height: Math.min(box.height, 190) },
        'closed-window-header-dark',
      );
    }
    await shootEl(cp.getByTestId('batch-countdown'), 'closed-window-countdown-dark');
    await shootEl(cp.getByTestId('batch-lifecycle'), 'closed-window-lifecycle-dark');

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
