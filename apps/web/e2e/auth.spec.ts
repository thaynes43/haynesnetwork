// AC-01 — anonymous → /login; single sign-in button (no password form) → full
// stub-OIDC round trip → dashboard + 7-day session cookie; sign-out → /login.
// AC-03 — BOOTSTRAP_ADMIN_EMAILS persona lands as Admin (Admin menu link, /admin
// reachable) and STAYS Admin on repeat login; member persona has no Admin link and
// /admin bounces to /.
import { test, expect } from '@playwright/test';
import { signIn, signOut, openUserMenu, SIGN_IN_BUTTON } from './support/helpers';

test.describe('AC-01 login round trip', () => {
  test('anonymous visit redirects to /login with a single sign-in and no password form', async ({
    page,
  }) => {
    await page.goto('/');
    await expect(page).toHaveURL(/\/login$/);
    await expect(page.getByRole('button', { name: SIGN_IN_BUTTON })).toBeVisible();
    // R-01: no password form exists, anywhere.
    await expect(page.locator('input[type="password"]')).toHaveCount(0);
    await expect(page.locator('input[type="email"]')).toHaveCount(0);
  });

  test('sign-in round-trips through the stub OIDC and lands on the dashboard', async ({ page }) => {
    await signIn(page, 'member');
    await expect(page).toHaveURL('/');
    // Greeting carries the OIDC-mapped display name (AC-02 surface).
    await expect(page.locator('.greeting')).toContainText('Marge Member');

    // Session established as a ~7-day cookie (AC-01).
    const cookies = await page.context().cookies();
    const session = cookies.find((c) => c.name.includes('session_token'));
    expect(session, 'session cookie set').toBeDefined();
    const sixDaysFromNow = Date.now() / 1000 + 6 * 24 * 60 * 60;
    const eightDaysFromNow = Date.now() / 1000 + 8 * 24 * 60 * 60;
    expect(session!.expires).toBeGreaterThan(sixDaysFromNow);
    expect(session!.expires).toBeLessThan(eightDaysFromNow);
  });

  test('sign-out returns to /login and the session is gone', async ({ page }) => {
    // DESIGN-002 D-15 — Sign out routes through /api/auth/logout (RP-initiated logout).
    // The stub OIDC advertises no end_session_endpoint, so this degrades to a plain
    // local logout landing on /login — the stub-OIDC path must keep passing.
    await signIn(page, 'member');
    await signOut(page);
    await expect(page).toHaveURL(/\/login$/);
    // The gate holds: revisiting a protected route bounces straight back.
    await page.goto('/');
    await expect(page).toHaveURL(/\/login$/);
  });

  test('the /api/auth/logout route clears the session and lands on /login', async ({ page }) => {
    // DESIGN-002 D-15 — drive the RP-initiated logout route directly: it must clear the
    // Better Auth session cookie and redirect to /login (the stub issuer has no
    // end_session_endpoint, so the redirect stays local).
    await signIn(page, 'member');
    const before = await page.context().cookies();
    expect(before.some((c) => c.name.includes('session_token'))).toBe(true);

    await page.goto('/api/auth/logout');
    await expect(page).toHaveURL(/\/login$/);

    // The session cookie is deleted (Max-Age=0), not just emptied.
    const after = await page.context().cookies();
    expect(after.some((c) => c.name.includes('session_token'))).toBe(false);
  });
});

test.describe('AC-03 admin bootstrap', () => {
  test('bootstrap-admin persona is Admin: sees the Admin link and can open /admin', async ({
    page,
  }) => {
    await signIn(page, 'admin');
    await openUserMenu(page);
    const adminLink = page.getByRole('menuitem', { name: 'Admin settings' });
    await expect(adminLink).toBeVisible();
    // The menu no longer carries Library or My fixes — those live in the top nav / Library tabs.
    await expect(page.getByRole('menuitem', { name: 'Library' })).toHaveCount(0);
    await expect(page.getByRole('menuitem', { name: 'My fixes' })).toHaveCount(0);
    await adminLink.click();
    await expect(page).toHaveURL(/\/admin$/);
    await expect(page.getByRole('heading', { name: 'Users' })).toBeVisible();
  });

  test('repeat login is a no-op — still Admin', async ({ page }) => {
    await signIn(page, 'admin');
    await signOut(page);
    await signIn(page, 'admin');
    await openUserMenu(page);
    await expect(page.getByRole('menuitem', { name: 'Admin settings' })).toBeVisible();
  });

  test('member persona has no Admin link and /admin redirects away', async ({ page }) => {
    await signIn(page, 'member');
    await openUserMenu(page);
    // Menu is open (Sign out is there) but no Admin entry exists for a Member.
    await expect(page.getByRole('menuitem', { name: 'Sign out' })).toBeVisible();
    await expect(page.getByRole('menuitem', { name: 'Admin settings' })).toHaveCount(0);
    // Server-side gate: direct navigation bounces to the dashboard.
    await page.goto('/admin');
    await expect(page).toHaveURL('/');
  });
});
