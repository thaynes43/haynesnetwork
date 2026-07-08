// ADR-033 screenshot harness — the per-kind Trash lifecycle (Batches folded into Movies/TV) and
// the context-aware item back-link. Boots the SAME hermetic stack the e2e suite uses, then walks
// the Movies tab through every lifecycle STATE (no batch · admin_review + new-candidates strip ·
// leaving_soon countdown · terminal + past-batches expanded), on desktop dark/light and phone 390,
// plus the "← Trash Movies" back link on an item page.
//
//   pnpm --filter web exec tsx e2e/support/capture-trash-merge-ux.ts <output-dir>
//
// Each state lands as a full PNG plus a compressed -small.jpg (< 300 KB) for chat-sized review.
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { chromium, expect, type Locator, type Page } from '@playwright/test';
import { startStack, type RunningStack } from './harness';

/** Drive a two-step ConfirmButton (arm → wait past MIN_ARM_MS → confirm). */
async function armAndConfirm(button: Locator): Promise<void> {
  await button.click();
  await expect(button).toHaveText('Confirm?');
  await button.page().waitForTimeout(350);
  await button.click();
}

const OUT = process.argv[2] ?? '';
if (OUT === '') {
  console.error('usage: tsx e2e/support/capture-trash-merge-ux.ts <output-dir>');
  process.exit(1);
}
mkdirSync(OUT, { recursive: true });

const PORT = 3216;

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
    quality: 60,
  });
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
}

async function openMovies(page: Page): Promise<void> {
  await page.goto('/trash?tab=movies');
  await page.getByTestId('kind-tab').waitFor();
}

async function main(): Promise<void> {
  const stack: RunningStack = await startStack({ port: PORT, prewarm: false, cwd: process.cwd() });
  const addPending = () =>
    fetch(`${stack.maintainerr.baseUrl}/_stub/add-pending`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        collectionId: 7,
        mediaServerId: 'ms-990010',
        tmdbId: 990010,
        sizeBytes: 3_221_225_472,
      }),
    });
  try {
    await fetch(`${stack.oidc.baseUrl}/_control/user`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ persona: 'admin' }),
    });

    const browser = await chromium.launch();
    const desktop = await browser.newContext({
      viewport: { width: 1280, height: 900 },
      baseURL: stack.appUrl,
    });
    const mobile = await browser.newContext({
      viewport: { width: 390, height: 844 },
      baseURL: stack.appUrl,
    });
    const page = await desktop.newPage();
    const mpage = await mobile.newPage();
    await login(page);
    await login(mpage);

    // ── STATE 1 — no open batch: the live-candidates wall + "Start a batch" ────────────────
    await openMovies(page);
    await setTheme(page, 'hnet-dark');
    await page.getByTestId('trash-wall').waitFor();
    await shoot(page, 'movies-nobatch-desktop-dark', true);
    await setTheme(page, 'hnet-light');
    await page.getByTestId('trash-wall').waitFor();
    await shoot(page, 'movies-nobatch-desktop-light', true);
    await setTheme(page, 'hnet-dark');

    await openMovies(mpage);
    await setTheme(mpage, 'hnet-dark');
    await mpage.getByTestId('trash-wall').waitFor();
    await shoot(mpage, 'movies-nobatch-mobile-dark', true);

    // ── The item back-link: open a ledger-joined poster via its corner library link ────────
    await page
      .getByTestId('trash-tile')
      .filter({ hasText: 'The Fixture' })
      .getByTestId('wall-lib-link')
      .click();
    await page.waitForURL(/\/library\/[0-9a-f-]{36}\?from=trash-movies$/);
    await page.getByTestId('back-link').waitFor();
    await shoot(page, 'item-backlink-desktop-dark');

    // ── STATE 2 — admin_review (+ the new-candidates strip) ────────────────────────────────
    await openMovies(page);
    await page.getByTestId('batch-start').click();
    await page.getByTestId('batch-state').waitFor();
    await addPending(); // a fresh candidate joins the LIVE set but not the frozen batch
    await openMovies(page);
    await page.getByTestId('batch-new-candidates').waitFor();
    await shoot(page, 'admin-review-desktop-dark', true);
    await setTheme(page, 'hnet-light');
    await page.getByTestId('batch-wall').waitFor();
    await shoot(page, 'admin-review-desktop-light', true);
    await setTheme(page, 'hnet-dark');

    await openMovies(mpage);
    await mpage.getByTestId('batch-wall').waitFor();
    await shoot(mpage, 'admin-review-mobile-dark', true);

    // ── STATE 3 — leaving_soon: the countdown + family save wall ───────────────────────────
    await page.getByTestId('batch-greenlight').click();
    await page.getByTestId('batch-window-days').fill('14');
    await page.getByTestId('batch-greenlight-submit').click();
    await page.getByTestId('batch-countdown').waitFor();
    await shoot(page, 'leaving-soon-desktop-dark', true);

    await openMovies(mpage);
    await mpage.getByTestId('batch-countdown').waitFor();
    await shoot(mpage, 'leaving-soon-mobile-dark', true);

    // ── STATE 4 — terminal: cancel → the Past-batches strip (expanded) ─────────────────────
    await openMovies(page); // fresh desktop state before the two-step confirm
    await page.getByTestId('batch-cancel').waitFor();
    await armAndConfirm(page.getByTestId('batch-cancel'));
    // Cancel is terminal ⇒ the pending wall returns + the Past-batches strip appears.
    await page.getByTestId('trash-wall').waitFor();
    await page.getByTestId('batch-history').waitFor();
    await page.getByTestId('batch-history-row').first().click(); // expand the final report
    await page.getByTestId('batch-wall').waitFor();
    await shoot(page, 'past-batches-desktop-dark', true);

    await openMovies(mpage);
    await mpage.getByTestId('batch-history').waitFor();
    await mpage.getByTestId('batch-history-row').first().click();
    await mpage.getByTestId('batch-wall').waitFor();
    await shoot(mpage, 'past-batches-mobile-dark', true);

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
