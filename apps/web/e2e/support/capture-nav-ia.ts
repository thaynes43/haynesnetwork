// Screenshot harness for the ADR-032 nav IA restructure (owner visual sign-off). Boots the
// SAME hermetic stack the e2e suite uses, then captures: the universal top row (desktop +
// 390px mobile, dark + light — the owner's goal is mobile breathing room), the open user
// menu as ADMIN (My Plex · Ledger · Trash settings · Admin settings · Sign out) and as
// MEMBER (My Plex · Sign out only), and the relocated /settings/trash page.
//
//   pnpm --filter web exec tsx e2e/support/capture-nav-ia.ts <output-dir>
//
// Each state lands as a full PNG plus a compressed -small.jpg (< 300 KB) for chat review.
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { chromium, type Browser, type Page } from '@playwright/test';
import { startStack } from './harness';

const OUT = process.argv[2] ?? '';
if (OUT === '') {
  console.error('usage: tsx e2e/support/capture-nav-ia.ts <output-dir>');
  process.exit(1);
}
mkdirSync(OUT, { recursive: true });

const PORT = 3213;

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
  const persona = (name: 'admin' | 'member') =>
    fetch(`${stack.oidc.baseUrl}/_control/user`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ persona: name }),
    });
  let browser: Browser | undefined;
  try {
    browser = await chromium.launch();

    // ── ADMIN: desktop 1280 — universal row + the full dropdown ─────────────────────────
    await persona('admin');
    const desktop = await browser.newContext({
      viewport: { width: 1280, height: 860 },
      baseURL: stack.appUrl,
    });
    const dpage = await desktop.newPage();
    await login(dpage);
    await setTheme(dpage, 'hnet-dark');
    await shoot(dpage, 'top-row-desktop-dark');
    await openMenu(dpage);
    await shoot(dpage, 'dropdown-admin-desktop-dark');
    await dpage.keyboard.press('Escape');
    await setTheme(dpage, 'hnet-light');
    await shoot(dpage, 'top-row-desktop-light');
    await openMenu(dpage);
    await shoot(dpage, 'dropdown-admin-desktop-light');
    await dpage.keyboard.press('Escape');

    // ── ADMIN: /settings/trash — the tabbed hub (build B). Land on General, then shoot each tab. ──
    await setTheme(dpage, 'hnet-dark');
    await openMenu(dpage);
    await dpage.getByRole('menuitem', { name: 'Trash settings' }).click();
    await dpage.waitForURL('**/settings/trash**');
    await dpage.getByTestId('trash-settings').waitFor(); // General card
    await shoot(dpage, 'settings-trash-general-desktop-dark');
    await dpage.getByTestId('settingstab-storage').click();
    await dpage.getByTestId('space-policy').waitFor();
    await shoot(dpage, 'settings-trash-storage-desktop-dark');
    await dpage.getByTestId('settingstab-reclaim').click();
    await dpage.getByTestId('reclaim-headline').waitFor();
    await shoot(dpage, 'settings-trash-reclaim-desktop-dark');
    await dpage.getByTestId('settingstab-rules').click();
    await dpage.getByTestId('trash-rules').waitFor();
    await shoot(dpage, 'settings-trash-rules-desktop-dark');
    await desktop.close();

    // ── ADMIN: mobile 390 — the four-link row breathes now ───────────────────────────────
    const adminMobile = await browser.newContext({
      viewport: { width: 390, height: 844 },
      baseURL: stack.appUrl,
    });
    const ampage = await adminMobile.newPage();
    await login(ampage);
    await setTheme(ampage, 'hnet-dark');
    await shoot(ampage, 'top-row-mobile390-admin-dark');
    await openMenu(ampage);
    await shoot(ampage, 'dropdown-admin-mobile390-dark');
    await ampage.keyboard.press('Escape');
    await setTheme(ampage, 'hnet-light');
    await shoot(ampage, 'top-row-mobile390-admin-light');
    await adminMobile.close();

    // ── MEMBER: mobile 390 — Home · Library · Bulletin; personal-only dropdown ───────────
    await persona('member');
    const memberMobile = await browser.newContext({
      viewport: { width: 390, height: 844 },
      baseURL: stack.appUrl,
    });
    const mmpage = await memberMobile.newPage();
    await login(mmpage);
    await setTheme(mmpage, 'hnet-dark');
    await shoot(mmpage, 'top-row-mobile390-member-dark');
    await openMenu(mmpage);
    await shoot(mmpage, 'dropdown-member-mobile390-dark');
    await mmpage.keyboard.press('Escape');
    await setTheme(mmpage, 'hnet-light');
    await shoot(mmpage, 'top-row-mobile390-member-light');
    await memberMobile.close();
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
