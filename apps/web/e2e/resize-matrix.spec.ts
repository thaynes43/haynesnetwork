// AC-10 / R-60 — the responsive matrix (demo-console donor pattern): at every
// PRD-listed viewport, /login, the dashboard and /admin (admin persona) show no
// page-level scrollbar in either axis, push nothing off-screen, keep the key
// controls visible, and let <main> own the overflow (DESIGN-004 D-05).
import { join } from 'node:path';
import { test, expect, type Page } from '@playwright/test';
import { signIn, expectViewportFit, SIGN_IN_BUTTON } from './support/helpers';
import { TMP_DIR } from './support/env';

// AC-10 sizes: phones, tablets, laptop, desktop, big desktop.
const SIZES = [
  { w: 375, h: 667 },
  { w: 390, h: 844 },
  { w: 412, h: 915 },
  { w: 768, h: 1024 },
  { w: 820, h: 1180 },
  { w: 1280, h: 800 },
  { w: 1920, h: 1080 },
  { w: 2560, h: 1440 },
] as const;

// One real sign-in, reused as storage state by every sized test (24 sign-ins
// would dwarf the assertions). Written in beforeAll — contexts are created
// per-test, after the hook, so the file exists when test.use resolves it.
const ADMIN_STATE = join(TMP_DIR, 'resize-admin-state.json');

test.beforeAll(async ({ browser }) => {
  // Worker restarts (after a genuine failure) re-run this hook while the dev
  // server may be busy writing artifacts — give the one-off sign-in headroom.
  test.setTimeout(120_000);
  const context = await browser.newContext();
  const page = await context.newPage();
  await signIn(page, 'admin');
  await context.storageState({ path: ADMIN_STATE });
  await context.close();
});

/** <main> is the app's single scroll pane: it may overflow vertically (that is its
 *  job) but must never overflow horizontally. */
async function expectMainOwnsOverflow(page: Page): Promise<void> {
  const main = await page.evaluate(() => {
    const el = document.querySelector('main');
    if (!el) return null;
    const style = getComputedStyle(el);
    return {
      overflowY: style.overflowY,
      hOverflow: el.scrollWidth - el.clientWidth,
    };
  });
  expect(main, '<main> present').not.toBeNull();
  expect(['auto', 'scroll']).toContain(main!.overflowY);
  expect(main!.hOverflow, 'no horizontal overflow inside <main>').toBeLessThanOrEqual(1);
}

test.describe('/login (anonymous)', () => {
  for (const { w, h } of SIZES) {
    test(`/login @ ${w}x${h} — fits, sign-in reachable`, async ({ page }) => {
      await page.setViewportSize({ width: w, height: h });
      await page.goto('/login');
      const signInButton = page.getByRole('button', { name: SIGN_IN_BUTTON });
      await expect(signInButton).toBeVisible();
      await expect(signInButton).toBeInViewport();
      await expect(signInButton).toBeEnabled();
      await expectViewportFit(page);
    });
  }
});

test.describe('dashboard + admin (admin persona)', () => {
  test.use({ storageState: ADMIN_STATE });

  for (const { w, h } of SIZES) {
    test(`/ @ ${w}x${h} — fits, chrome + tiles reachable`, async ({ page }) => {
      await page.setViewportSize({ width: w, height: h });
      await page.goto('/');
      await expect(page.locator('.greeting')).toBeVisible();
      // Topbar controls stay on-screen at every size (name may collapse <480px,
      // but the triggers themselves must remain usable).
      await expect(page.getByRole('button', { name: /theme/i })).toBeInViewport();
      await expect(page.locator('.usermenu__trigger')).toBeInViewport();
      // At least the first default tile is visible and targetable.
      const firstTile = page.locator('.tile-grid .tile').first();
      await expect(firstTile).toBeVisible();
      await expect(firstTile).toBeInViewport();
      await expectViewportFit(page);
      await expectMainOwnsOverflow(page);
    });

    test(`/admin @ ${w}x${h} — fits, nav + user list reachable`, async ({ page }) => {
      await page.setViewportSize({ width: w, height: h });
      await page.goto('/admin');
      for (const section of ['Users', 'Catalog', 'Tags']) {
        await expect(
          page.locator('.admin-nav').getByRole('link', { name: section }),
        ).toBeInViewport();
      }
      // The users list renders (table ≥760px, card list below — same element).
      await expect(page.locator('.admin-table')).toBeVisible();
      await expect(page.getByRole('link', { name: 'Bootstrap Admin' })).toBeVisible();
      await expectViewportFit(page);
      await expectMainOwnsOverflow(page);
    });
  }
});
