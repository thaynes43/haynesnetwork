// fix/plex-identity-mapping — My Plex resolves the caller's REAL Plex identity from the OIDC
// id_token `plex_email` claim (Authentik Plex-source mapping), NOT the app/OIDC email. The
// `plex-linked-owner` persona's app email is linked-owner@example.test but its claim carries the
// stub server OWNER email (plex-owner@example.test), so owner recognition must fire even though the
// two emails differ — the exact shape of the owner's real bug (Authentik admin@haynesnetwork.com
// vs plex.tv manofoz@gmail.com). Hermetic via the shared stub OIDC + stub-plex (default owner
// email, never overridden here).
import { test, expect } from '@playwright/test';
import { signIn } from './support/helpers';

test.describe('My Plex — real Plex identity from the id_token claim (fix/plex-identity-mapping)', () => {
  test('the owner is recognized via the plex_email claim when it differs from the app email', async ({
    page,
  }) => {
    await signIn(page, 'plex-linked-owner');
    await page.goto('/library/plex');
    await expect(page.getByRole('heading', { name: 'My Plex libraries' })).toBeVisible();

    // Owner state (ADR-029) — resolved by the claim, not the app email.
    await expect(page.getByText('all libraries are already yours').first()).toBeVisible({
      timeout: 20_000,
    });
    // The unlinked note must NOT show for this account.
    await expect(page.getByText('linked to a Plex identity')).toHaveCount(0);
    // No add control while owner — every library reads as Included.
    await expect(page.getByTestId('plex-add')).toHaveCount(0);
  });
});
