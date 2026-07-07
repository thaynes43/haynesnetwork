// Screenshot harness for the PLAN-012 poster-wall UX (owner visual sign-off — the memory rule:
// screenshot approval before ship). Boots the SAME hermetic stack the e2e suite uses, walks a
// movie batch through admin review → Leaving Soon → expiry, and captures the states the owner
// judges: the wall with an X/lock mix (desktop + mobile, dark + light), the Green-light Modal,
// the countdown banner, the Expire report, and the settings card.
//
//   pnpm --filter web exec tsx e2e/support/capture-batches-ux.ts /path/to/outdir
//
// Each state lands as a full PNG plus a compressed -small.jpg (< 300 KB) for chat-sized review.
import { mkdirSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { chromium, type Page } from '@playwright/test';
import { startStack } from './harness';

const OUT = process.argv[2] ?? '';
if (OUT === '') {
  console.error('usage: tsx e2e/support/capture-batches-ux.ts <output-dir>');
  process.exit(1);
}
mkdirSync(OUT, { recursive: true });

const PORT = 3210;

async function shoot(page: Page, name: string, fullPage = false): Promise<void> {
  // Hide the Next dev-tools badge (dev server only) so frames are clean.
  await page.addStyleTag({ content: 'nextjs-portal { display: none !important; }' });
  // Lazy posters: wait for every mounted <img> to settle (load OR error) before the shot.
  await page.evaluate(() =>
    Promise.all(
      Array.from(document.images).map((img) =>
        img.complete
          ? undefined
          : new Promise((resolve) => {
              img.onload = resolve;
              img.onerror = resolve;
            }),
      ),
    ),
  );
  await page.waitForTimeout(350); // let overlay pops/theme swaps settle
  await page.screenshot({ path: join(OUT, `${name}.png`), fullPage });
  await page.screenshot({
    path: join(OUT, `${name}-small.jpg`),
    fullPage,
    type: 'jpeg',
    quality: 68,
  });
  console.log(`[capture] ${name}`);
}

/** Pin the app theme (no stored theme follows the OS scheme — pin it so names are honest). */
async function setTheme(page: Page, theme: 'hnet-dark' | 'hnet-light'): Promise<void> {
  await page.evaluate((t) => localStorage.setItem('hnet-theme', t), theme);
  await page.reload();
  await page.locator(`html[data-theme="${theme}"]`).waitFor();
}

async function main(): Promise<void> {
  const stack = await startStack({ port: PORT, prewarm: false, cwd: process.cwd() });
  try {
    await fetch(`${stack.oidc.baseUrl}/_control/user`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ persona: 'admin' }),
    });

    const browser = await chromium.launch();
    const context = await browser.newContext({
      viewport: { width: 1280, height: 860 },
      baseURL: stack.appUrl,
    });
    const page = await context.newPage();

    // Sign in (real stub-OIDC round trip) and set up: create the movie batch, rescue one item.
    await page.goto('/login');
    await page.getByRole('button', { name: 'Sign in with Plex (Authentik)' }).click();
    await page.waitForURL('**/');
    await page.goto('/trash?tab=batches');
    await page.getByTestId('batch-create').click();
    await page.getByTestId('wall-tile').filter({ hasText: 'Vanished Heist' }).getByRole('button').click();
    await page
      .getByTestId('wall-tile')
      .filter({ hasText: 'Vanished Heist' })
      .and(page.locator('[data-glyph="lock"]'))
      .waitFor();

    // 1) The admin-review wall (X/lock/eye/shield mix) — dark then light, desktop.
    await setTheme(page, 'hnet-dark');
    await page.getByTestId('batch-wall').waitFor();
    await shoot(page, 'wall-admin-review-dark');
    await setTheme(page, 'hnet-light');
    await page.getByTestId('batch-wall').waitFor();
    await shoot(page, 'wall-admin-review-light');

    // 2) The same wall at phone width (390×844), both themes.
    const mobile = await context.browser()!.newContext({
      viewport: { width: 390, height: 844 },
      baseURL: stack.appUrl,
    });
    const mpage = await mobile.newPage();
    await mpage.goto(`${stack.appUrl}/trash?tab=batches`); // same session? separate context → sign in
    await mpage.getByRole('button', { name: 'Sign in with Plex (Authentik)' }).click();
    await mpage.waitForURL('**/');
    await mpage.goto('/trash?tab=batches');
    await setTheme(mpage, 'hnet-dark');
    await mpage.getByTestId('batch-wall').waitFor();
    await shoot(mpage, 'wall-mobile-390-dark');
    await setTheme(mpage, 'hnet-light');
    await mpage.getByTestId('batch-wall').waitFor();
    await shoot(mpage, 'wall-mobile-390-light');
    await mobile.close();

    // 3) The Green-light Modal (light), then green-light for the countdown state (dark).
    await page.getByTestId('batch-greenlight').click();
    await page.getByTestId('batch-greenlight-confirm').waitFor();
    await shoot(page, 'greenlight-modal-light');
    await page.getByTestId('batch-greenlight-submit').click();
    await page.getByTestId('batch-countdown').waitFor();
    await setTheme(page, 'hnet-dark');
    await page.getByTestId('batch-countdown').waitFor();
    await shoot(page, 'leaving-soon-countdown-dark');

    // 4) The settings card (admin) — full page bottom.
    await page.getByTestId('trash-settings').scrollIntoViewIfNeeded();
    await shoot(page, 'settings-card-dark');

    // 5) Expiry: cancel the windowed batch, rebuild one, backdate-green-light it via the domain
    //    helper, then run Expire now for the report Modal.
    await page.getByTestId('batch-cancel').click();
    await page.waitForTimeout(400);
    await page.getByTestId('batch-cancel').click();
    await page.getByTestId('batch-state').filter({ hasText: 'Cancelled' }).waitFor();
    // Clear the stub's exclusions (the step-1 save) so the sweep has a genuinely cold item to
    // delete — the report should show every fate, including a real deletion.
    await fetch(`${stack.maintainerr.baseUrl}/_stub/reset`, { method: 'POST' });
    await page.getByTestId('batch-create').click();
    await page.getByTestId('batch-state').filter({ hasText: 'Admin review' }).waitFor();
    // Async spawn (NOT spawnSync): the stub Maintainerr lives in THIS process, and the helper
    // talks to it — a synchronous wait would deadlock the stub's event loop.
    await new Promise<void>((resolve, reject) => {
      const child = spawn(
        join(process.cwd(), 'node_modules', '.bin', 'tsx'),
        [join(process.cwd(), 'e2e', 'support', 'greenlight-expired.ts'), 'movie'],
        { env: { ...process.env, ...stack.env }, stdio: 'inherit' },
      );
      child.on('exit', (code) =>
        code === 0 ? resolve() : reject(new Error(`greenlight-expired failed (exit ${code})`)),
      );
      child.on('error', reject);
    });
    await page.reload();
    await page.getByTestId('batch-expire').click();
    await page.getByTestId('batch-expire-confirm').waitFor();
    await shoot(page, 'expire-confirm-dark');
    await page.getByTestId('batch-expire-submit').click();
    await page.getByTestId('batch-expire-report').waitFor();
    await shoot(page, 'expire-report-dark');
    await page.getByRole('button', { name: 'Done' }).click();

    // 6) The terminal wall (deleted/skipped/shield glyphs).
    await page.getByTestId('batch-state').filter({ hasText: 'Deleted' }).waitFor();
    await shoot(page, 'wall-terminal-dark');

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
