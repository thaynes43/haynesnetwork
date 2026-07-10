// Screenshot harness for the Metrics → Overview admin-only WAN-capacity editor (DESIGN-016 D-08 — owner
// visual sign-off). Boots the SAME hermetic stack the e2e suite uses (stub OIDC + stub Prometheus serving
// the WAN instant vectors), then captures TWO viewer states at desktop (1280) + 390px, dark + light:
//   • ADMIN — the upload + download meters each carry the inline "Capacity [ 300 ] Mbps [Save]" editor
//     (idle) plus one "editing/Unsaved" frame proving the control drives the seeded 300/2256 caps.
//   • MEMBER — the SAME Overview with NO edit control (read-only meters). Reached by granting the Default
//     role Metrics = Read-only through the real /admin/roles UI (as admin) and switching the sticky OIDC
//     persona to `member`. The script ASSERTS the capacity input is absent for the member.
// Ephemeral stack (startStack → stop) — the Default-role grant is thrown away with it; the shared suite
// is untouched.
//
//   pnpm --filter web exec tsx e2e/support/capture-metrics-capacity.ts <output-dir>
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { chromium, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { startStack } from './harness';

const OUT = process.argv[2] ?? '';
if (OUT === '') {
  console.error('usage: tsx e2e/support/capture-metrics-capacity.ts <output-dir>');
  process.exit(1);
}
mkdirSync(OUT, { recursive: true });

const PORT = 3221;

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

async function openOverview(page: Page): Promise<void> {
  await page.goto('/metrics?tab=overview');
  await page.getByTestId('metrics-overview').waitFor();
  await page.getByTestId('metrics-upload-meter').waitFor();
}

async function selectPersona(oidcBaseUrl: string, persona: 'admin' | 'member'): Promise<void> {
  const res = await fetch(`${oidcBaseUrl}/_control/user`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ persona }),
  });
  if (!res.ok) throw new Error(`persona switch failed: HTTP ${res.status}`);
}

/** As admin, open the roles hub and set the Default role's Metrics section to Read-only so the `member`
 *  persona (Default role) can SEE the Overview meters — while staying a non-admin (no edit control). */
async function grantDefaultRoleMetricsReadOnly(page: Page): Promise<void> {
  await page.goto('/admin/roles');
  const select = page.getByLabel('Metrics visibility for Default');
  await select.waitFor();
  await select.selectOption('read_only');
  await page.waitForTimeout(600); // let the audited setSection mutation settle
}

async function shootAdmin(context: BrowserContext, tag: string): Promise<void> {
  const page = await context.newPage();
  await login(page);
  await setTheme(page, 'hnet-dark');
  await openOverview(page);
  // Both caps carry the editor for an admin.
  await page.getByTestId('metrics-capacity-input-upload').waitFor();
  await page.getByTestId('metrics-capacity-input-download').waitFor();
  await shoot(page, `capacity-admin-${tag}-dark`);

  // One "editing" frame — type a new upload cap so the row shows the Unsaved status (not saved, so the
  // seeded 300 is untouched). Proves the control is live without mutating the ephemeral setting.
  await page.getByTestId('metrics-capacity-input-upload').fill('500');
  await shoot(page, `capacity-admin-${tag}-editing-dark`);

  await setTheme(page, 'hnet-light');
  await openOverview(page);
  await page.getByTestId('metrics-capacity-input-upload').waitFor();
  await shoot(page, `capacity-admin-${tag}-light`);
  await page.close();
}

async function shootMember(context: BrowserContext, tag: string): Promise<void> {
  const page = await context.newPage();
  await login(page);
  await setTheme(page, 'hnet-dark');
  await openOverview(page);
  // The member sees the meters but NO edit control — assert absence (hermetic proof).
  if ((await page.getByTestId('metrics-capacity-input-upload').count()) !== 0) {
    throw new Error('member unexpectedly sees the capacity edit control');
  }
  if ((await page.getByTestId('metrics-capacity-input-download').count()) !== 0) {
    throw new Error('member unexpectedly sees the download capacity edit control');
  }
  await shoot(page, `capacity-member-${tag}-dark`);
  await setTheme(page, 'hnet-light');
  await openOverview(page);
  await shoot(page, `capacity-member-${tag}-light`);
  await page.close();
}

async function main(): Promise<void> {
  const stack = await startStack({ port: PORT, prewarm: false, cwd: process.cwd() });
  let browser: Browser | undefined;
  try {
    browser = await chromium.launch();

    // ── ADMIN phase (persona=admin): capture the editor + grant Default role Metrics read-only. ──
    await selectPersona(stack.oidc.baseUrl, 'admin');

    const adminDesktop = await browser.newContext({
      viewport: { width: 1280, height: 900 },
      baseURL: stack.appUrl,
    });
    await shootAdmin(adminDesktop, 'desktop');
    // Grant the Default role Metrics visibility once (persists in the stack DB for the member phase).
    // The context already holds the admin session from shootAdmin — no re-login (/login would bounce).
    const grantPage = await adminDesktop.newPage();
    await grantDefaultRoleMetricsReadOnly(grantPage);
    await grantPage.close();
    await adminDesktop.close();

    const adminMobile = await browser.newContext({
      viewport: { width: 390, height: 844 },
      baseURL: stack.appUrl,
    });
    await shootAdmin(adminMobile, 'mobile390');
    await adminMobile.close();

    // ── MEMBER phase (persona=member): the SAME Overview, read-only (no edit control). ──
    await selectPersona(stack.oidc.baseUrl, 'member');

    const memberDesktop = await browser.newContext({
      viewport: { width: 1280, height: 900 },
      baseURL: stack.appUrl,
    });
    await shootMember(memberDesktop, 'desktop');
    await memberDesktop.close();

    const memberMobile = await browser.newContext({
      viewport: { width: 390, height: 844 },
      baseURL: stack.appUrl,
    });
    await shootMember(memberMobile, 'mobile390');
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
