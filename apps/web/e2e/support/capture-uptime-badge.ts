// Screenshot harness for the front-page uptime badge (ADR-079 / DESIGN-004 D-25 — UX
// review evidence). Boots the SAME hermetic stack the e2e suite uses (stub Gatus serves
// the apex SLI), then captures Home: the up state (desktop dark + light + 390px mobile),
// the down state, and the honest unmeasured state (Gatus unreachable).
//
//   pnpm --filter web exec tsx e2e/support/capture-uptime-badge.ts <output-dir>
//
// Each state lands as a full PNG plus a compressed -small.jpg for chat review.
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { chromium, type Browser, type Page } from '@playwright/test';
import { startStack } from './harness';

const OUT = process.argv[2] ?? '';
if (OUT === '') {
  console.error('usage: tsx e2e/support/capture-uptime-badge.ts <output-dir>');
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
  await page.screenshot({ path: join(OUT, `${name}.png`) });
  await page.screenshot({ path: join(OUT, `${name}-small.jpg`), type: 'jpeg', quality: 70 });
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

async function main(): Promise<void> {
  const stack = await startStack({ port: PORT, prewarm: false, cwd: process.cwd() });
  const gatusState = (body: unknown) =>
    fetch(`${stack.gatus.baseUrl}/_stub/state`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });

  let browser: Browser | undefined;
  try {
    browser = await chromium.launch();
    const context = await browser.newContext({
      baseURL: stack.appUrl,
      viewport: { width: 1280, height: 800 },
    });
    const page = await context.newPage();
    await login(page);

    // Up state — desktop dark, desktop light, 390px mobile dark. Headless chromium
    // defaults the theme to light, so pin dark EXPLICITLY before the dark shots.
    await page.getByTestId('uptime-badge').waitFor();
    await setTheme(page, 'hnet-dark');
    await shoot(page, 'home-uptime-up-dark-desktop');
    await setTheme(page, 'hnet-light');
    await shoot(page, 'home-uptime-up-light-desktop');
    await setTheme(page, 'hnet-dark');
    await page.setViewportSize({ width: 390, height: 844 });
    await page.reload();
    await page.getByTestId('uptime-badge').waitFor();
    await shoot(page, 'home-uptime-up-dark-mobile390');
    await page.setViewportSize({ width: 1280, height: 800 });

    // Down state (danger tone, same anatomy).
    await gatusState({ mode: 'down' });
    await page.reload();
    await page.locator('[data-testid="uptime-badge"][data-state="down"]').waitFor();
    await shoot(page, 'home-uptime-down-dark-desktop');

    // Unmeasured state (Gatus unreachable — the honest muted pill).
    await gatusState({ mode: 'unreachable' });
    await page.reload();
    await page.locator('[data-testid="uptime-badge"][data-state="unmeasured"]').waitFor();
    await shoot(page, 'home-uptime-unmeasured-dark-desktop');
  } finally {
    await browser?.close().catch(() => undefined);
    await stack.stop();
  }
  console.log(`[capture] done → ${OUT}`);
}

main().catch((err: unknown) => {
  console.error('[capture] fatal:', err);
  process.exit(1);
});
