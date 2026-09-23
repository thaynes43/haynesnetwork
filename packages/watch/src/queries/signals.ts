// ADR-089 / DESIGN-049 D-09 steps 6–7 / D-17 — the recommendation signal cache. SELECT only.
import { watchRecoSignals, type DbClient, type WatchRecoSignalRow, type WatchRecoSource } from '@hnet/db';
import { and, eq, sql } from 'drizzle-orm';

/** When a source was last fetched for the account (null: never) — the D-17 20-hour seed cadence. */
export async function selectSignalsFetchedAt(
  db: DbClient,
  plexAccountId: number,
  source: WatchRecoSource,
): Promise<Date | null> {
  const [row] = await db
    .select({ at: sql<Date | string | null>`max(${watchRecoSignals.fetchedAt})` })
    .from(watchRecoSignals)
    .where(and(eq(watchRecoSignals.plexAccountId, plexAccountId), eq(watchRecoSignals.source, source)));
  const at = row?.at ?? null;
  return at === null ? null : at instanceof Date ? at : new Date(at);
}

/** One source's rows for the account, in rank order. */
export async function selectSignals(
  db: DbClient,
  plexAccountId: number,
  source: WatchRecoSource,
): Promise<WatchRecoSignalRow[]> {
  return db
    .select()
    .from(watchRecoSignals)
    .where(and(eq(watchRecoSignals.plexAccountId, plexAccountId), eq(watchRecoSignals.source, source)))
    .orderBy(watchRecoSignals.rank, watchRecoSignals.id);
}
