import { type DbClient } from '@hnet/db';
import { mapPlexUserIdFromStoredIdentity } from '@hnet/domain';

/**
 * ADR-053 / DESIGN-026 D-07 (PLAN-029 R7) — record the signed-in user's plex.tv numeric id in the Plex
 * Account Map (T-154), so the metadata harvest can attribute their Tautulli plays to them (the per-user
 * Watched / In-progress facets on the Movies + TV walls). The `plex_user_id` claim rides the id_token
 * that Better Auth writes onto the linked `account` row BEFORE it creates the session, so it is already
 * stored when this `session.create.after` hook runs.
 *
 * Thin, like bootstrapAdminOnSignin / consumePendingRoleOnSignin: the resolution + the fill-if-empty write
 * live in the @hnet/domain single-writer (never overwrites an existing or admin-set id). Idempotent.
 * Never throws into the auth flow: the session already exists, so a failure is logged and the
 * metadata-refresh reconcile (`reconcilePlexUserIdMappings`) maps the user on its next run.
 *
 * @param dbc optional executor — tests inject the embedded-PG client; production uses the lazy default.
 */
export async function mapPlexAccountOnSignin(user: { id: string }, dbc?: DbClient): Promise<void> {
  try {
    const { outcome, plexUserId } = await mapPlexUserIdFromStoredIdentity({
      db: dbc,
      userId: user.id,
    });
    if (outcome === 'conflict') {
      // One plex.tv account maps to at most one app user (UNIQUE) — an admin resolves the duplicate.
      console.warn(
        '[@hnet/auth] mapPlexAccountOnSignin: plex.tv id already mapped to another app user; left unmapped',
        { userId: user.id, plexUserId },
      );
    }
  } catch (error) {
    console.error(
      '[@hnet/auth] mapPlexAccountOnSignin failed (the metadata-refresh reconcile retries):',
      error,
    );
  }
}
