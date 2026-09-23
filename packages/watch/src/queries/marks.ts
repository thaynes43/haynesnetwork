// DESIGN-049 D-10 / D-18 — the owner's live Watch Marks (unreverted): the `watched` marks join Ever
// Watched, the dismissals exclude titles from Unfinished and picks. SELECT only.
import { watchMarks, type DbClient, type WatchMarkRow } from '@hnet/db';
import { and, eq, isNull } from 'drizzle-orm';

export async function selectLiveMarks(db: DbClient, plexAccountId: number): Promise<WatchMarkRow[]> {
  return db
    .select()
    .from(watchMarks)
    .where(and(eq(watchMarks.plexAccountId, plexAccountId), isNull(watchMarks.revertedAt)));
}
