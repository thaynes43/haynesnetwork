// PLAN-027 (ADR-049 / DESIGN-004 D-18 + DESIGN-012 D-09) — screenshot harness for owner sign-off of
// the roles-grid capability map (2-state Enabled/Disabled for no-edit sections; Edit/Read-only/Disabled
// kept for Ledger + Trash) and the Bulletin Feed/Messages sub-view checkboxes, plus a Default-role
// Bulletin with NO Feed tab (Messages only — the migration-0039 seed). Boots the hermetic stack
// (embedded PG16 with all migrations incl. 0039, stub OIDC) and captures at 390px + desktop.
//
//   pnpm --filter web exec tsx e2e/support/capture-roles-bulletin.ts <output-dir>
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
  console.error('usage: tsx e2e/support/capture-roles-bulletin.ts <output-dir>');
  process.exit(1);
}
mkdirSync(OUT, { recursive: true });

const PORT = 3223;

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

async function shootRoles(page: Page, name: string): Promise<void> {
  await page.goto('/admin/roles');
  await page.getByRole('heading', { name: 'Roles' }).waitFor();
  // Wait for the Bulletin sub-view checkboxes to render (proves the new UI is up).
  await page.getByTestId('bulletin-view-messages-Default').waitFor();
  await hidePortal(page);
  await page.waitForTimeout(300);
  await page.locator('table.admin-table--roles').screenshot({ path: join(OUT, `${name}.png`) });
  console.log(`[capture] ${name}`);
}

async function shootDefaultBulletin(page: Page, name: string): Promise<void> {
  await page.goto('/bulletin');
  await page.getByRole('heading', { name: 'Tickets' }).waitFor();
  await page.getByRole('tablist', { name: 'Tickets sections' }).waitFor();
  await hidePortal(page);
  await page.waitForTimeout(300);
  await page.screenshot({ path: join(OUT, `${name}.png`) });
  console.log(`[capture] ${name}`);
}

async function main(): Promise<void> {
  const stack = await startStack({ port: PORT, prewarm: false, cwd: process.cwd() });
  try {
    const browser = await chromium.launch();

    // ── Roles grid (admin) ──
    await setPersona(stack.oidc.baseUrl, 'admin');
    const adminDesktop = await signInTo(browser, stack.appUrl, { width: 1280, height: 1000 });
    await setTheme(adminDesktop, 'hnet-dark');
    await shootRoles(adminDesktop, 'roles-grid-desktop-dark');
    await setTheme(adminDesktop, 'hnet-light');
    await shootRoles(adminDesktop, 'roles-grid-desktop-light');

    const adminMobile = await signInTo(browser, stack.appUrl, { width: 390, height: 1200 });
    await setTheme(adminMobile, 'hnet-dark');
    await shootRoles(adminMobile, 'roles-grid-390-dark');

    // ── Default-role Bulletin: Messages only, NO Feed tab ──
    await setPersona(stack.oidc.baseUrl, 'member');
    const memberDesktop = await signInTo(browser, stack.appUrl, { width: 1120, height: 900 });
    await setTheme(memberDesktop, 'hnet-dark');
    await shootDefaultBulletin(memberDesktop, 'bulletin-default-desktop-dark');

    const memberMobile = await signInTo(browser, stack.appUrl, { width: 390, height: 900 });
    await setTheme(memberMobile, 'hnet-dark');
    await shootDefaultBulletin(memberMobile, 'bulletin-default-390-dark');

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
