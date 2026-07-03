import {
  ledgerEvents,
  mediaItems,
  syncState,
  type ArrKind,
  type DbClient,
  type MediaItemRow,
} from '@hnet/db';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { MassTombstoneAbortedError } from './errors';
import { inTransaction } from './db-client';

/**
 * DESIGN-005 D-14 mass-tombstone guard (Q-03 resolution): abort the tombstone pass
 * when it would tombstone more than this percentage of the instance's live rows …
 */
export const SYNC_TOMBSTONE_GUARD_PCT = 20;
/** … AND more than this many rows. Small libraries shrink legitimately. */
export const SYNC_TOMBSTONE_GUARD_MIN_ROWS = 10;

/** The synced field set of a media_items row (D-05) — everything but bookkeeping. */
export interface MediaItemSyncFields {
  arrItemId: number;
  tvdbId?: number | null;
  tmdbId?: number | null;
  imdbId?: string | null;
  musicbrainzArtistId?: string | null;
  title: string;
  sortTitle: string;
  year?: number | null;
  monitored: boolean;
  qualityProfileId: number;
  qualityProfileName: string;
  metadataProfileId?: number | null;
  metadataProfileName?: string | null;
  rootFolder: string;
  arrTags?: string[];
  onDiskFileCount?: number;
  expectedFileCount?: number;
  sizeOnDisk?: number;
  arrAttrs?: Record<string, unknown>;
}

export interface UpsertMediaItemsBatchInput {
  db?: DbClient;
  arrKind: ArrKind;
  arrInstanceId?: string; // config slug, default 'main' (D-05)
  items: MediaItemSyncFields[];
}

export interface UpsertMediaItemsBatchResult {
  inserted: number;
  updated: number;
  /** Rows matched by external id after the *arr assigned a new internal id (rebuilt-*arr case). */
  rematched: number;
}

/** The external id a kind diffs/restores by (D-05 decision 2, R-50). */
function externalIdOf(kind: ArrKind, item: MediaItemSyncFields): string | null {
  const raw =
    kind === 'sonarr' ? item.tvdbId : kind === 'radarr' ? item.tmdbId : item.musicbrainzArtistId;
  return raw === null || raw === undefined ? null : String(raw);
}

function externalIdOfRow(
  kind: ArrKind,
  row: Pick<MediaItemRow, 'tvdbId' | 'tmdbId' | 'musicbrainzArtistId'>,
): string | null {
  const raw =
    kind === 'sonarr' ? row.tvdbId : kind === 'radarr' ? row.tmdbId : row.musicbrainzArtistId;
  return raw === null || raw === undefined ? null : String(raw);
}

/**
 * DESIGN-005 D-12/D-14 — the single writer for media_items during full sync. Per batch
 * (one transaction): match each incoming item (a) by (arr_kind, arr_instance_id,
 * arr_item_id), (b) else by external id — the rebuilt-*arr case: arr_item_id is
 * updated in place, the tombstone cleared, history kept — (c) else insert. Every
 * matched row gets last_seen_at = now(); sync_state.last_full_sync_at advances in the
 * same transaction.
 */
export async function upsertMediaItemsBatch(
  input: UpsertMediaItemsBatchInput,
): Promise<UpsertMediaItemsBatchResult> {
  const arrInstanceId = input.arrInstanceId ?? 'main';
  return inTransaction(input.db, async (tx) => {
    const existing = await tx
      .select({
        id: mediaItems.id,
        arrItemId: mediaItems.arrItemId,
        tvdbId: mediaItems.tvdbId,
        tmdbId: mediaItems.tmdbId,
        musicbrainzArtistId: mediaItems.musicbrainzArtistId,
      })
      .from(mediaItems)
      .where(
        and(eq(mediaItems.arrKind, input.arrKind), eq(mediaItems.arrInstanceId, arrInstanceId)),
      );

    const byArrItemId = new Map(existing.map((r) => [r.arrItemId, r]));
    const byExternalId = new Map(
      existing.flatMap((r) => {
        const ext = externalIdOfRow(input.arrKind, r);
        return ext === null ? [] : [[ext, r] as const];
      }),
    );

    let inserted = 0;
    let updated = 0;
    let rematched = 0;
    const toInsert: (typeof mediaItems.$inferInsert)[] = [];

    for (const item of input.items) {
      const syncedFields = {
        arrItemId: item.arrItemId,
        tvdbId: item.tvdbId ?? null,
        tmdbId: item.tmdbId ?? null,
        imdbId: item.imdbId ?? null,
        musicbrainzArtistId: item.musicbrainzArtistId ?? null,
        title: item.title,
        sortTitle: item.sortTitle,
        year: item.year ?? null,
        monitored: item.monitored,
        qualityProfileId: item.qualityProfileId,
        qualityProfileName: item.qualityProfileName,
        metadataProfileId: item.metadataProfileId ?? null,
        metadataProfileName: item.metadataProfileName ?? null,
        rootFolder: item.rootFolder,
        arrTags: item.arrTags ?? [],
        onDiskFileCount: item.onDiskFileCount ?? 0,
        expectedFileCount: item.expectedFileCount ?? 0,
        sizeOnDisk: item.sizeOnDisk ?? 0,
        arrAttrs: item.arrAttrs ?? {},
      };

      const ext = externalIdOf(input.arrKind, item);
      const byId = byArrItemId.get(item.arrItemId);
      const match = byId ?? (ext === null ? undefined : byExternalId.get(ext));

      if (match) {
        if (byId) {
          updated += 1;
        } else {
          rematched += 1; // new internal id, same external identity (D-14 step 3b)
        }
        await tx
          .update(mediaItems)
          .set({
            ...syncedFields,
            lastSeenAt: sql`now()`,
            deletedFromArrAt: null, // seen in the live list ⇒ live (un-tombstone)
            updatedAt: sql`now()`,
          })
          .where(eq(mediaItems.id, match.id));
      } else {
        inserted += 1;
        toInsert.push({ ...syncedFields, arrKind: input.arrKind, arrInstanceId });
      }
    }

    if (toInsert.length > 0) {
      await tx.insert(mediaItems).values(toInsert);
    }

    // D-12: last_full_sync_at advances with each committed batch of the full sync.
    await tx
      .insert(syncState)
      .values({ source: input.arrKind, lastFullSyncAt: sql`now()` })
      .onConflictDoUpdate({
        target: syncState.source,
        set: { lastFullSyncAt: sql`now()`, updatedAt: sql`now()` },
      });

    return { inserted, updated, rematched };
  });
}

export interface TombstoneMissingItemsInput {
  db?: DbClient;
  arrKind: ArrKind;
  arrInstanceId?: string;
  /** Every arr_item_id present in the live *arr list this full sync (post-upsert ids). */
  seenArrItemIds: number[];
  /** --force-tombstones: skip the mass-tombstone guard after an admin confirmed reality. */
  force?: boolean;
}

export interface TombstoneMissingItemsResult {
  tombstoned: number;
  liveCount: number;
}

/**
 * DESIGN-005 D-12/D-14 — the tombstone pass (single writer, one transaction): live
 * rows of the instance not seen in the full sync get deleted_from_arr_at = now() plus
 * a 'deleted' ledger event with payload.kind = 'item_removed' (item-level removals are
 * not *arr history events — D-07). Enforces the mass-tombstone guard: > 20% of live
 * rows AND > 10 rows ⇒ MassTombstoneAbortedError, nothing written, unless `force`.
 */
export async function tombstoneMissingItems(
  input: TombstoneMissingItemsInput,
): Promise<TombstoneMissingItemsResult> {
  const arrInstanceId = input.arrInstanceId ?? 'main';
  return inTransaction(input.db, async (tx) => {
    const live = await tx
      .select({
        id: mediaItems.id,
        arrItemId: mediaItems.arrItemId,
        title: mediaItems.title,
        tvdbId: mediaItems.tvdbId,
        tmdbId: mediaItems.tmdbId,
        musicbrainzArtistId: mediaItems.musicbrainzArtistId,
      })
      .from(mediaItems)
      .where(
        and(
          eq(mediaItems.arrKind, input.arrKind),
          eq(mediaItems.arrInstanceId, arrInstanceId),
          isNull(mediaItems.deletedFromArrAt),
        ),
      );

    const seen = new Set(input.seenArrItemIds);
    const missing = live.filter((row) => !seen.has(row.arrItemId));
    if (missing.length === 0) {
      return { tombstoned: 0, liveCount: live.length };
    }

    const overPct = missing.length * 100 > live.length * SYNC_TOMBSTONE_GUARD_PCT;
    if (!input.force && missing.length > SYNC_TOMBSTONE_GUARD_MIN_ROWS && overPct) {
      throw new MassTombstoneAbortedError(
        `Tombstone pass for ${input.arrKind}/${arrInstanceId} would tombstone ` +
          `${missing.length} of ${live.length} live rows (> ${SYNC_TOMBSTONE_GUARD_PCT}% ` +
          `and > ${SYNC_TOMBSTONE_GUARD_MIN_ROWS} rows) — a wiped/fresh *arr looks exactly ` +
          `like a mass deletion. Re-run with --force-tombstones after confirming reality.`,
        { wouldTombstone: missing.length, liveCount: live.length },
      );
    }

    const now = new Date();
    for (const row of missing) {
      await tx
        .update(mediaItems)
        .set({ deletedFromArrAt: sql`now()`, updatedAt: sql`now()` })
        .where(eq(mediaItems.id, row.id));
    }
    await tx.insert(ledgerEvents).values(
      missing.map((row) => ({
        mediaItemId: row.id,
        eventType: 'deleted' as const,
        source: input.arrKind,
        sourceEventId: null,
        occurredAt: now,
        payload: {
          kind: 'item_removed', // vs 'file_deleted' for history-sourced deletions (D-07)
          title: row.title,
          arrItemId: row.arrItemId,
          tvdbId: row.tvdbId,
          tmdbId: row.tmdbId,
          musicbrainzArtistId: row.musicbrainzArtistId,
        },
      })),
    );

    return { tombstoned: missing.length, liveCount: live.length };
  });
}
