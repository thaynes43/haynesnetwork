import { and, eq, isNull, sql } from 'drizzle-orm';
import { mediaItems, trashSaveIntents, type TrashMediaKind } from '@hnet/db';
import type { DbClient, Transaction } from '@hnet/db';
import { resolveDb } from './db-client';

/**
 * ADR-086 / DESIGN-048 D-02 — the save-intent SINGLE WRITER.
 *
 * These helpers are the only code permitted to write `trash_save_intents` (enforced by the
 * no-direct-state-writes guard). They take a transaction handle rather than a `DbClient` because
 * every call site must run them in the SAME transaction as the `trash_excluded` ledger row they
 * accompany (hard rule 6) — the intent and its audit trail are written together or not at all.
 */

/** Which *arr kinds map onto a Trash media kind. Lidarr is never a Trash target (ADR-023 C-06). */
export function trashMediaKindForArrKind(arrKind: string | null): TrashMediaKind | null {
  if (arrKind === 'radarr') return 'movie';
  if (arrKind === 'sonarr') return 'tv';
  return null;
}

/**
 * Open (or refresh) the intent for a media item.
 *
 * Upserts onto `trash_save_intents_one_open_per_item` (the partial unique index over unrevoked
 * rows, ADR-086 D-1). An existing open intent has its `maintainerr_media_id` refreshed — that is
 * how a relink re-points an intent at the title's new key without minting history. A *revoked* row
 * is never resurrected: the partial index does not cover it, so a re-save after a revoke inserts a
 * NEW row and the revocation stays in the record.
 *
 * Returns null when the item has no usable *arr identity (unknown to our ledger, or lidarr) — the
 * ADR-086 D-13 unlinkable case. Callers must treat null as "no durable intent", never as an error.
 */
export async function openSaveIntent(
  tx: Transaction,
  input: {
    mediaItemId: string;
    maintainerrMediaId: string;
    origin: 'user' | 'batch_save' | 'backfill';
    actorId: string | null;
    /** Set when this write is a reconciler relink rather than a fresh save. */
    relink?: boolean;
  },
): Promise<{ intentId: string } | null> {
  const [item] = await tx
    .select({ arrKind: mediaItems.arrKind })
    .from(mediaItems)
    .where(eq(mediaItems.id, input.mediaItemId))
    .limit(1);
  const mediaKind = trashMediaKindForArrKind(item?.arrKind ?? null);
  if (mediaKind === null) return null;

  const [row] = await tx
    .insert(trashSaveIntents)
    .values({
      mediaItemId: input.mediaItemId,
      mediaKind,
      maintainerrMediaId: input.maintainerrMediaId,
      origin: input.origin,
      savedByUserId: input.actorId,
      ...(input.relink === true ? { relinkCount: 1, lastRelinkedAt: new Date() } : {}),
    })
    .onConflictDoUpdate({
      target: trashSaveIntents.mediaItemId,
      targetWhere: isNull(trashSaveIntents.revokedAt),
      set: {
        maintainerrMediaId: input.maintainerrMediaId,
        updatedAt: new Date(),
        ...(input.relink === true
          ? {
              relinkCount: sql`${trashSaveIntents.relinkCount} + 1`,
              lastRelinkedAt: new Date(),
            }
          : {}),
      },
    })
    .returning({ intentId: trashSaveIntents.id });

  return row ?? null;
}

/**
 * Revoke the open intent for a media item, if there is one.
 *
 * ADR-086 D-3 — this must be reachable even when there is NO live Maintainerr exclusion left to
 * remove, because that is exactly the lapsed state this whole design exists to fix. If revocation
 * were gated on a successful un-exclude, the owner would have no way to stop the reconciler
 * re-protecting a title they no longer want. Returns whether a row was actually revoked, so the
 * caller can decide whether an `unsave` ledger row is warranted.
 */
export async function revokeSaveIntent(
  tx: Transaction,
  input: { mediaItemId: string; actorId: string | null },
): Promise<boolean> {
  const revoked = await tx
    .update(trashSaveIntents)
    .set({ revokedAt: new Date(), revokedByUserId: input.actorId, updatedAt: new Date() })
    .where(
      and(
        eq(trashSaveIntents.mediaItemId, input.mediaItemId),
        isNull(trashSaveIntents.revokedAt),
      ),
    )
    .returning({ id: trashSaveIntents.id });
  return revoked.length > 0;
}

/** Is there an unrevoked intent for this media item? (Read-only helper for tests and reporting.) */
export async function hasOpenSaveIntent(db: DbClient | undefined, mediaItemId: string): Promise<boolean> {
  const [row] = await resolveDb(db)
    .select({ id: trashSaveIntents.id })
    .from(trashSaveIntents)
    .where(
      and(eq(trashSaveIntents.mediaItemId, mediaItemId), isNull(trashSaveIntents.revokedAt)),
    )
    .limit(1);
  return row !== undefined;
}
