// Screenshot harness for the Metrics → Network sub-tab (PLAN-020 / ADR-039 / DESIGN-019 — owner visual
// sign-off + the privacy DoD). Boots the SAME hermetic stack the e2e suite uses (stub OIDC persona=admin
// + stub Prometheus serving the unpoller infra vectors), then captures the FULL Network view — WAN
// usage-vs-capacity meters + 7-day throughput sparkline + infra-performance groups (gateway/switches/
// APs/WAN-health/site-rollup) — at desktop dark/light + 390px dark/light.
//
//   pnpm --filter web exec tsx e2e/support/capture-metrics-network.ts <output-dir>
//
// This is the sanctioned hermetic substitution for the owner's live-auth admin view (live staging needs
// Authentik SSO). The FULL render is the strictest privacy check — it is the only level that renders any
// device grain, so if NO client hostname/MAC/IP appears here, none appears at `limited` either (limited
// is a strict subset: WAN meters + history only). The limited/full payload SEAM (limited omits `infra`
// and never fetches it) is proven by the @hnet/metrics + @hnet/api unit tests and spot-checked live.
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { chromium, type Browser, type Page } from '@playwright/test';
import { startStack } from './harness';

const OUT = process.argv[2] ?? '';
if (OUT === '') {
  console.error('usage: tsx e2e/support/capture-metrics-network.ts <output-dir>');
  process.exit(1);
}
mkdirSync(OUT, { recursive: true });

const PORT = 3216;

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

async function openNetworkTab(page: Page): Promise<void> {
  await page.goto('/metrics?tab=network');
  await page.getByTestId('metrics-network').waitFor();
  await page.getByTestId('metrics-net-upload-meter').waitFor();
  await page.getByTestId('metrics-net-gateway').waitFor();
  await page.getByTestId('metrics-net-site').waitFor();
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
    await openNetworkTab(dpage);
    await shoot(dpage, 'network-full-desktop-dark');
    await setTheme(dpage, 'hnet-light');
    await openNetworkTab(dpage);
    await shoot(dpage, 'network-full-desktop-light');
    await desktop.close();

    // ── Mobile 390 — the meters, sparkline, and device tables must stay legible ────────────
    const mobile = await browser.newContext({
      viewport: { width: 390, height: 844 },
      baseURL: stack.appUrl,
    });
    const mpage = await mobile.newPage();
    await login(mpage);
    await setTheme(mpage, 'hnet-dark');
    await openNetworkTab(mpage);
    await shoot(mpage, 'network-full-mobile390-dark');
    await setTheme(mpage, 'hnet-light');
    await openNetworkTab(mpage);
    await shoot(mpage, 'network-full-mobile390-light');
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
