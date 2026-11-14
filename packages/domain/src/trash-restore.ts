import { and, eq, inArray, isNull, or, sql } from 'drizzle-orm';
import {
  ledgerEvents,
  mediaItems,
  trashDeletedReleases,
  trashRestoreKeeps,
  releasePickLists,
  type DbClient,
  type MediaItemRow,
} from '@hnet/db';
import { inTransaction, resolveDb } from './db-client';
import type { ArrClientBundle } from './arr-clients';
import { RELEASE_BLOCK_PROFILE_NAME, RELEASE_BLOCK_SENTINEL } from './release-terms';
import { ReleaseBlockError } from './errors';
import { lockTrashTitle, trashTitleIdentity, type TrashTitleIdentity } from './trash-title-lock';
import { forgetAllReleaseLists } from './fix-plan';

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

/** Check exactly the frozen identity that will be in an add body, even after its ledger row rematches. */
export async function hasTrashHistoryForItem(
  db: DbClient | undefined,
  item: MediaItemRow,
): Promise<boolean> {
  if (item.arrKind === 'lidarr') return (await trashHistoryIds(db, [item.id])).has(item.id);
  const identity = trashTitleIdentity(item);
  if (!identity) return true;
  const result = await resolveDb(db).execute<{ found: boolean }>(sql`SELECT (
    EXISTS (SELECT 1 FROM trash_deleted_releases d WHERE d.arr_kind = ${identity.arrKind}
      AND (d.media_item_id = ${item.id} OR ${identity.arrKind === 'radarr' ? sql`d.tmdb_id` : sql`d.tvdb_id`} = ${identity.externalId}))
    OR EXISTS (SELECT 1 FROM ledger_events e WHERE e.media_item_id = ${item.id} AND e.event_type = 'trash_expedited')
    OR EXISTS (SELECT 1 FROM trash_batch_items b JOIN trash_batches batch ON batch.id = b.batch_id
      WHERE b.state = 'deleted' AND (b.media_item_id = ${item.id} OR (batch.media_kind = ${identity.arrKind === 'radarr' ? 'movie' : 'tv'}
        AND ${identity.arrKind === 'radarr' ? sql`b.tmdb_id` : sql`b.tvdb_id`} = ${identity.externalId})))
  ) AS found`);
  return result.rows[0]?.found === true;
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

/** Invalidate durable offers and local cached searches at a title transition. Other replicas' cached
 * search rows never authorize a POST: the writer independently checks live terms. */
export async function invalidateTrashReleaseOffers(
  db: DbClient | undefined,
  identity: TrashTitleIdentity,
): Promise<void> {
  const executor = resolveDb(db);
  await executor
    .update(releasePickLists)
    .set({ offers: [], reasonsVersion: -1 })
    .where(
      and(
        eq(releasePickLists.arrKind, identity.arrKind),
        sql`${releasePickLists.mediaItemId} IN (SELECT id FROM media_items WHERE arr_kind = ${identity.arrKind}
      AND ${identity.arrKind === 'radarr' ? sql`tmdb_id` : sql`tvdb_id`} = ${identity.externalId})`,
      ),
    );
  forgetAllReleaseLists();
}

/** A title keep is found only by its immutable external identity, never by the convenience link. */
export async function hasRestoreKeepForIdentity(
  db: DbClient | undefined,
  identity: TrashTitleIdentity | null,
): Promise<boolean> {
  if (!identity) return true; // identity uncertainty never grants deletion
  return (
    (
      await resolveDb(db)
        .select({ id: trashRestoreKeeps.id })
        .from(trashRestoreKeeps)
        .where(
          and(
            eq(trashRestoreKeeps.arrKind, identity.arrKind),
            eq(trashRestoreKeeps.externalId, identity.externalId),
            isNull(trashRestoreKeeps.revokedAt),
          ),
        )
        .limit(1)
    ).length > 0
  );
}

/** Admin-only local writer. keepId remains usable after the ledger row has gone. */
export async function removeRestoreKeep(input: {
  db?: DbClient;
  keepId?: string;
  mediaItemId?: string;
  actorId: string;
}): Promise<{ removed: boolean }> {
  return inTransaction(input.db, async (tx) => {
    let identity: TrashTitleIdentity | null = null;
    if (input.keepId) {
      const [keep] = await tx
        .select()
        .from(trashRestoreKeeps)
        .where(eq(trashRestoreKeeps.id, input.keepId));
      if (keep) identity = { arrKind: keep.arrKind, externalId: keep.externalId };
    } else if (input.mediaItemId) {
      const [item] = await tx.select().from(mediaItems).where(eq(mediaItems.id, input.mediaItemId));
      if (item) identity = trashTitleIdentity(item);
    }
    if (!identity || !(await lockTrashTitle(tx, identity))) return { removed: false };
    const rows = await tx
      .update(trashRestoreKeeps)
      .set({ revokedAt: new Date(), revokedBy: input.actorId })
      .where(
        and(
          eq(trashRestoreKeeps.arrKind, identity.arrKind),
          eq(trashRestoreKeeps.externalId, identity.externalId),
          isNull(trashRestoreKeeps.revokedAt),
        ),
      )
      .returning({ mediaItemId: trashRestoreKeeps.mediaItemId, id: trashRestoreKeeps.id });
    const [linked] = await tx
      .select({ id: mediaItems.id })
      .from(mediaItems)
      .where(
        and(
          eq(mediaItems.arrKind, identity.arrKind),
          identity.arrKind === 'radarr'
            ? eq(mediaItems.tmdbId, identity.externalId)
            : eq(mediaItems.tvdbId, identity.externalId),
        ),
      )
      .limit(1);
    if (rows.length > 0)
      await tx.insert(ledgerEvents).values({
        mediaItemId: linked?.id ?? null,
        eventType: 'trash_excluded',
        source: 'maintainerr',
        occurredAt: new Date(),
        requestedByUserId: input.actorId,
        payload: { action: 'remove_restore_keep', keepId: rows[0]!.id, ...identity },
      });
    return { removed: rows.length > 0 };
  });
}

export async function hasRestoreKeep(
  db: DbClient | undefined,
  mediaItemId: string,
): Promise<boolean> {
  const [item] = await resolveDb(db)
    .select()
    .from(mediaItems)
    .where(eq(mediaItems.id, mediaItemId));
  return hasRestoreKeepForIdentity(db, item ? trashTitleIdentity(item) : null);
}
