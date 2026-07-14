// DESIGN-004 D-22 (owner-ratified from an approved mockup, 2026-07-14) — the NAV RESTRUCTURE.
//
// The contract this pins:
//   TOP BAR:  Home | Library | Tickets | Trash        [theme] (avatar)
//   USER MENU: My Plex / Integrations / Metrics / ──── / Sign out   (each section role-gated)
//   Tickets page keeps its inner tabs: [Tickets] [Feed]
//
// Covered: the four-tab bar at 320 / 390 / desktop (order + no rail scroll at 320); Metrics +
// Integrations as user-menu entries, gated exactly like their former tabs (admin sees them, a
// member without the section does not); the "Tickets" label + the page's inner tabs; menu-item
// navigation is a history PUSH (Back returns); and active-state correctness (visiting a menu route
// leaves NO stale top-nav tab highlighted, while the Tickets page keeps exactly one active inner
// tab). All against the hermetic stack via the real stub-OIDC round trip.
import { test, expect, type Page } from '@playwright/test';
import { signIn, openUserMenu } from './support/helpers';

const VIEWPORTS = [
  { name: '320', w: 320, h: 640 },
  { name: '390', w: 390, h: 844 },
  { name: 'desktop', w: 1280, h: 860 },
] as const;

/** The rail's own overflow (scrollWidth − clientWidth); ≤1 means the tabs fit with no scroll. */
async function navScrollOverflow(page: Page): Promise<number> {
  return page.evaluate(() => {
    const nav = document.querySelector('.topbar__nav') as HTMLElement | null;
    if (!nav) throw new Error('nav rail missing');
    return nav.scrollWidth - nav.clientWidth;
  });
}

test.describe('nav restructure — the four-tab universal bar (DESIGN-004 D-22)', () => {
  for (const vp of VIEWPORTS) {
    test(`bar reads Home · Library · Tickets · Trash @ ${vp.name}`, async ({ page }) => {
      await page.setViewportSize({ width: vp.w, height: vp.h });
      await signIn(page, 'admin'); // admin surfaces all four candidates (trash=edit implied)

      // Exactly four links, in the approved order, and NOT the relocated pair.
      await expect(page.locator('.topbar__nav a')).toHaveText(['Home', 'Library', 'Tickets', 'Trash']);
      await expect(
        page.locator('.topbar__nav').getByRole('link', { name: 'Metrics' }),
      ).toHaveCount(0);
      await expect(
        page.locator('.topbar__nav').getByRole('link', { name: 'Integrations' }),
      ).toHaveCount(0);

      // At 320px the four tabs fit their rail with no scroll (the restructure's headline goal;
      // the scroll pane stays only as a safety net).
      if (vp.w <= 360) {
        expect(await navScrollOverflow(page), 'four tabs fit 320px with no rail scroll').toBeLessThanOrEqual(1);
      }
    });
  }
});

test.describe('nav restructure — user menu entries + role gating (DESIGN-004 D-22)', () => {
  test('admin: Integrations + Metrics are menu items styled like My Plex, above the Sign-out divider', async ({
    page,
  }) => {
    await signIn(page, 'admin');
    await openUserMenu(page);
    const menu = page.getByRole('menu', { name: 'Account' });

    // My Plex is the reference anatomy; the relocated entries share its exact item class.
    for (const label of ['My Plex', 'Integrations', 'Metrics'] as const) {
      const item = menu.getByRole('menuitem', { name: label });
      await expect(item, `${label} present`).toBeVisible();
      await expect(item, `${label} matches My Plex item styling`).toHaveClass(/usermenu__item/);
    }
    // Sign out is still the terminal item.
    await expect(menu.getByRole('menuitem', { name: 'Sign out' })).toBeVisible();
  });

  test('a member without the metrics/integrations sections sees NEITHER menu item (gated like the old tabs)', async ({
    page,
  }) => {
    await signIn(page, 'fresh-member');
    await openUserMenu(page);
    const menu = page.getByRole('menu', { name: 'Account' });

    await expect(menu.getByRole('menuitem', { name: 'My Plex' })).toBeVisible();
    await expect(menu.getByRole('menuitem', { name: 'Metrics' })).toHaveCount(0);
    await expect(menu.getByRole('menuitem', { name: 'Integrations' })).toHaveCount(0);
    await expect(menu.getByRole('menuitem', { name: 'Sign out' })).toBeVisible();
  });
});

test.describe('nav restructure — Tickets label + inner tabs (DESIGN-004 D-22)', () => {
  test('the "Tickets" bar entry opens /bulletin, whose page + inner tabs read Tickets/Feed', async ({
    page,
  }) => {
    await signIn(page, 'admin');
    await page
      .getByRole('navigation', { name: 'Primary' })
      .getByRole('link', { name: 'Tickets' })
      .click();
    await page.waitForURL(/\/bulletin/); // route unchanged — label-only rename

    await expect(page.getByRole('heading', { name: 'Tickets', level: 1 })).toBeVisible();
    const tabs = page.getByRole('tablist', { name: 'Tickets sections' }).getByRole('tab');
    await expect(tabs).toHaveText(['Tickets', 'Feed']);

    // Exactly one inner tab is active (#278 precedent — one active tab, no stale second).
    await expect(page.locator('.library-tabs [role="tab"][aria-selected="true"]')).toHaveCount(1);
  });
});

test.describe('nav restructure — menu-item push + active-state correctness (DESIGN-004 D-22)', () => {
  test('navigating Metrics from the menu is a history PUSH (Back returns to the prior screen)', async ({
    page,
  }) => {
    await signIn(page, 'admin'); // lands on '/'
    await openUserMenu(page);
    await page.getByRole('menuitem', { name: 'Metrics' }).click();
    await page.waitForURL('**/metrics');

    // D-19 push: the menu item minted a history entry, so Back returns to the dashboard ROOT we came
    // from. Had it been a router.replace, Back would have skipped '/' entirely (to /login / exit) —
    // so landing back on root is the canonical proof of push semantics.
    await page.goBack();
    await page.waitForURL((url) => url.pathname === '/');
    await expect(page.getByRole('navigation', { name: 'Primary' })).toBeVisible();
  });

  test('a relocated route (/metrics) leaves NO top-nav tab highlighted (no stale active state)', async ({
    page,
  }) => {
    await signIn(page, 'admin');
    await page.goto('/metrics');
    // The universal bar carries no active-state mechanism, so a menu route highlights nothing —
    // no link is aria-current and none wears an active class.
    await expect(page.locator('.topbar__nav a[aria-current]')).toHaveCount(0);
    await expect(page.locator('.topbar__nav a.is-active')).toHaveCount(0);
    // The bar is still exactly the four universal tabs.
    await expect(page.locator('.topbar__nav a')).toHaveText(['Home', 'Library', 'Tickets', 'Trash']);
  });
});
