// Screenshot harness for the DESIGN-004 D-22 nav restructure (owner visual sign-off vs the approved
// mockup). Boots the SAME hermetic stack the e2e suite uses, then captures, for each viewport
// (320 · 390 · desktop) in BOTH themes (dark · light):
//   • top-bar   — the four-tab universal bar: Home · Library · Tickets · Trash
//   • menu      — the open user menu as ADMIN: My Plex · Integrations · Metrics · ─── · Ledger ·
//                 Trash settings · Admin settings · ─── · Sign out (Integrations+Metrics are the
//                 relocated entries; a metrics+integrations-only user sees exactly the mockup's
//                 My Plex · Integrations · Metrics · ─── · Sign out)
//   • tickets   — the /bulletin page under its ratified name, with the [Tickets] [Feed] inner tabs
// Plus one MEMBER menu (My Plex · ─── · Sign out) at 390/dark to show the role gating.
//
//   pnpm --filter web exec tsx e2e/support/capture-nav-restructure.ts <output-dir>
//
// Each state lands as a full PNG plus a compressed -small.jpg (< 300 KB) for chat review.
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { chromium, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { startStack } from './harness';

const OUT = process.argv[2] ?? '';
if (OUT === '') {
  console.error('usage: tsx e2e/support/capture-nav-restructure.ts <output-dir>');
  process.exit(1);
}
mkdirSync(OUT, { recursive: true });

const PORT = 3215;
type Theme = 'hnet-dark' | 'hnet-light';

const VIEWPORTS = [
  { name: '320', width: 320, height: 640 },
  { name: '390', width: 390, height: 844 },
  { name: 'desktop', width: 1280, height: 860 },
] as const;

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

async function setTheme(page: Page, theme: Theme): Promise<void> {
  await page.evaluate((t) => localStorage.setItem('hnet-theme', t), theme);
  await page.reload();
  await page.locator(`html[data-theme="${theme}"]`).waitFor();
  await page.locator('.greeting, .page-title').first().waitFor();
}

async function login(page: Page): Promise<void> {
  await page.goto('/login');
  await page.getByRole('button', { name: 'Sign in with Plex (Authentik)' }).click();
  await page.waitForURL('**/');
  await page.locator('.greeting').waitFor();
}

async function openMenu(page: Page): Promise<void> {
  await page.locator('.usermenu__trigger').click();
  await page.getByRole('menu', { name: 'Account' }).waitFor();
}

async function main(): Promise<void> {
  const stack = await startStack({ port: PORT, prewarm: false, cwd: process.cwd() });
  const persona = (name: 'admin' | 'member' | 'fresh-member') =>
    fetch(`${stack.oidc.baseUrl}/_control/user`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ persona: name }),
    });
  let browser: Browser | undefined;
  try {
    browser = await chromium.launch();

    await persona('admin');
    for (const vp of VIEWPORTS) {
      const ctx: BrowserContext = await browser.newContext({
        viewport: { width: vp.width, height: vp.height },
        baseURL: stack.appUrl,
      });
      const page = await ctx.newPage();
      await login(page);
      for (const theme of ['hnet-dark', 'hnet-light'] as const) {
        await setTheme(page, theme);
        const t = theme === 'hnet-dark' ? 'dark' : 'light';

        // 1) the four-tab bar (dashboard, bar pinned at top)
        await shoot(page, `topbar-${vp.name}-${t}`);

        // 2) the open user menu (admin — shows the relocated Integrations + Metrics)
        await openMenu(page);
        await page.getByRole('menuitem', { name: 'Metrics' }).waitFor();
        await shoot(page, `menu-admin-${vp.name}-${t}`);
        await page.keyboard.press('Escape');

        // 3) the Tickets page with its inner tabs
        await page
          .getByRole('navigation', { name: 'Primary' })
          .getByRole('link', { name: 'Tickets' })
          .click();
        await page.getByRole('tablist', { name: 'Tickets sections' }).waitFor();
        await shoot(page, `tickets-inner-tabs-${vp.name}-${t}`);
        await page.goto('/'); // reset for the next theme's bar shot
        await page.locator('.greeting').waitFor();
      }
      await ctx.close();
    }

    // MEMBER menu (gating) — a never-granted member: My Plex · ─── · Sign out, no Metrics/Integrations.
    await persona('fresh-member');
    const memberCtx = await browser.newContext({
      viewport: { width: 390, height: 844 },
      baseURL: stack.appUrl,
    });
    const mpage = await memberCtx.newPage();
    await login(mpage);
    await setTheme(mpage, 'hnet-dark');
    await openMenu(mpage);
    await shoot(mpage, 'menu-member-390-dark');
    await memberCtx.close();
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
