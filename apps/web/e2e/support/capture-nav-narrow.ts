// Screenshot harness for the narrow-phone nav-overlap fix (fix/nav-overlap-narrow-phones).
// Boots the SAME hermetic stack the e2e suite uses, signs in as ADMIN (the five-link case:
// Home · Library · Trash · Bulletin · Metrics), and captures the topbar at the three widths
// that bracket the bug — 320 and 360 (below the 375px resize-matrix floor, where the theme
// toggle used to sit on top of the Metrics label) and 390 (the owner's phone, already fine)
// — in both themes. Run it on the pre-fix commit and again on the fix to produce before/after
// evidence for the PR.
//
//   pnpm --filter web exec tsx e2e/support/capture-nav-narrow.ts <output-dir>
//
// Each state lands as a full PNG plus a compressed -small.jpg (< 300 KB) for chat/PR review.
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { chromium, type Browser, type Page } from '@playwright/test';
import { startStack } from './harness';

const OUT = process.argv[2] ?? '';
if (OUT === '') {
  console.error('usage: tsx e2e/support/capture-nav-narrow.ts <output-dir>');
  process.exit(1);
}
mkdirSync(OUT, { recursive: true });

const PORT = 3217;

// The widths that bracket the defect. 320/360 reproduced it; 390 was the owner's "fine" phone.
const WIDTHS = [320, 360, 390] as const;

async function settle(page: Page): Promise<void> {
  await page.addStyleTag({ content: 'nextjs-portal { display: none !important; }' });
  await page.waitForTimeout(350);
}

async function shoot(page: Page, name: string): Promise<void> {
  await settle(page);
  await page.screenshot({ path: join(OUT, `${name}.png`) });
  await page.screenshot({ path: join(OUT, `${name}-small.jpg`), type: 'jpeg', quality: 68 });
  console.log(`[capture] ${name}`);
}

async function setTheme(page: Page, theme: 'hnet-dark' | 'hnet-light'): Promise<void> {
  await page.evaluate((t) => localStorage.setItem('hnet-theme', t), theme);
  await page.reload();
  await page.locator(`html[data-theme="${theme}"]`).waitFor();
  await page.locator('.greeting').first().waitFor();
}

async function login(page: Page): Promise<void> {
  await page.goto('/login');
  await page.getByRole('button', { name: 'Sign in with Plex (Authentik)' }).click();
  await page.waitForURL('**/');
  await page.locator('.greeting').waitFor();
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
    for (const width of WIDTHS) {
      const ctx = await browser.newContext({
        viewport: { width, height: 720 },
        baseURL: stack.appUrl,
      });
      const page = await ctx.newPage();
      await login(page);
      for (const theme of ['hnet-dark', 'hnet-light'] as const) {
        await setTheme(page, theme);
        const mode = theme === 'hnet-dark' ? 'dark' : 'light';
        await shoot(page, `nav-${width}-${mode}`);
      }
      await ctx.close();
    }
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
