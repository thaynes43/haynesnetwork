import { type DbClient } from '@hnet/db';
import { assignRole, getAdminRoleId } from '@hnet/domain';
import { parseBootstrapAdminEmails } from '../env';

/**
 * DESIGN-002 D-05 — promote any user whose email is on the BOOTSTRAP_ADMIN_EMAILS
 * allowlist (comma-separated, case-insensitive) to the Admin role on every sign-in.
 * Idempotent — no-op when already Admin (AC-03 "repeat logins are no-ops"). Routes through
 * assignRole (ADR-012 / DESIGN-001 D-12 single-writer invariant) so the promotion and its
 * user_role_transitions audit row commit in one transaction (R-02, R-04, AC-03).
 * Initiator is system (initiatorKind: 'system', initiatorId: null).
 *
 * Never throws into the auth flow: by the time this fires the sign-in has already
 * succeeded (session row exists), so failures are logged and the next sign-in retries
 * the promotion (DESIGN-002 D-05 failure mode).
 *
 * @param dbc optional executor (a Database or an open Transaction) — tests inject the
 *            embedded-PG client; production uses the lazy @hnet/db default.
 */
export async function bootstrapAdminOnSignin(
  user: { id: string; email: string },
  dbc?: DbClient,
): Promise<void> {
  try {
    const allowlist = parseBootstrapAdminEmails(process.env.BOOTSTRAP_ADMIN_EMAILS);
    if (!allowlist.includes(user.email.toLowerCase())) return;

    const adminRoleId = await getAdminRoleId(dbc);
    // assignRole is idempotent — already-Admin is a no-op with no audit row (AC-03).
    await assignRole({
      db: dbc,
      userId: user.id,
      toRoleId: adminRoleId,
      initiator: { id: null, kind: 'system' },
      note: 'BOOTSTRAP_ADMIN_EMAILS promotion',
    });
  } catch (error) {
    // The session already exists — landing as Member beats breaking the sign-in.
    console.error(
      '[@hnet/auth] bootstrapAdminOnSignin failed (promotion retries on next sign-in):',
      error,
    );
  }
}
