import { and, eq, inArray, isNull, or, sql } from 'drizzle-orm';
import {
  ledgerEvents,
  mediaItems,
  trashDeletedReleases,
  trashRestoreKeeps,
  type DbClient,
  type MediaItemRow,
} from '@hnet/db';
import { inTransaction, resolveDb } from './db-client';
import type { ArrClientBundle } from './arr-clients';
import { RELEASE_BLOCK_PROFILE_NAME, RELEASE_BLOCK_SENTINEL } from './release-terms';
import { ReleaseBlockError } from './errors';

/** ADR-121: ANY deletion record, even abandoned/expired, excludes a bulk re-add.
 * External identity also catches a release record linked to an older ledger row. */
export function trashHistoryWhere() {
  return sql<boolean>`(
    EXISTS (SELECT 1 FROM trash_deleted_releases d WHERE d.arr_kind = ${mediaItems.arrKind}
      AND (d.media_item_id = ${mediaItems.id}
        OR (d.arr_kind = 'radarr' AND d.tmdb_id = ${mediaItems.tmdbId})
        OR (d.arr_kind = 'sonarr' AND d.tvdb_id = ${mediaItems.tvdbId})))
    OR EXISTS (SELECT 1 FROM ledger_events e WHERE e.media_item_id = ${mediaItems.id} AND e.event_type = 'trash_expedited')
    OR EXISTS (SELECT 1 FROM trash_batch_items b JOIN trash_batches batch ON batch.id = b.batch_id
      WHERE b.state = 'deleted' AND (b.media_item_id = ${mediaItems.id}
        OR (batch.media_kind = 'movie' AND ${mediaItems.arrKind} = 'radarr' AND b.tmdb_id = ${mediaItems.tmdbId})
        OR (batch.media_kind = 'tv' AND ${mediaItems.arrKind} = 'sonarr' AND b.tvdb_id = ${mediaItems.tvdbId})))
  )`;
}

export async function trashHistoryIds(
  db: DbClient | undefined,
  ids: string[],
): Promise<Set<string>> {
  if (ids.length === 0) return new Set();
  const rows = await resolveDb(db)
    .select({ id: mediaItems.id })
    .from(mediaItems)
    .where(and(inArray(mediaItems.id, ids), trashHistoryWhere()));
  return new Set(rows.map((r) => r.id));
}

/** Read-only precondition. Never runs upkeep: Restore must never remove an older term.
 * The *arr's own global ignored terms apply to a monitored re-add's later RSS/search. */
export async function verifyRestoreReleaseBlock(input: {
  db?: DbClient;
  arr: ArrClientBundle;
  item: MediaItemRow;
}): Promise<void> {
  const kind = input.item.arrKind;
  if (kind === 'lidarr') return;
  const records = await resolveDb(input.db)
    .select()
    .from(trashDeletedReleases)
    .where(
      and(
        eq(trashDeletedReleases.arrKind, kind),
        or(eq(trashDeletedReleases.mediaItemId, input.item.id),
          kind === 'radarr'
            ? eq(trashDeletedReleases.tmdbId, input.item.tmdbId!)
            : eq(trashDeletedReleases.tvdbId, input.item.tvdbId!)),
      ),
    );
  const terms = records
    .filter((r) => (r.state === 'active' || r.state === 'in_flight') && r.expiresAt > new Date())
    .map((r) => r.term)
    .filter((t): t is string => t !== null);
  // No live term is not proof of protection for a deliberately deleted title.
  if (terms.length === 0) throw new ReleaseBlockError(kind, 'validate');
  const profiles = await input.arr.write[kind].listReleaseProfiles(); // this client method is GET-only
  const ours = profiles.filter((p) => p.name === RELEASE_BLOCK_PROFILE_NAME);
  const p = ours[0];
  if (
    ours.length !== 1 ||
    !p ||
    !p.enabled ||
    (p.tags?.length ?? 0) !== 0 ||
    p.indexerId !== 0 ||
    (p.required?.length ?? 0) !== 0 ||
    !p.ignored?.includes(RELEASE_BLOCK_SENTINEL) ||
    terms.some((t) => !p.ignored?.includes(t))
  ) {
    throw new ReleaseBlockError(kind, 'validate');
  }
}

/** ADR-121: admin-only API calls this local writer; no external writes, no Save revocation. */
export async function removeRestoreKeep(input: {
  db?: DbClient;
  mediaItemId: string;
  actorId: string;
}): Promise<{ removed: boolean }> {
  return inTransaction(input.db, async (tx) => {
    const rows = await tx
      .update(trashRestoreKeeps)
      .set({ revokedAt: new Date(), revokedBy: input.actorId })
      .where(
        and(
          eq(trashRestoreKeeps.mediaItemId, input.mediaItemId),
          isNull(trashRestoreKeeps.revokedAt),
        ),
      )
      .returning({ id: trashRestoreKeeps.mediaItemId });
    if (rows.length > 0)
      await tx.insert(ledgerEvents).values({
        mediaItemId: input.mediaItemId,
        eventType: 'trash_excluded',
        source: 'maintainerr',
        occurredAt: new Date(),
        requestedByUserId: input.actorId,
        payload: { action: 'remove_restore_keep' },
      });
    return { removed: rows.length > 0 };
  });
}

export async function hasRestoreKeep(
  db: DbClient | undefined,
  mediaItemId: string,
): Promise<boolean> {
  const rows = await resolveDb(db)
    .select({ id: trashRestoreKeeps.mediaItemId })
    .from(trashRestoreKeeps)
    .where(and(eq(trashRestoreKeeps.mediaItemId, mediaItemId), isNull(trashRestoreKeeps.revokedAt)))
    .limit(1);
  return rows.length > 0;
}
