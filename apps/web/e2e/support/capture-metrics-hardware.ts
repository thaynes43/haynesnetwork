// Screenshot harness for the Metrics → Hardware sub-tab (PLAN-019 / ADR-040 / DESIGN-020 — owner visual
// sign-off). Boots the SAME hermetic stack the e2e suite uses (stub OIDC persona=admin + stub Prometheus
// serving the smartctl + node + pve vectors), then captures the FULL Hardware view — the NVMe endurance
// panel (Cache-apps mirror vs Cache-staging expendable) + drive-health table + node load + the Proxmox
// host→VM showcase (expanded) — at desktop dark/light + 390px dark/light.
//
//   pnpm --filter web exec tsx e2e/support/capture-metrics-hardware.ts <output-dir>
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { chromium, type Browser, type Page } from '@playwright/test';
import { startStack } from './harness';

const OUT = process.argv[2] ?? '';
if (OUT === '') {
  console.error('usage: tsx e2e/support/capture-metrics-hardware.ts <output-dir>');
  process.exit(1);
}
mkdirSync(OUT, { recursive: true });

const PORT = 3219;

async function settle(page: Page): Promise<void> {
  await page.addStyleTag({ content: 'nextjs-portal { display: none !important; }' });
  await page.waitForTimeout(400);
}

async function shoot(page: Page, name: string): Promise<void> {
  await settle(page);
  await page.screenshot({ path: join(OUT, `${name}.png`), fullPage: true });
  await page.screenshot({ path: join(OUT, `${name}-small.jpg`), type: 'jpeg', quality: 70, fullPage: true });
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

async function openHardwareTab(page: Page): Promise<void> {
  await page.goto('/metrics?tab=hardware');
  await page.getByTestId('metrics-hardware').waitFor();
  await page.getByTestId('metrics-hw-pool-Cache-apps').waitFor();
  await page.getByTestId('metrics-hw-drives').waitFor();
  await page.getByTestId('metrics-hw-pve').waitFor();
  // Expand the first Proxmox host so the screenshot shows the host→VM in-place expansion.
  await page.getByTestId('metrics-hw-pve-HaynesIntelligence').locator('summary').click();
  await page.waitForTimeout(200);
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

    const desktop = await browser.newContext({ viewport: { width: 1280, height: 900 }, baseURL: stack.appUrl });
    const dpage = await desktop.newPage();
    await login(dpage);
    await setTheme(dpage, 'hnet-dark');
    await openHardwareTab(dpage);
    await shoot(dpage, 'hardware-full-desktop-dark');
    await setTheme(dpage, 'hnet-light');
    await openHardwareTab(dpage);
    await shoot(dpage, 'hardware-full-desktop-light');
    await desktop.close();

    const mobile = await browser.newContext({ viewport: { width: 390, height: 844 }, baseURL: stack.appUrl });
    const mpage = await mobile.newPage();
    await login(mpage);
    await setTheme(mpage, 'hnet-dark');
    await openHardwareTab(mpage);
    await shoot(mpage, 'hardware-full-mobile390-dark');
    await setTheme(mpage, 'hnet-light');
    await openHardwareTab(mpage);
    await shoot(mpage, 'hardware-full-mobile390-light');
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
