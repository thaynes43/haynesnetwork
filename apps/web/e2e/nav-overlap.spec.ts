// Regression guard for the narrow-phone nav row (fix/nav-overlap-narrow-phones, then the
// DESIGN-004 D-22 nav restructure).
//
// History: ADR-037 briefly pushed the top row to FIVE links (…· Metrics), which below ~375px no
// longer fit and — with `min-width: 0` + default `overflow: visible` — overflowed VISIBLY rightward
// under the theme toggle (owner-reported on a 360px-class phone). The fix made the rail a
// self-contained horizontal scroll pane. The 2026-07-14 restructure then slimmed the row back to
// FOUR (Home · Library · Tickets · Trash — Metrics + Integrations moved into the user menu), so four
// labels now FIT even at 320px WITHOUT the rail needing to scroll. This spec pins both: nothing
// overflows the viewport, AND four tabs fit their rail at narrow widths (no scroll needed). The
// scroll pane stays as a safety net for any future fifth entry.
import { test, expect, type Page } from '@playwright/test';
import { signIn, expectViewportFit } from './support/helpers';

// The narrow-phone band below the 375px floor of the resize matrix — 320px is the iPhone-SE/small-
// Android class, 360px the common budget-Android class the owner's family member was on.
const NARROW_SIZES = [
  { w: 320, h: 640 },
  { w: 360, h: 640 },
] as const;

// The four universal section links an admin session surfaces (admin implies trash=edit → Trash
// shows; Bulletin/"Tickets" defaults read_only for everyone). Order = the approved mockup.
const NAV_LINKS = ['Home', 'Library', 'Tickets', 'Trash'] as const;

/** The rail's computed horizontal overflow — the safety-net mechanism that would confine surplus
 *  links to their own scroll pane rather than letting them spill over the topbar actions. */
async function navOverflowX(page: Page): Promise<string> {
  return page.evaluate(() => {
    const nav = document.querySelector('.topbar__nav') as HTMLElement | null;
    if (!nav) throw new Error('nav rail missing from the topbar');
    return getComputedStyle(nav).overflowX;
  });
}

/** The rail's own overflow amount: scrollWidth − clientWidth. 0 (≤1 for rounding) means the links
 *  fit without the rail scrolling. */
async function navScrollOverflow(page: Page): Promise<number> {
  return page.evaluate(() => {
    const nav = document.querySelector('.topbar__nav') as HTMLElement | null;
    if (!nav) throw new Error('nav rail missing from the topbar');
    return nav.scrollWidth - nav.clientWidth;
  });
}

test.describe('topbar nav — four tabs fit narrow phones with no overlap', () => {
  for (const { w, h } of NARROW_SIZES) {
    test(`four tabs fit without overlap or rail scroll @ ${w}x${h}`, async ({ page }) => {
      await page.setViewportSize({ width: w, height: h });
      // Real AC-01 round trip as admin — all four universal links visible.
      await signIn(page, 'admin');

      // All four section links render (and no more — Metrics/Integrations are menu items now).
      for (const name of NAV_LINKS) {
        await expect(page.locator('.topbar__nav').getByRole('link', { name })).toHaveCount(1);
      }
      await expect(page.locator('.topbar__nav a')).toHaveCount(NAV_LINKS.length);
      await expect(
        page.locator('.topbar__nav').getByRole('link', { name: 'Metrics' }),
      ).toHaveCount(0);
      await expect(
        page.locator('.topbar__nav').getByRole('link', { name: 'Integrations' }),
      ).toHaveCount(0);

      // The right-pinned chrome stays on-screen and usable.
      await expect(page.getByRole('button', { name: /theme/i })).toBeInViewport();
      await expect(page.locator('.usermenu__trigger')).toBeInViewport();

      // PRIMARY GUARD (AC-10): nothing pokes past the viewport.
      await expectViewportFit(page);

      // The rail keeps its self-contained scroll pane as a safety net (overflow-x auto/scroll)…
      expect(['auto', 'scroll'], 'nav rail is horizontally scrollable (safety net)').toContain(
        await navOverflowX(page),
      );

      // …but with only four links it never needs to engage: the rail contents fit at 320/360px, so
      // the four tabs are all visible at once with no swipe required (the restructure's goal).
      expect(
        await navScrollOverflow(page),
        'four tabs fit the rail without scrolling',
      ).toBeLessThanOrEqual(1);

      // Every tab is fully on-screen (belt-and-suspenders on the fit assertion above).
      for (const name of NAV_LINKS) {
        await expect(page.locator('.topbar__nav').getByRole('link', { name })).toBeInViewport();
      }
    });
  }
});
