// Screenshot harness for DESIGN-010 D-12 (cross-server watch visibility — owner visual sign-off).
// Boots the SAME hermetic stack the e2e suite uses and captures BOTH watch-chip states + the
// detail-card last-watched line, in dark + light + mobile 390 (build C — the eye-corner bug fix):
//   • Vanished Heist — a SLATED (trash) movie watched ~1yr ago on HaynesKube: the MUTED meta-line
//     eye (info, not protection) with its "Last watched on HaynesKube · <Mon YYYY>" tooltip.
//   • The Fixture — recently-watched (3d) + requested: the SAVEABLE person-shield corner (no more
//     inert eye) + the INFO-tone "Watched recently on HaynesOps" meta chip.
//   • Breaking Prod (TV) — REQUESTED + watched-long-ago: the person-shield keeps the corner, the
//     watch info rides the muted caption (the documented precedence).
//   • The Fixture detail deletion card — the "Last watched on HaynesOps · <Mon YYYY>" line.
//
//   pnpm --filter web exec tsx e2e/support/capture-watch-vis.ts /path/to/outdir
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
  console.error('usage: tsx e2e/support/capture-watch-vis.ts <output-dir>');
  process.exit(1);
}
mkdirSync(OUT, { recursive: true });

const PORT = 3213;

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

async function shootTile(page: Page, hasText: string, name: string): Promise<void> {
  const tile = page.getByTestId('trash-tile').filter({ hasText });
  await tile.first().scrollIntoViewIfNeeded();
  await page.waitForTimeout(250);
  await tile.first().screenshot({ path: join(OUT, `${name}.png`) });
  console.log(`[capture] ${name}`);
}

async function main(): Promise<void> {
  const stack = await startStack({ port: PORT, prewarm: false, cwd: process.cwd() });
  try {
    const browser = await chromium.launch();
    await setPersona(stack.oidc.baseUrl, 'admin');

    // ── DESKTOP: single-tile crops (the muted indicator is small — capture it tight + retina). ──
    const page = await signInTo(browser, stack.appUrl, { width: 1120, height: 900 });
    await page.goto('/trash?tab=movies');
    await page.getByTestId('trash-tile').filter({ hasText: 'Vanished Heist' }).waitFor();
    await hidePortal(page);
    await page.waitForTimeout(400);

    await setTheme(page, 'hnet-dark');
    await hidePortal(page);
    await shootTile(page, 'Vanished Heist', 'tile-vanished-dark');
    await shootTile(page, 'The Fixture', 'tile-fixture-recent-dark');
    await setTheme(page, 'hnet-light');
    await hidePortal(page);
    await shootTile(page, 'Vanished Heist', 'tile-vanished-light');
    await shootTile(page, 'The Fixture', 'tile-fixture-recent-light');

    // TV: requested + watched-long-ago (person-shield corner + muted watch caption).
    await setTheme(page, 'hnet-dark');
    await hidePortal(page);
    await page.getByRole('tab', { name: 'TV' }).click();
    await page.getByTestId('trash-tile').filter({ hasText: 'Breaking Prod' }).waitFor();
    await shootTile(page, 'Breaking Prod', 'tile-tv-requested-dark');

    // The Fixture detail — the deletion card's last-watched line (dark + light).
    await page.getByRole('tab', { name: 'Movies' }).click();
    await page
      .getByTestId('trash-tile')
      .filter({ hasText: 'The Fixture' })
      .getByTestId('wall-lib-link')
      .click();
    await page.waitForURL(/\/library\/[0-9a-f-]{36}\?from=trash-movies$/);
    await page.getByTestId('trash-last-watched').waitFor();
    await hidePortal(page);
    await page.getByTestId('trash-guard').screenshot({ path: join(OUT, 'detail-card-dark.png') });
    console.log('[capture] detail-card-dark');
    await setTheme(page, 'hnet-light');
    await hidePortal(page);
    await page.getByTestId('trash-last-watched').waitFor();
    await page.getByTestId('trash-guard').screenshot({ path: join(OUT, 'detail-card-light.png') });
    console.log('[capture] detail-card-light');

    // ── MOBILE 390: the 3-col wall so the muted indicator reads in context. ──
    const m = await signInTo(browser, stack.appUrl, { width: 390, height: 850 });
    await m.goto('/trash?tab=movies');
    await m.getByTestId('trash-tile').filter({ hasText: 'Vanished Heist' }).waitFor();
    await hidePortal(m);
    await m.waitForTimeout(400);
    await setTheme(m, 'hnet-dark');
    await hidePortal(m);
    await m.getByTestId('trash-wall').screenshot({ path: join(OUT, 'wall-390-dark.png') });
    console.log('[capture] wall-390-dark');
    await setTheme(m, 'hnet-light');
    await hidePortal(m);
    await m.getByTestId('trash-wall').screenshot({ path: join(OUT, 'wall-390-light.png') });
    console.log('[capture] wall-390-light');

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
