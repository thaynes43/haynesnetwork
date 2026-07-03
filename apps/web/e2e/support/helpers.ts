// Shared spec helpers: persona sign-in/out through the REAL stub-OIDC round trip
// (no cookie forgery — AC-01's flow is the only way in) and the viewport-fit
// measurement ported from demo-console's resize matrix (AC-10).
import { expect, type Page } from '@playwright/test';
import type { PersonaName } from './stub-oidc';
import { readRuntimeEnv } from './runtime-env';

export const SIGN_IN_BUTTON = 'Sign in with Plex (Authentik)';

/** Point the stub OIDC at a persona — sticky until changed (workers=1 keeps this race-free). */
export async function selectStubUser(persona: PersonaName): Promise<void> {
  const env = readRuntimeEnv();
  const res = await fetch(`${env.STUB_OIDC_URL}/_control/user`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ persona }),
  });
  if (res.status !== 204) {
    throw new Error(`stub OIDC persona select failed: ${res.status} ${await res.text()}`);
  }
}

/**
 * Full AC-01 round trip: /login → sign-in button → stub authorize → Better Auth
 * callback → dashboard. Resolves once the dashboard greeting is on screen.
 */
export async function signIn(page: Page, persona: PersonaName): Promise<void> {
  await selectStubUser(persona);
  await page.goto('/login');
  await page.getByRole('button', { name: SIGN_IN_BUTTON }).click();
  await page.waitForURL('/');
  await expect(page.locator('.greeting')).toBeVisible();
}

/** Open the user menu (topbar trigger — popover with Admin link / Sign out). */
export async function openUserMenu(page: Page): Promise<void> {
  await page.locator('.usermenu__trigger').click();
  await expect(page.getByRole('menu', { name: 'Account' })).toBeVisible();
}

/** Sign out through the user menu; resolves on /login. */
export async function signOut(page: Page): Promise<void> {
  await openUserMenu(page);
  await page.getByRole('menuitem', { name: 'Sign out' }).click();
  await page.waitForURL('/login');
}

export interface FitMetrics {
  pageVScroll: number;
  pageHScroll: number;
  maxRight: number;
  innerW: number;
}

/**
 * demo-console resize-matrix port: page-level scroll overflow plus the widest
 * UNCLIPPED element right-edge. Elements inside an ancestor with overflow
 * auto|scroll|hidden are skipped — content in an internally-scrolling pane may
 * extend past the viewport in layout without ever pushing the page.
 */
export async function measureFit(page: Page): Promise<FitMetrics> {
  return page.evaluate(() => {
    const de = document.documentElement;
    const clipped = (el: HTMLElement): boolean => {
      let p = el.parentElement;
      while (p && p !== document.body) {
        const o = getComputedStyle(p);
        if (/(auto|scroll|hidden)/.test(o.overflowX + ' ' + o.overflowY)) return true;
        p = p.parentElement;
      }
      return false;
    };
    let maxRight = 0;
    document.querySelectorAll('body *').forEach((el) => {
      const he = el as HTMLElement;
      if (he.closest('[aria-hidden="true"]')) return;
      if (clipped(he)) return;
      const r = he.getBoundingClientRect();
      if (r.width > 0 && r.height > 0 && r.right > maxRight) maxRight = r.right;
    });
    return {
      pageVScroll: de.scrollHeight - de.clientHeight,
      pageHScroll: de.scrollWidth - de.clientWidth,
      maxRight,
      innerW: window.innerWidth,
    };
  });
}

/** AC-10 invariants: no page-level scrollbars, nothing pushed off-screen. */
export async function expectViewportFit(page: Page): Promise<void> {
  const m = await measureFit(page);
  expect(m.pageVScroll, 'no page-level vertical scrollbar').toBeLessThanOrEqual(1);
  expect(m.pageHScroll, 'no page-level horizontal scrollbar').toBeLessThanOrEqual(1);
  expect(m.maxRight, 'no element wider than the viewport').toBeLessThanOrEqual(m.innerW + 1);
}
