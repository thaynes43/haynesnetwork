// PLAN-030 (ADR-048 / DESIGN-005 D-22, DESIGN-017 D-09) — screenshot harness for owner sign-off of the
// season-poster icon in Season rows + the episode-thumbnail parity. Boots the hermetic stack (stub Plex
// serves the Peloton drill-in hierarchy with season + episode thumbs + the /photo/:/transcode endpoint) and
// captures the ytdl-sub Peloton show-detail Seasons card — a season row with its small poster icon, and an
// expanded season's 16:9 episode stills — at 390px + desktop, dark + light. The TV show-detail uses the
// IDENTICAL season-poster / episode-still idiom (its art source is the *arr→Plex match; proven by the
// packages/api ledger-plex-art tests).
//
//   pnpm --filter web exec tsx e2e/support/capture-season-art.ts <output-dir>
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { chromium, type Browser, type Page } from '@playwright/test';
import { startStack } from './harness';
import type { PersonaName } from './stub-oidc';

async function setPersona(oidcBaseUrl: string, persona: PersonaName): Promise<void> {
  const res = await fetch(`${oidcBaseUrl}/_control/user`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ persona }),
  });
  if (res.status !== 204) throw new Error(`persona switch failed: HTTP ${res.status}`);
}

const OUT = process.argv[2] ?? '';
if (OUT === '') {
  console.error('usage: tsx e2e/support/capture-season-art.ts <output-dir>');
  process.exit(1);
}
mkdirSync(OUT, { recursive: true });

const PORT = 3221;

async function hidePortal(page: Page): Promise<void> {
  await page.addStyleTag({ content: 'nextjs-portal { display: none !important; }' });
}

async function setTheme(page: Page, theme: 'hnet-dark' | 'hnet-light'): Promise<void> {
  await page.evaluate((t) => localStorage.setItem('hnet-theme', t), theme);
  await page.reload();
  await page.locator(`html[data-theme="${theme}"]`).waitFor();
}

async function signInTo(
  browser: Browser,
  appUrl: string,
  viewport: { width: number; height: number },
): Promise<Page> {
  const context = await browser.newContext({ viewport, baseURL: appUrl, deviceScaleFactor: 2 });
  const page = await context.newPage();
  await page.goto('/login');
  await page.getByRole('button', { name: 'Sign in with Plex (Authentik)' }).click();
  await page.waitForURL('**/');
  return page;
}

/** Navigate to the Peloton drill-in, expand a season, wait for the poster icon + episode stills to load. */
async function openDrillIn(page: Page): Promise<void> {
  await page.goto('/library/ytdlsub/peloton/9001');
  await page.getByTestId('ytdlsub-detail-head').waitFor();
  // Expand "Season 30" (the stub season carrying a thumb + episode stills).
  await page.locator('summary.season__head', { hasText: 'Season 30' }).click();
  // The season-row poster icon + the first episode still (both proxied → the stub 1x1 PNG).
  await page.locator('.season__poster .poster-img').first().waitFor();
  await page.locator('.epi-still .poster-img, .epi-still').first().waitFor();
  await page.waitForTimeout(500);
}

async function shootSeasons(page: Page, name: string): Promise<void> {
  const card = page.locator('section.card.admin-section', { hasText: 'Seasons' });
  await card.first().scrollIntoViewIfNeeded();
  await page.waitForTimeout(200);
  await card.first().screenshot({ path: join(OUT, `${name}.png`) });
  console.log(`[capture] ${name}`);
}

async function main(): Promise<void> {
  const stack = await startStack({ port: PORT, prewarm: false, cwd: process.cwd() });
  try {
    const browser = await chromium.launch();
    await setPersona(stack.oidc.baseUrl, 'admin');

    // ── DESKTOP ──
    const page = await signInTo(browser, stack.appUrl, { width: 1120, height: 1000 });
    await openDrillIn(page);
    await hidePortal(page);
    await setTheme(page, 'hnet-dark');
    await openDrillIn(page);
    await hidePortal(page);
    await shootSeasons(page, 'seasons-desktop-dark');
    await setTheme(page, 'hnet-light');
    await openDrillIn(page);
    await hidePortal(page);
    await shootSeasons(page, 'seasons-desktop-light');

    // ── MOBILE 390 ──
    const m = await signInTo(browser, stack.appUrl, { width: 390, height: 900 });
    await setTheme(m, 'hnet-dark');
    await openDrillIn(m);
    await hidePortal(m);
    await shootSeasons(m, 'seasons-390-dark');
    await setTheme(m, 'hnet-light');
    await openDrillIn(m);
    await hidePortal(m);
    await shootSeasons(m, 'seasons-390-light');

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
