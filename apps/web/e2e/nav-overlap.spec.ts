// Regression guard for the narrow-phone nav overlap (fix/nav-overlap-narrow-phones).
//
// ADR-037 added a fifth top-nav link (Metrics) past the four the `.topbar__nav` row was
// tuned for. Below ~375px five links no longer fit, and because the rail had `min-width: 0`
// with the default `overflow: visible`, the surplus links overflowed VISIBLY rightward and
// slid under the theme toggle (owner-reported on a 360px-class phone). The resize matrix
// never caught it — its smallest size is 375px, where five links still fit. These sizes
// (320 / 360) sit below that threshold, with the ADMIN persona (all five links visible).
//
// The fix makes the rail a self-contained horizontal scroll pane, so at any width: the nav
// never overruns the right-pinned actions, the page never gains a horizontal scrollbar, and
// every tab stays reachable (the rail scrolls instead of clipping links away).
import { test, expect, type Page } from '@playwright/test';
import { signIn, expectViewportFit } from './support/helpers';

// Below the 375px floor of the resize matrix — 320px is the iPhone-SE/small-Android class,
// 360px the common budget-Android class the owner's family member was on.
const NARROW_SIZES = [
  { w: 320, h: 640 },
  { w: 360, h: 640 },
] as const;

// The five links an admin session surfaces (Metrics is admin-implied 'edit', ADR-037).
const NAV_LINKS = ['Home', 'Library', 'Trash', 'Bulletin', 'Metrics'] as const;

/** The rail's computed horizontal overflow — the mechanism that confines the surplus links
 *  to their own scroll pane instead of letting them spill over the topbar actions. */
async function navOverflowX(page: Page): Promise<string> {
  return page.evaluate(() => {
    const nav = document.querySelector('.topbar__nav') as HTMLElement | null;
    if (!nav) throw new Error('nav rail missing from the topbar');
    return getComputedStyle(nav).overflowX;
  });
}

test.describe('topbar nav — no overlap at narrow phone widths', () => {
  for (const { w, h } of NARROW_SIZES) {
    test(`nav fits without overlap @ ${w}x${h}`, async ({ page }) => {
      await page.setViewportSize({ width: w, height: h });
      // Real AC-01 round trip as admin — the five-link case that broke the layout.
      await signIn(page, 'admin');

      // All five section links render.
      for (const name of NAV_LINKS) {
        await expect(page.locator('.topbar__nav').getByRole('link', { name })).toHaveCount(1);
      }

      // The right-pinned chrome stays on-screen and usable.
      await expect(page.getByRole('button', { name: /theme/i })).toBeInViewport();
      await expect(page.locator('.usermenu__trigger')).toBeInViewport();

      // PRIMARY GUARD (AC-10): nothing pokes past the viewport. Pre-fix, the surplus nav
      // links overflowed the shrunk rail VISIBLY (overflow: visible) and slid under the
      // theme toggle / off the right edge — measureFit counts them and this fails. The fix
      // confines them to the rail's own scroll pane, which measureFit excludes.
      await expectViewportFit(page);

      // The rail is a self-contained horizontal scroll pane (the fix mechanism) — pre-fix it
      // was overflow: visible, which is why the links escaped it.
      expect(['auto', 'scroll'], 'nav rail is horizontally scrollable').toContain(
        await navOverflowX(page),
      );

      // PRIMARY GUARD (reachability): every tab is reachable. Scroll the rail to its end and
      // the last link (Metrics) is fully on-screen. Pre-fix the rail could not scroll, so
      // Metrics stayed clipped/overlapped and this fails; a no-op scroll when all five fit.
      await page.locator('.topbar__nav').evaluate((el) => {
        el.scrollLeft = el.scrollWidth;
      });
      await expect(
        page.locator('.topbar__nav').getByRole('link', { name: 'Metrics' }),
      ).toBeInViewport();
    });
  }
});
