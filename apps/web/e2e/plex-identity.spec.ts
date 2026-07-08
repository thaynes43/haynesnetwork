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

  // fix/plex-numeric-id — the RECOMMENDED automatic path. The `plex-linked-owner-id` persona
  // carries ONLY the plex.tv numeric id (plex_user_id = STUB_PLEX_OWNER.id), no plex_email/username,
  // and its app email matches nothing on Plex. Owner recognition must fire from the id ALONE — this
  // is the owner's real production shape (Authentik reliably holds his numeric id, not his emails).
  test('the owner is recognized from the plex.tv numeric id alone (no email/username claim)', async ({
    page,
  }) => {
    await signIn(page, 'plex-linked-owner-id');
    await page.goto('/library/plex');
    await expect(page.getByRole('heading', { name: 'My Plex libraries' })).toBeVisible();

    // Owner state (ADR-029) — resolved by the numeric id alone.
    await expect(page.getByText('all libraries are already yours').first()).toBeVisible({
      timeout: 20_000,
    });
    await expect(page.getByText('linked to a Plex identity')).toHaveCount(0);
    await expect(page.getByTestId('plex-add')).toHaveCount(0);
  });
});
