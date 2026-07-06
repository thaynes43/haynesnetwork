// ADR-023 / DESIGN-010 end to end (backend vertical): the /trash section GATE (Admin reaches the
// placeholder, a Disabled-trash member gets the "not available" state), the retired Admin → Restore
// nav item now REDIRECTS to /trash, and the Maintainerr webhook receiver rejects without the shared
// secret and accepts with it. The full Trash UX (pending tables, Save/Expedite, Rules, Activity) is
// the Fable follow-up; those journeys land with it. Serial — the suite shares one stack.
import { test, expect } from '@playwright/test';
import { signIn, signOut } from './support/helpers';
import { readRuntimeEnv } from './support/env';

test.describe('trash section gate + webhook (DESIGN-010)', () => {
  test.describe.configure({ mode: 'serial' });

  test('the Admin → Restore nav item is gone and /admin/restore redirects to /trash', async ({
    page,
  }) => {
    await signIn(page, 'admin');
    await page.goto('/admin');
    // The Restore admin-nav link is retired (D-08).
    await expect(page.locator('.admin-nav').getByRole('link', { name: 'Restore' })).toHaveCount(0);
    // Hitting the old route lands on /trash.
    await page.goto('/admin/restore');
    await page.waitForURL('**/trash');
    await expect(page.getByRole('heading', { name: 'Trash' })).toBeVisible();
  });

  test('Admin (trash=edit) sees the Trash section; a Default member sees "not available"', async ({
    page,
  }) => {
    await signIn(page, 'admin');
    await page.goto('/trash');
    await expect(page.getByTestId('trash-placeholder')).toBeVisible();
    await signOut(page);

    // A plain member's Default role has Trash Disabled → the friendly dead-end, never a raw 403.
    await signIn(page, 'fresh-member');
    await page.goto('/trash');
    await expect(page.getByTestId('trash-unavailable')).toBeVisible();
  });

  test('the Maintainerr webhook rejects without the shared secret and accepts with it', async ({
    request,
  }) => {
    const env = readRuntimeEnv();
    const url = `${env.BETTER_AUTH_URL}/api/webhooks/maintainerr`;
    const body = { notification_type: 'MEDIA_DELETED', subject: 'Cleaned up', message: '2 items' };

    const noSecret = await request.post(url, { data: body });
    expect(noSecret.status()).toBe(401);

    const withSecret = await request.post(url, {
      headers: { 'x-webhook-secret': env.MAINTAINERR_WEBHOOK_SECRET },
      data: body,
    });
    expect(withSecret.status()).toBe(202);
    const json = (await withSecret.json()) as { ok: boolean; id: string };
    expect(json.ok).toBe(true);
    expect(json.id).toBeTruthy();
  });
});
