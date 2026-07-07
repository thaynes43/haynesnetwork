// Screenshot harness for the Trash PENDING WALL (2026-07-07 — the Movies/TV pending tables
// became poster walls; owner visual sign-off). Boots the SAME hermetic stack the e2e suite
// uses, then captures: (1) the Movies wall on desktop, dark + light, with the full glyph mix
// (inert protected check · filled saved-by-you shield · outline save · corner trash-cans);
// (2) the 390×844 phone wall (3-up — glyph legibility at this density is the bar); (3) the
// per-item Expedite confirm Modal; (4) the TV wall; (5) Recently Deleted at 390 (it stays a
// table — verify the card collapse).
//
//   pnpm --filter web exec tsx e2e/support/capture-trash-wall-ux.ts <output-dir>
//
// Each state lands as a full PNG plus a compressed -small.jpg (< 300 KB) for chat-sized review.
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { chromium, type Page, type Locator } from '@playwright/test';
import { startStack } from './harness';

const OUT = process.argv[2] ?? '';
if (OUT === '') {
  console.error('usage: tsx e2e/support/capture-trash-wall-ux.ts <output-dir>');
  process.exit(1);
}
mkdirSync(OUT, { recursive: true });

const PORT = 3213;

async function settle(page: Page): Promise<void> {
  await page.addStyleTag({ content: 'nextjs-portal { display: none !important; }' });
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
  await page.waitForTimeout(350);
}

async function shoot(page: Page, name: string, fullPage = false): Promise<void> {
  await settle(page);
  await page.screenshot({ path: join(OUT, `${name}.png`), fullPage });
  await page.screenshot({
    path: join(OUT, `${name}-small.jpg`),
    fullPage,
    type: 'jpeg',
    quality: 68,
  });
  console.log(`[capture] ${name}`);
}

async function shootEl(page: Page, el: Locator, name: string): Promise<void> {
  await settle(page);
  await el.screenshot({ path: join(OUT, `${name}.png`) });
  await el.screenshot({ path: join(OUT, `${name}-small.jpg`), type: 'jpeg', quality: 72 });
  console.log(`[capture] ${name} (element)`);
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
}

async function openMoviesWall(page: Page): Promise<void> {
  await page.goto('/trash?tab=movies');
  await page.getByTestId('trash-wall').waitFor();
}

/** Save "Vanished Heist" through the wall shield so the FILLED saved-by-you state shows. */
async function saveVanished(page: Page): Promise<void> {
  const shield = page
    .getByTestId('trash-tile')
    .filter({ hasText: 'Vanished Heist' })
    .getByTestId('trash-shield');
  const settled = page.waitForResponse((r) => r.url().includes('trash.saveExclusion'));
  await shield.click();
  await settled;
  await page
    .locator('[data-testid="trash-tile"]', { hasText: 'Vanished Heist' })
    .locator('[data-glyph="shield"]')
    .waitFor();
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

    // ── Desktop (1280×860) — the Expedite Modal FIRST (Vanished is still cold/deletable) ──
    const context = await browser.newContext({
      viewport: { width: 1280, height: 860 },
      baseURL: stack.appUrl,
    });
    const page = await context.newPage();
    await login(page);
    await openMoviesWall(page);
    await setTheme(page, 'hnet-dark');
    await page.getByTestId('trash-wall').waitFor();
    await page
      .getByTestId('trash-tile')
      .filter({ hasText: 'Vanished Heist' })
      .getByTestId('trash-expedite-item')
      .click();
    await page.getByTestId('trash-expedite-item-confirm').waitFor();
    await shoot(page, 'expedite-modal-dark');
    await page.getByRole('button', { name: 'Cancel' }).click();

    // ── Movies wall, dark, with the full glyph mix (save Vanished → filled shield) ─────────
    await saveVanished(page);
    await shoot(page, 'movies-wall-desktop-dark');
    await shootEl(page, page.getByTestId('trash-wall'), 'movies-wall-tiles-dark');

    // ── Light theme ─────────────────────────────────────────────────────────────────────────
    await setTheme(page, 'hnet-light');
    await page.getByTestId('trash-wall').waitFor();
    await shoot(page, 'movies-wall-desktop-light');
    await setTheme(page, 'hnet-dark');

    // ── TV wall ─────────────────────────────────────────────────────────────────────────────
    await page.goto('/trash?tab=tv');
    await page.getByTestId('trash-wall').waitFor();
    await shoot(page, 'tv-wall-desktop-dark');

    // ── Mobile (390×844) — 3-up wall; glyph legibility at this density is the bar ───────────
    const mobile = await browser.newContext({
      viewport: { width: 390, height: 844 },
      baseURL: stack.appUrl,
    });
    const mpage = await mobile.newPage();
    await login(mpage);
    await openMoviesWall(mpage);
    await setTheme(mpage, 'hnet-dark');
    await mpage.getByTestId('trash-wall').waitFor();
    await shoot(mpage, 'movies-wall-mobile-dark', true);

    // Recently Deleted stays a table (it's a log) — verify the 390px card collapse.
    await mpage.goto('/trash?tab=deleted');
    await mpage.getByTestId('trash-deleted').waitFor();
    await shoot(mpage, 'recently-deleted-mobile-dark', true);
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
