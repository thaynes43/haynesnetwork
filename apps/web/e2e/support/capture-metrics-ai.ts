// Screenshot harness for the Metrics → AI sub-tab (ADR-044 / DESIGN-022 / PLAN-021 — owner visual
// sign-off). Boots the SAME hermetic stack the e2e suite uses (stub OIDC + stub Open WebUI, whose canned
// chats/users the ai-usage-sync seed already synced into ai_usage_chats), then captures:
//   • ADMIN (full level): the counts + trends + per-model + per-user tables — desktop + 390px, dark+light;
//   • MEMBER (limited level): the aggregate counts + trends + "admins see more" note (NO per-user data).
//
//   pnpm --filter web exec tsx e2e/support/capture-metrics-ai.ts <output-dir>
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { chromium, type Browser, type Page } from '@playwright/test';
import { db } from '@hnet/db';
import { setRoleMetricsLevel, setSectionPermission } from '@hnet/domain';
import { startStack } from './harness';

const OUT = process.argv[2] ?? '';
if (OUT === '') {
  console.error('usage: tsx e2e/support/capture-metrics-ai.ts <output-dir>');
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
  await page.screenshot({ path: join(OUT, `${name}-small.jpg`), type: 'jpeg', quality: 70, fullPage: true });
  console.log(`[capture] ${name}`);
}

async function setTheme(page: Page, theme: 'hnet-dark' | 'hnet-light'): Promise<void> {
  await page.evaluate((t) => localStorage.setItem('hnet-theme', t), theme);
  await page.reload();
  await page.locator(`html[data-theme="${theme}"]`).waitFor();
}

async function persona(stack: Awaited<ReturnType<typeof startStack>>, name: 'admin' | 'member'): Promise<void> {
  await fetch(`${stack.oidc.baseUrl}/_control/user`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ persona: name }),
  });
}

async function login(page: Page): Promise<void> {
  await page.goto('/login');
  await page.getByRole('button', { name: 'Sign in with Plex (Authentik)' }).click();
  await page.waitForURL('**/');
  await page.locator('.greeting').waitFor();
}

async function openAiTab(page: Page): Promise<void> {
  await page.goto('/metrics?tab=ai');
  await page.getByTestId('metrics-ai').waitFor();
  await page.getByTestId('metrics-ai-chats').waitFor();
}

/** Grant the seeded Default role (the member's role) metrics visibility at the LIMITED level, through the
 *  @hnet/domain single-writers (never a raw write — the no-direct-state-writes guard). Uses the lazy
 *  @hnet/db client (DATABASE_URL must already point at the stack's embedded Postgres). */
async function grantMemberLimitedMetrics(): Promise<void> {
  const def = await db.query.roles.findFirst({ where: (r, { eq }) => eq(r.isDefault, true) });
  if (!def) throw new Error('no default role seeded');
  await setSectionPermission({ roleId: def.id, sectionId: 'metrics', level: 'read_only', actorId: null });
  await setRoleMetricsLevel({ roleId: def.id, level: 'limited', actorId: null });
}

async function main(): Promise<void> {
  const stack = await startStack({ port: PORT, prewarm: false, cwd: process.cwd() });
  // Point the lazy @hnet/db client at the stack's embedded Postgres before the first query.
  process.env.DATABASE_URL = stack.pg.connectionString;
  await grantMemberLimitedMetrics();

  let browser: Browser | undefined;
  try {
    browser = await chromium.launch();

    // ── ADMIN (full) — desktop dark+light, then 390 dark+light ────────────────────────────────
    await persona(stack, 'admin');
    const desktop = await browser.newContext({ viewport: { width: 1280, height: 900 }, baseURL: stack.appUrl });
    const dpage = await desktop.newPage();
    await login(dpage);
    await setTheme(dpage, 'hnet-dark');
    await openAiTab(dpage);
    await dpage.getByTestId('metrics-ai-users').waitFor();
    await shoot(dpage, 'ai-admin-desktop-dark');
    await setTheme(dpage, 'hnet-light');
    await openAiTab(dpage);
    await shoot(dpage, 'ai-admin-desktop-light');
    await desktop.close();

    const mobile = await browser.newContext({ viewport: { width: 390, height: 844 }, baseURL: stack.appUrl });
    const mpage = await mobile.newPage();
    await login(mpage);
    await setTheme(mpage, 'hnet-dark');
    await openAiTab(mpage);
    await shoot(mpage, 'ai-admin-mobile390-dark');
    await setTheme(mpage, 'hnet-light');
    await openAiTab(mpage);
    await shoot(mpage, 'ai-admin-mobile390-light');
    await mobile.close();

    // ── MEMBER (limited) — desktop dark+light, then 390 dark ──────────────────────────────────
    await persona(stack, 'member');
    const mdesktop = await browser.newContext({ viewport: { width: 1280, height: 900 }, baseURL: stack.appUrl });
    const mdpage = await mdesktop.newPage();
    await login(mdpage);
    await setTheme(mdpage, 'hnet-dark');
    await openAiTab(mdpage);
    await mdpage.getByTestId('metrics-ai-limited-note').waitFor();
    await shoot(mdpage, 'ai-member-desktop-dark');
    await setTheme(mdpage, 'hnet-light');
    await openAiTab(mdpage);
    await shoot(mdpage, 'ai-member-desktop-light');
    await mdesktop.close();

    const mmobile = await browser.newContext({ viewport: { width: 390, height: 844 }, baseURL: stack.appUrl });
    const mmpage = await mmobile.newPage();
    await login(mmpage);
    await setTheme(mmpage, 'hnet-dark');
    await openAiTab(mmpage);
    await shoot(mmpage, 'ai-member-mobile390-dark');
    await mmobile.close();
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
