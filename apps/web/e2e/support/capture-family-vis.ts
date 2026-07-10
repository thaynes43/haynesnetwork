// Screenshot harness for fix/family-strip-mobile-roles (owner visual sign-off, 2026-07-09):
//   1. the "Potential in future batches" strip is now visible to ANY trash user — a read-only
//      member's view of an open batch (desktop + 390px portrait);
//   2. the /admin/roles inline editor stacks on a phone (390px, mid-edit);
//   3. the /admin users list role control is editable on a phone (390px).
//
//   pnpm --filter web exec tsx e2e/support/capture-family-vis.ts <output-dir>
//
// Each state lands as a full PNG plus a compressed -small.jpg (< 300 KB) for chat review.
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { chromium, type Browser, type Page } from '@playwright/test';
import { startStack } from './harness';

const OUT = process.argv[2] ?? '';
if (OUT === '') {
  console.error('usage: tsx e2e/support/capture-family-vis.ts <output-dir>');
  process.exit(1);
}
mkdirSync(OUT, { recursive: true });

const PORT = 3217;

async function settle(page: Page): Promise<void> {
  await page.addStyleTag({ content: 'nextjs-portal { display: none !important; }' });
  await page.waitForTimeout(400);
}

async function shoot(page: Page, name: string, scrollTo?: string): Promise<void> {
  if (scrollTo !== undefined) {
    await page.getByTestId(scrollTo).scrollIntoViewIfNeeded();
    await page.waitForTimeout(150);
  }
  await settle(page);
  await page.screenshot({ path: join(OUT, `${name}.png`) });
  await page.screenshot({ path: join(OUT, `${name}-small.jpg`), type: 'jpeg', quality: 62 });
  console.log(`[capture] ${name}`);
}

async function login(page: Page): Promise<void> {
  await page.goto('/login');
  await page.getByRole('button', { name: 'Sign in with Plex (Authentik)' }).click();
  await page.waitForURL('**/');
  await page.locator('.greeting').waitFor();
}

async function main(): Promise<void> {
  const stack = await startStack({ port: PORT, prewarm: false, cwd: process.cwd() });
  const persona = (name: 'admin' | 'member') =>
    fetch(`${stack.oidc.baseUrl}/_control/user`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ persona: name }),
    });
  const maint = (path: string, body: unknown) =>
    fetch(`${stack.maintainerr.baseUrl}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });

  let browser: Browser | undefined;
  try {
    browser = await chromium.launch();

    // ── Bootstrap the member user row (first login creates it) so the admin can reassign it. ──
    await maint('/_stub/reset', {});
    await persona('member');
    const boot = await browser.newContext({ baseURL: stack.appUrl });
    const bpage = await boot.newPage();
    await login(bpage);
    await boot.close();

    // ── ADMIN setup: fresh Maintainerr, open a movie batch, green-light it to Leaving Soon, add a
    //    future candidate, and put Marge Member on read-only "Trash Viewer" so she SEES the strip. ─
    await persona('admin');
    const admin = await browser.newContext({ viewport: { width: 1280, height: 900 }, baseURL: stack.appUrl });
    const apage = await admin.newPage();
    await login(apage);

    await apage.goto('/trash?tab=movies');
    await apage.getByTestId('batch-start').click();
    await apage.getByTestId('batch-start-modal').waitFor();
    await apage.getByTestId('batch-start-submit').click();
    await apage.getByTestId('batch-state').waitFor();
    // A fresh candidate NOT in the frozen batch → the "Potential in future batches" strip appears.
    await maint('/_stub/add-pending', {
      collectionId: 7,
      mediaServerId: 'ms-990010',
      tmdbId: 990010,
      sizeBytes: 3_221_225_472,
    });
    // Green-light to Leaving Soon (the family window — the documented member scenario).
    await apage.getByTestId('batch-greenlight').click();
    await apage.getByTestId('batch-greenlight-submit').click();
    await apage.locator('[data-testid="batch-state"]', { hasText: 'Leaving Soon' }).waitFor();
    // Assign Marge Member → Trash Viewer (read-only, no save grants).
    await apage.goto('/admin');
    await apage.getByRole('link', { name: 'Marge Member' }).click();
    await apage.getByRole('heading', { name: 'Marge Member' }).waitFor();
    await apage.locator('#user-role').selectOption({ label: 'Trash Viewer' });
    await apage.waitForResponse((r) => r.url().includes('users.setRole'));

    // ── ADMIN: /admin/roles inline editor mid-edit — desktop then 390px portrait ─────────────
    await apage.goto('/admin/roles');
    const limitedRow = apage.locator('.admin-table tbody tr').filter({ hasText: 'Trash Limited' });
    await limitedRow.getByRole('button', { name: 'Edit' }).click();
    await apage.getByTestId('trash-actions-grid').waitFor();
    await shoot(apage, 'roles-editor-desktop-edit');

    // ── ADMIN: users list — desktop reference ────────────────────────────────────────────────
    await apage.goto('/admin');
    await apage.getByTestId('user-role-select').first().waitFor();
    await shoot(apage, 'users-list-desktop');
    await admin.close();

    // ── ADMIN mobile 390: users list + roles editor mid-edit ─────────────────────────────────
    await persona('admin');
    const am = await browser.newContext({ viewport: { width: 390, height: 844 }, baseURL: stack.appUrl });
    const amp = await am.newPage();
    await login(amp);
    await amp.goto('/admin');
    await amp.getByTestId('user-role-select').first().waitFor();
    await shoot(amp, 'users-list-390');

    await amp.goto('/admin/roles');
    const limitedRow390 = amp.locator('.admin-table tbody tr').filter({ hasText: 'Trash Limited' });
    await limitedRow390.getByRole('button', { name: 'Edit' }).click();
    await amp.getByTestId('trash-actions-grid').waitFor();
    await shoot(amp, 'roles-editor-390-edit');
    // The bottom of the same open editor — the message-action grid + Save/Cancel are reachable.
    await shoot(amp, 'roles-editor-390-edit-bottom', 'message-actions-grid');

    // ── ADMIN mobile 390: /settings/trash — audit all four tabs in portrait ──────────────────
    for (const [tab, testid] of [
      ['general', 'trash-settings'],
      ['storage', 'space-policy'],
      ['reclaim', 'reclaim-headline'],
      ['rules', 'trash-rules'],
    ] as const) {
      await amp.goto(`/settings/trash?tab=${tab}`);
      await amp.getByTestId(testid).waitFor();
      await shoot(amp, `settings-${tab}-390`);
    }
    // The General tab's lower half — the Timezone select (must not bleed past the edge) and the
    // pool-refresh "Enabled" checkbox (must be a standard 18px control, not comically large).
    await amp.goto('/settings/trash?tab=general');
    await amp.getByTestId('trash-settings').waitFor();
    await shoot(amp, 'settings-general-390-bottom', 'pool-refresh-row');

    // ── ADMIN mobile 430 (the wide-portrait bound) — roles editor mid-edit ───────────────────
    await am.close();
    const am430 = await browser.newContext({ viewport: { width: 430, height: 932 }, baseURL: stack.appUrl });
    const amp430 = await am430.newPage();
    await login(amp430);
    await amp430.goto('/admin/roles');
    await amp430.locator('.admin-table tbody tr').filter({ hasText: 'Trash Limited' }).getByRole('button', { name: 'Edit' }).click();
    await amp430.getByTestId('trash-actions-grid').waitFor();
    await shoot(amp430, 'roles-editor-430-edit');
    await am430.close();

    // ── MEMBER (Trash Viewer, read-only): the future strip is visible but read-only ──────────
    await persona('member');
    const md = await browser.newContext({ viewport: { width: 1280, height: 900 }, baseURL: stack.appUrl });
    const mdp = await md.newPage();
    await login(mdp);
    await mdp.goto('/trash?tab=movies');
    await mdp.getByTestId('batch-new-candidates').waitFor();
    await shoot(mdp, 'member-future-strip-desktop', 'batch-new-candidates');
    await md.close();

    const mm = await browser.newContext({ viewport: { width: 390, height: 844 }, baseURL: stack.appUrl });
    const mmp = await mm.newPage();
    await login(mmp);
    await mmp.goto('/trash?tab=movies');
    await mmp.getByTestId('batch-new-candidates').waitFor();
    await shoot(mmp, 'member-future-strip-390', 'batch-new-candidates');
    await mm.close();

    // Restore Marge to Default so a re-run of the suite starts clean.
    await persona('admin');
    const cleanup = await browser.newContext({ baseURL: stack.appUrl });
    const cp = await cleanup.newPage();
    await login(cp);
    await cp.goto('/admin');
    await cp.getByRole('link', { name: 'Marge Member' }).click();
    await cp.locator('#user-role').selectOption({ label: 'Default (default)' });
    await cp.waitForResponse((r) => r.url().includes('users.setRole'));
    await cleanup.close();
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
