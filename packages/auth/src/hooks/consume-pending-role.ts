import { type DbClient } from '@hnet/db';
import { consumePendingRoleForUser } from '@hnet/domain';

/**
 * ADR-045 C-05 / DESIGN-023 (PLAN-026) — consume a PARKED role assignment on first login. When an admin
 * assigned a role to an Authentik-only identity (no app row yet), the Authentik group membership was
 * written immediately and the APP-role intent was parked in pending_role_assignments (keyed by email —
 * the OIDC sub is a hashed_user_id the app can't pre-compute, ADR-045 C-04). Now that this identity has
 * an app user row, apply the intent via the @hnet/domain single-writer (assignRole + stamp consumed in
 * one tx — the guarded write stays in packages/domain, this hook stays thin like bootstrapAdminOnSignin).
 *
 * Fires on every sign-in AFTER bootstrapAdminOnSignin (a bootstrap admin is never overridden — assignRole
 * is idempotent). Never throws into the auth flow: the session already exists — log + let the next
 * sign-in retry.
 *
 * @param dbc optional executor — tests inject the embedded-PG client; production uses the lazy default.
 */
export async function consumePendingRoleOnSignin(
  user: { id: string; email: string },
  dbc?: DbClient,
): Promise<void> {
  try {
    await consumePendingRoleForUser({ db: dbc, userId: user.id, email: user.email });
  } catch (error) {
    // The session already exists — landing in Default beats breaking the sign-in; next login retries.
    console.error(
      '[@hnet/auth] consumePendingRoleOnSignin failed (retries on next sign-in):',
      error,
    );
  }
}
