// DESIGN-049 D-03 — the principal: THE `owner` row of watch_accounts (the ADR-029 Server Owner, written by
// the `watch` sync). SELECT only.
import { watchAccounts, type DbClient } from '@hnet/db';
import { eq } from 'drizzle-orm';

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
