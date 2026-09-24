// DESIGN-049 D-03 — the principal: THE `owner` row of watch_accounts (the ADR-029 Server Owner, written by
// the `watch` sync). ADR-091 C-04 / DESIGN-050 D-07 — and the USER-AWARE principal of a delegated (OAuth)
// consumer: the token user's own tracked Plex account. SELECT only.
import { userAccountMap, watchAccounts, type DbClient, type WatchAccountRole } from '@hnet/db';
import { and, eq, sql } from 'drizzle-orm';

export interface WatchOwner {
  /** plex.tv numeric account id (= Tautulli `user_id`). */
  plexAccountId: number;
  username: string;
  /** The app user with the owner's email (attribution), when one exists. */
  appUserId: string | null;
}

/** The single `owner` row, or null before the first successful `watch` sync ("not ready yet"). */
export async function selectWatchOwner(db: DbClient): Promise<WatchOwner | null> {
  const [row] = await db
    .select({
      plexAccountId: watchAccounts.plexAccountId,
      username: watchAccounts.username,
      appUserId: watchAccounts.appUserId,
    })
    .from(watchAccounts)
    .where(eq(watchAccounts.role, 'owner'))
    .limit(1);
  return row ?? null;
}

/** A tracked watch account acting as a principal, with its role (only the `owner` row may write Plex). */
export interface WatchAccountPrincipal extends WatchOwner {
  role: WatchAccountRole;
}

/**
 * ADR-091 C-04 / DESIGN-050 D-07 — the watch account a signed-in app user acts as: `users.id` → the ADR-053 Plex
 * Account Map (`user_account_map.plex_user_id`, the plex.tv numeric id stored as TEXT) → the `watch_accounts` row
 * with that id and `tracked = true`. Null when the user is unmapped, the mapped id is not numeric, or the account
 * is not tracked (the tools then answer "isn't set up for your account yet"). Never resolved through
 * `watch_accounts.app_user_id`: that is attribution only, and NULL for the owner on production.
 */
export async function selectWatchAccountForUser(
  db: DbClient,
  userId: string,
): Promise<WatchAccountPrincipal | null> {
  const [row] = await db
    .select({
      plexAccountId: watchAccounts.plexAccountId,
      username: watchAccounts.username,
      appUserId: watchAccounts.appUserId,
      role: watchAccounts.role,
    })
    .from(userAccountMap)
    .innerJoin(
      watchAccounts,
      // The map holds text; only an all-digit value is cast (a CASE, so the cast can never raise on junk).
      sql`${watchAccounts.plexAccountId} = CASE WHEN btrim(${userAccountMap.plexUserId}) ~ '^[0-9]{1,18}$' THEN btrim(${userAccountMap.plexUserId})::bigint END`,
    )
    .where(and(eq(userAccountMap.userId, userId), eq(watchAccounts.tracked, true)))
    .limit(1);
  return row ?? null;
}
