import { randomUUID } from 'node:crypto';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { trashTitleDeleteClaims, type DbClient, type Transaction } from '@hnet/db';
import { inTransaction } from './db-client';
import { isPgLockTimeout } from './errors';
import { consoleDomainLogger, type DomainLogger } from './domain-logger';

export interface TrashTitleIdentity {
  arrKind: 'radarr' | 'sonarr';
  externalId: number;
}
export function trashTitleIdentity(item: {
  arrKind: string;
  tmdbId: number | null;
  tvdbId: number | null;
}): TrashTitleIdentity | null {
  const externalId = item.arrKind === 'radarr' ? item.tmdbId : item.tvdbId;
  return (item.arrKind === 'radarr' || item.arrKind === 'sonarr') &&
    externalId !== null &&
    externalId > 0
    ? { arrKind: item.arrKind, externalId }
    : null;
}

/** Nonblocking across replicas. Never wait on a competing operation or continue without its lock. */
export async function lockTrashTitle(
  tx: Transaction,
  identity: TrashTitleIdentity,
): Promise<boolean> {
  const result = await tx.execute<{ locked: boolean }>(
    sql`SELECT pg_try_advisory_xact_lock(hashtext('trash-title:' || ${identity.arrKind}), ${identity.externalId}) AS locked`,
  );
  return result.rows[0]?.locked === true;
}
export async function hasTitleDeleteClaim(
  tx: Transaction,
  identity: TrashTitleIdentity,
): Promise<boolean> {
  return (
    (
      await tx
        .select()
        .from(trashTitleDeleteClaims)
        .where(
          and(
            eq(trashTitleDeleteClaims.arrKind, identity.arrKind),
            eq(trashTitleDeleteClaims.externalId, identity.externalId),
            isNull(trashTitleDeleteClaims.completedAt),
          ),
        )
        .limit(1)
    ).length > 0
  );
}
/** Caller already holds the title lock and co-writes the normal deletion audit in this transaction. */
export async function claimTitleDeletion(
  tx: Transaction,
  identity: TrashTitleIdentity,
): Promise<string | null> {
  if (await hasTitleDeleteClaim(tx, identity)) return null;
  const claimId = randomUUID();
  await tx
    .insert(trashTitleDeleteClaims)
    .values({ ...identity, claimId })
    .onConflictDoUpdate({
      target: [trashTitleDeleteClaims.arrKind, trashTitleDeleteClaims.externalId],
      set: { claimId, claimedAt: new Date(), completedAt: null },
    });
  return claimId;
}
export async function finishTitleDeletion(
  db: DbClient | undefined,
  identity: TrashTitleIdentity,
  claimId: string,
  logger: DomainLogger = consoleDomainLogger,
): Promise<void> {
  try {
    await inTransaction(db, async (tx) => {
      // A definitive settle must not silently strand its claim on ordinary title-lock contention.
      // Bound the wait; timeout retains the claim, logs a hold and lets other titles finish safely.
      await tx.execute(sql`SET LOCAL lock_timeout = '5s'`);
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtext('trash-title:' || ${identity.arrKind}), ${identity.externalId})`,
      );
      await tx
        .update(trashTitleDeleteClaims)
        .set({ completedAt: new Date() })
        .where(
          and(
            eq(trashTitleDeleteClaims.arrKind, identity.arrKind),
            eq(trashTitleDeleteClaims.externalId, identity.externalId),
            eq(trashTitleDeleteClaims.claimId, claimId),
          ),
        );
    });
  } catch (error) {
    if (!isPgLockTimeout(error)) throw error;
    logger.warn('[trash] settled deletion claim retained after lock timeout', {
      ...identity,
      deleteClaimId: claimId,
      code: '55P03',
    });
  }
}
