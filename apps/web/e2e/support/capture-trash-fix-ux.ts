// Screenshot harness for the Trash deletion-audit fix (owner visual sign-off). Boots the SAME
// hermetic stack the e2e suite uses, then captures: (1) a pending row where the per-row Save shield
// and the new Expedite trash-can are equal-weight icon twins (desktop + mobile, dark); (2) after
// driving a real Expedite, the Recently Deleted tab showing the deletion attributed to the actor
// (WHO + title); (3) the Activity tab showing the app-written deletion event.
//
//   pnpm --filter web exec tsx e2e/support/capture-trash-fix-ux.ts <output-dir>
//
// Each state lands as a full PNG plus a compressed -small.jpg (< 300 KB) for chat-sized review.
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { chromium, type Page, type Locator } from '@playwright/test';
import { startStack } from './harness';

const OUT = process.argv[2] ?? '';
if (OUT === '') {
  console.error('usage: tsx e2e/support/capture-trash-fix-ux.ts <output-dir>');
  process.exit(1);
}
mkdirSync(OUT, { recursive: true });

const PORT = 3211;

async function settle(page: Page): Promise<void> {
  await page.addStyleTag({ content: 'nextjs-portal { display: none !important; }' });
  await page.evaluate(() =>
    Promise.all(
      Array.from(document.images).map((img) =>
        img.complete
          ? undefined
          : new Promise((resolve) => {
              img.onload = resolve;
              img.onerror = resolve;
            }),
      ),
    ),
  );
  await page.waitForTimeout(350);
}

async function shoot(page: Page, name: string, fullPage = false): Promise<void> {
  await settle(page);
  await page.screenshot({ path: join(OUT, `${name}.png`), fullPage });
  await page.screenshot({ path: join(OUT, `${name}-small.jpg`), fullPage, type: 'jpeg', quality: 68 });
  console.log(`[capture] ${name}`);
}

async function shootEl(page: Page, el: Locator, name: string): Promise<void> {
  await settle(page);
  await el.screenshot({ path: join(OUT, `${name}.png`) });
  await el.screenshot({ path: join(OUT, `${name}-small.jpg`), type: 'jpeg', quality: 72 });
  console.log(`[capture] ${name} (element)`);
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
}

async function main(): Promise<void> {
  const stack = await startStack({ port: PORT, prewarm: false, cwd: process.cwd() });
  try {
    await fetch(`${stack.oidc.baseUrl}/_control/user`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ persona: 'admin' }),
    });

    const browser = await chromium.launch();

    // ── Desktop (1280×860), dark ────────────────────────────────────────────────────────────
    const context = await browser.newContext({
      viewport: { width: 1280, height: 860 },
      baseURL: stack.appUrl,
    });
    const page = await context.newPage();
    await login(page);
    await page.goto('/trash?tab=movies');
    await page.getByTestId('trash-tablewrap').waitFor();
    // A deletable row carries BOTH the Save shield and the Expedite trash-can (equal-weight icons).
    const pairedRow = page
      .getByTestId('trash-row')
      .filter({ has: page.getByTestId('trash-shield') })
      .filter({ has: page.getByTestId('trash-expedite-item') })
      .first();
    await pairedRow.waitFor();
    await setTheme(page, 'hnet-dark');
    await page.getByTestId('trash-tablewrap').waitFor();
    await shoot(page, 'pending-desktop-dark');
    await shootEl(page, page.getByTestId('trash-tablewrap'), 'pending-actions-desktop-dark');

    // ── Mobile (390×844), dark ──────────────────────────────────────────────────────────────
    const mobile = await browser.newContext({
      viewport: { width: 390, height: 844 },
      baseURL: stack.appUrl,
    });
    const mpage = await mobile.newPage();
    await login(mpage);
    await mpage.goto('/trash?tab=movies');
    await mpage.getByTestId('trash-tablewrap').waitFor();
    await mpage
      .getByTestId('trash-row')
      .filter({ has: mpage.getByTestId('trash-shield') })
      .filter({ has: mpage.getByTestId('trash-expedite-item') })
      .first()
      .waitFor();
    await setTheme(mpage, 'hnet-dark');
    await mpage.getByTestId('trash-tablewrap').waitFor();
    await shoot(mpage, 'pending-mobile-dark', true);
    await mobile.close();

    // ── Drive a REAL Expedite on the cold "Vanished Heist" row (icon → Modal → confirm) ──────
    const vanished = page
      .getByTestId('trash-row')
      .filter({ hasText: 'Vanished Heist' })
      .first();
    await vanished.getByTestId('trash-expedite-item').click();
    await page.getByTestId('trash-expedite-item-confirm').waitFor();
    await shoot(page, 'expedite-confirm-modal-dark');
    await page.getByTestId('trash-expedite-item-submit').click();
    await page.getByTestId('trash-expedite-report').waitFor();
    await shoot(page, 'expedite-report-dark');
    // Close the report Modal.
    await page.getByRole('button', { name: 'Done' }).click().catch(() => undefined);
    await page.keyboard.press('Escape').catch(() => undefined);

    // ── Recently Deleted — the deletion now surfaces WITH the actor (WHO) + title ────────────
    await page.goto('/trash?tab=deleted');
    const deletedRow = page
      .getByTestId('trash-deleted-row')
      .filter({ hasText: 'Vanished Heist' })
      .first();
    await deletedRow.waitFor();
    await setTheme(page, 'hnet-dark');
    await page.getByTestId('trash-deleted').waitFor();
    await shoot(page, 'recently-deleted-dark');
    await shootEl(page, page.getByTestId('trash-deleted'), 'recently-deleted-table-dark');

    // ── Activity — the app-written 'trash' deletion event ───────────────────────────────────
    await page.goto('/trash?tab=activity');
    await page.getByTestId('trash-activity').waitFor();
    await page.getByTestId('trash-activity').getByText('Vanished Heist').first().waitFor();
    await setTheme(page, 'hnet-dark');
    await page.getByTestId('trash-activity').waitFor();
    await shoot(page, 'activity-dark');
    await shootEl(page, page.getByTestId('trash-activity'), 'activity-list-dark');

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
