// Screenshot harness for the Metrics → Apps sub-tab (PLAN-018 / DESIGN-018 — owner visual sign-off).
// Boots the SAME hermetic stack the e2e suite uses (stub OIDC persona=admin + stub Prometheus, which
// serves the *arr/downloader instant vectors added to stub-prometheus.ts), then captures the Apps tab:
// desktop dark + light and 390px mobile dark + light.
//
//   pnpm --filter web exec tsx e2e/support/capture-metrics-apps.ts <output-dir>
//
// Each state lands as a full PNG plus a compressed -small.jpg for chat review. This is the sanctioned
// hermetic substitution for the owner's live-auth admin view (live staging needs Authentik SSO).
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { chromium, type Browser, type Page } from '@playwright/test';
import { startStack } from './harness';

const OUT = process.argv[2] ?? '';
if (OUT === '') {
  console.error('usage: tsx e2e/support/capture-metrics-apps.ts <output-dir>');
  process.exit(1);
}
mkdirSync(OUT, { recursive: true });

const PORT = 3215;

async function settle(page: Page): Promise<void> {
  await page.addStyleTag({ content: 'nextjs-portal { display: none !important; }' });
  await page.waitForTimeout(400);
}

async function shoot(page: Page, name: string): Promise<void> {
  await settle(page);
  await page.screenshot({ path: join(OUT, `${name}.png`), fullPage: true });
  await page.screenshot({
    path: join(OUT, `${name}-small.jpg`),
    type: 'jpeg',
    quality: 70,
    fullPage: true,
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
  await page.locator('.greeting').waitFor();
}

async function openAppsTab(page: Page): Promise<void> {
  await page.goto('/metrics?tab=apps');
  await page.getByTestId('metrics-apps').waitFor();
  await page.getByTestId('metrics-apps-indexers').waitFor();
}

async function main(): Promise<void> {
  const stack = await startStack({ port: PORT, prewarm: false, cwd: process.cwd() });
  await fetch(`${stack.oidc.baseUrl}/_control/user`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ persona: 'admin' }),
  });

  let browser: Browser | undefined;
  try {
    browser = await chromium.launch();

    // ── Desktop 1280 — dark + light ───────────────────────────────────────────────────────
    const desktop = await browser.newContext({
      viewport: { width: 1280, height: 900 },
      baseURL: stack.appUrl,
    });
    const dpage = await desktop.newPage();
    await login(dpage);
    await setTheme(dpage, 'hnet-dark');
    await openAppsTab(dpage);
    await shoot(dpage, 'apps-desktop-dark');
    await setTheme(dpage, 'hnet-light');
    await openAppsTab(dpage);
    await shoot(dpage, 'apps-desktop-light');
    await desktop.close();

    // ── Mobile 390 — the curated groups + tables must stay legible ────────────────────────
    const mobile = await browser.newContext({
      viewport: { width: 390, height: 844 },
      baseURL: stack.appUrl,
    });
    const mpage = await mobile.newPage();
    await login(mpage);
    await setTheme(mpage, 'hnet-dark');
    await openAppsTab(mpage);
    await shoot(mpage, 'apps-mobile390-dark');
    await setTheme(mpage, 'hnet-light');
    await openAppsTab(mpage);
    await shoot(mpage, 'apps-mobile390-light');
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
