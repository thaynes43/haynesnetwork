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
    /**
     * ADR-099 D-2 — whether Maintainerr was just read back holding the exclusion on `maintainerrMediaId`. True on the
     * Maintainerr-first paths (the exclusion was written or found first); false on the record-first Save path, where
     * the keeper applies it afterwards. A false never un-confirms an open intent already confirmed on the SAME key (a
     * re-save of a saved title); a different key resets it, so the keeper applies the exclusion on the new key.
     */
    exclusionConfirmed: boolean;
  },
): Promise<{ intentId: string } | null> {
  const [item] = await tx
    .select({ arrKind: mediaItems.arrKind })
    .from(mediaItems)
    .where(eq(mediaItems.id, input.mediaItemId))
    .limit(1);
  const mediaKind = trashMediaKindForArrKind(item?.arrKind ?? null);
  if (mediaKind === null) return null;

  const now = new Date();
  const confirmedOnConflict = input.exclusionConfirmed
    ? {
        exclusionConfirmedAt: now,
        applyAttempts: 0,
        lastApplyError: null,
      }
    : {
        // Same key and already confirmed ⇒ stays confirmed; a new key ⇒ pending until the keeper applies it.
        exclusionConfirmedAt: sql`CASE WHEN ${trashSaveIntents.maintainerrMediaId} = ${input.maintainerrMediaId}
          THEN ${trashSaveIntents.exclusionConfirmedAt} ELSE NULL END`,
      };
  const [row] = await tx
    .insert(trashSaveIntents)
    .values({
      mediaItemId: input.mediaItemId,
      mediaKind,
      maintainerrMediaId: input.maintainerrMediaId,
      origin: input.origin,
      savedByUserId: input.actorId,
      exclusionConfirmedAt: input.exclusionConfirmed ? now : null,
      ...(input.relink === true ? { relinkCount: 1, lastRelinkedAt: now } : {}),
    })
    .onConflictDoUpdate({
      target: trashSaveIntents.mediaItemId,
      targetWhere: isNull(trashSaveIntents.revokedAt),
      set: {
        maintainerrMediaId: input.maintainerrMediaId,
        updatedAt: now,
        ...confirmedOnConflict,
        ...(input.relink === true
          ? {
              relinkCount: sql`${trashSaveIntents.relinkCount} + 1`,
              lastRelinkedAt: now,
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

/**
 * ADR-099 D-2 — the keeper read Maintainerr back holding the exclusion for this intent on `maintainerrMediaId`: stamp
 * it confirmed and re-point the intent at that key. Guarded on the intent still being OPEN — returns false when an
 * un-save revoked it while the exclusion was being applied, so the caller can take the exclusion back off (a revoked
 * Save must not leave an exclusion behind). No ledger row: the Save was audited when it was recorded, and this only
 * completes it.
 */
export async function markSaveIntentApplied(
  db: DbClient | undefined,
  input: { intentId: string; maintainerrMediaId: string },
): Promise<boolean> {
  const now = new Date();
  const updated = await resolveDb(db)
    .update(trashSaveIntents)
    .set({
      maintainerrMediaId: input.maintainerrMediaId,
      exclusionConfirmedAt: now,
      applyAttempts: 0,
      lastApplyAttemptAt: now,
      lastApplyError: null,
      updatedAt: now,
    })
    .where(and(eq(trashSaveIntents.id, input.intentId), isNull(trashSaveIntents.revokedAt)))
    .returning({ id: trashSaveIntents.id });
  return updated.length > 0;
}

/**
 * ADR-099 D-3 — an attempt to apply the exclusion failed (Maintainerr busy, slow or down). Counted and kept on the
 * intent for the keeper's report; the intent stays open and pending, so the next tick tries again. The message is
 * truncated: it is an operator hint, never a payload.
 */
export async function recordSaveIntentApplyFailure(
  db: DbClient | undefined,
  input: { intentId: string; error: string },
): Promise<void> {
  const now = new Date();
  await resolveDb(db)
    .update(trashSaveIntents)
    .set({
      applyAttempts: sql`${trashSaveIntents.applyAttempts} + 1`,
      lastApplyAttemptAt: now,
      lastApplyError: input.error.slice(0, 500),
      updatedAt: now,
    })
    .where(and(eq(trashSaveIntents.id, input.intentId), isNull(trashSaveIntents.revokedAt)));
}

/**
 * ADR-099 D-5 — Maintainerr was read back WITHOUT the exclusion this intent last confirmed (it lost it: a re-key and
 * the nightly prune, or a hand removal). Clear the confirmation so the keeper re-applies it; the intent itself (the
 * Save) is untouched.
 */
export async function markSaveIntentLapsed(
  db: DbClient | undefined,
  input: { intentId: string },
): Promise<void> {
  await resolveDb(db)
    .update(trashSaveIntents)
    .set({ exclusionConfirmedAt: null, updatedAt: new Date() })
    .where(and(eq(trashSaveIntents.id, input.intentId), isNull(trashSaveIntents.revokedAt)));
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
