// Regression guard for the narrow-phone nav row (fix/nav-overlap-narrow-phones, then the
// DESIGN-004 D-22 nav restructure, then DESIGN-043 D-01).
//
// History: ADR-037 briefly pushed the top row to FIVE links (…· Metrics), which below ~375px no
// longer fit and — with `min-width: 0` + default `overflow: visible` — overflowed VISIBLY rightward
// under the theme toggle (owner-reported on a 360px-class phone). The fix made the rail a
// self-contained horizontal scroll pane. The 2026-07-14 restructure slimmed the row back to FOUR
// (Metrics + Integrations moved into the user menu; the D-23 home/portal split renamed the first
// slot — Portal · Library · Tickets · Trash). DESIGN-043 D-01 (ADR-072) then added the first-class
// universal Collections entry — the "future fifth entry" the scroll-rail safety net was built for.
// This spec now pins the invariant that actually matters at narrow widths: nothing overflows the
// VIEWPORT (the rail clips its own surplus into a horizontal scroll pane), the right-pinned chrome
// stays usable, and every universal link is present.
import { test, expect, type Page } from '@playwright/test';
import { signIn, expectViewportFit } from './support/helpers';

// The narrow-phone band below the 375px floor of the resize matrix — 320px is the iPhone-SE/small-
// Android class, 360px the common budget-Android class the owner's family member was on.
const NARROW_SIZES = [
  { w: 320, h: 640 },
  { w: 360, h: 640 },
] as const;

// The five universal section links an admin session surfaces (admin implies trash=edit → Trash
// shows; Bulletin/"Tickets" defaults read_only for everyone; Collections is universal). Order = the
// approved mockup + the DESIGN-043 D-01 Collections slot after Library.
const NAV_LINKS = ['Portal', 'Library', 'Collections', 'Tickets', 'Trash'] as const;

/** The rail's computed horizontal overflow — the safety-net mechanism that confines surplus links to
 *  their own scroll pane rather than letting them spill over the topbar actions. */
async function navOverflowX(page: Page): Promise<string> {
  return page.evaluate(() => {
    const nav = document.querySelector('.topbar__nav') as HTMLElement | null;
    if (!nav) throw new Error('nav rail missing from the topbar');
    return getComputedStyle(nav).overflowX;
  });
}

test.describe('topbar nav — universal links fit narrow phones with no viewport overflow', () => {
  for (const { w, h } of NARROW_SIZES) {
    test(`links present, nothing overflows the viewport @ ${w}x${h}`, async ({ page }) => {
      await page.setViewportSize({ width: w, height: h });
      // Real AC-01 round trip as admin — all universal links present.
      await signIn(page, 'admin');

      // All universal section links render (and no more — Metrics/Integrations are menu items now).
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

      // PRIMARY GUARD (AC-10): nothing pokes past the viewport — the rail clips its own surplus.
      await expectViewportFit(page);

      // The rail keeps its self-contained horizontal scroll pane (overflow-x auto/scroll). With the
      // fifth universal entry (Collections) this is the sanctioned way a long label set stays inside
      // the viewport at 320/360px — the safety net the header describes.
      expect(['auto', 'scroll'], 'nav rail is horizontally scrollable (safety net)').toContain(
        await navOverflowX(page),
      );
    });
  }
});
