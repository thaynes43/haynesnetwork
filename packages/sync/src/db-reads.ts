// Read-only DB lookups the runner needs between the @hnet/domain single-writers.
// Nothing here mutates state — all writes go through packages/domain (D-12 guard).
import {
  mediaItems,
  mediaMetadata,
  syncState,
  users,
  type ArrKind,
  type DbClient,
  type SyncSource,
} from '@hnet/db';
import { and, eq, inArray, isNull, lt, or, sql } from 'drizzle-orm';

/** A Media Item the metadata harvest must (re)fetch (ADR-018 / DESIGN-008 D-03). */
export interface MetadataTarget {
  id: string;
  arrKind: ArrKind;
  arrInstanceId: string;
  arrItemId: number;
  tvdbId: number | null;
  tmdbId: number | null;
  imdbId: string | null;
  musicbrainzArtistId: string | null;
  arrTags: string[];
  tombstoned: boolean;
}

/**
 * DESIGN-008 D-03 — the refresh scan: rows whose metadata is MISSING (no media_metadata row)
 * OR STALE (fetched_at older than the threshold). Ordered oldest-first so a capped run makes
 * steady progress across the estate. Read-only (LEFT JOIN media_metadata).
 */
export async function selectMetadataTargets(
  db: DbClient,
  opts: { staleBefore: Date; arrKind?: ArrKind; arrInstanceId?: string; limit?: number },
): Promise<MetadataTarget[]> {
  const staleness = or(
    isNull(mediaMetadata.fetchedAt),
    lt(mediaMetadata.fetchedAt, opts.staleBefore),
  );
  const where = [staleness];
  if (opts.arrKind) where.push(eq(mediaItems.arrKind, opts.arrKind));
  if (opts.arrInstanceId) where.push(eq(mediaItems.arrInstanceId, opts.arrInstanceId));
  const rows = await db
    .select({
      id: mediaItems.id,
      arrKind: mediaItems.arrKind,
      arrInstanceId: mediaItems.arrInstanceId,
      arrItemId: mediaItems.arrItemId,
      tvdbId: mediaItems.tvdbId,
      tmdbId: mediaItems.tmdbId,
      imdbId: mediaItems.imdbId,
      musicbrainzArtistId: mediaItems.musicbrainzArtistId,
      arrTags: mediaItems.arrTags,
      deletedFromArrAt: mediaItems.deletedFromArrAt,
      fetchedAt: mediaMetadata.fetchedAt,
    })
    .from(mediaItems)
    .leftJoin(mediaMetadata, eq(mediaMetadata.mediaItemId, mediaItems.id))
    .where(and(...where))
    .orderBy(sql`${mediaMetadata.fetchedAt} asc nulls first`)
    .limit(opts.limit ?? 100000);

  return rows.map((r) => ({
    id: r.id,
    arrKind: r.arrKind,
    arrInstanceId: r.arrInstanceId,
    arrItemId: r.arrItemId,
    tvdbId: r.tvdbId,
    tmdbId: r.tmdbId,
    imdbId: r.imdbId,
    musicbrainzArtistId: r.musicbrainzArtistId,
    arrTags: r.arrTags,
    tombstoned: r.deletedFromArrAt !== null,
  }));
}

/** The source's history cursor (max ingested history date / Seerr createdAt), if any. */
export async function readHistoryCursor(db: DbClient, source: SyncSource): Promise<Date | null> {
  const [row] = await db
    .select({ historyCursor: syncState.historyCursor })
    .from(syncState)
    .where(eq(syncState.source, source));
  return row?.historyCursor ?? null;
}

/**
 * Resolve *arr item ids → media_items.id for one instance (D-14 incremental:
 * `seriesId`/`movieId`/`artistId` → `(arr_kind, arr_item_id)`). Tombstoned rows are
 * included — history can still reference an item that has since left the *arr.
 */
export async function mediaItemIdsByArrItemId(
  db: DbClient,
  arrKind: ArrKind,
  arrInstanceId: string,
  arrItemIds: number[],
): Promise<Map<number, string>> {
  if (arrItemIds.length === 0) return new Map();
  const rows = await db
    .select({ id: mediaItems.id, arrItemId: mediaItems.arrItemId })
    .from(mediaItems)
    .where(
      and(
        eq(mediaItems.arrKind, arrKind),
        eq(mediaItems.arrInstanceId, arrInstanceId),
        inArray(mediaItems.arrItemId, [...new Set(arrItemIds)]),
      ),
    );
  return new Map(rows.map((r) => [r.arrItemId, r.id]));
}

/** D-14 Seerr request → item match: movie → radarr by tmdb; tv → sonarr by tvdb, fallback tmdb. */
export async function resolveSeerrMediaItemId(
  db: DbClient,
  request: { type: 'movie' | 'tv'; tmdbId: number | null; tvdbId: number | null },
): Promise<string | null> {
  const lookup = async (kind: ArrKind, column: 'tmdbId' | 'tvdbId', value: number) => {
    const col = column === 'tmdbId' ? mediaItems.tmdbId : mediaItems.tvdbId;
    const [row] = await db
      .select({ id: mediaItems.id })
      .from(mediaItems)
      .where(and(eq(mediaItems.arrKind, kind), sql`${col} = ${value}`))
      .limit(1);
    return row?.id ?? null;
  };
  if (request.type === 'movie') {
    return request.tmdbId === null ? null : lookup('radarr', 'tmdbId', request.tmdbId);
  }
  if (request.tvdbId !== null) {
    const byTvdb = await lookup('sonarr', 'tvdbId', request.tvdbId);
    if (byTvdb !== null) return byTvdb;
  }
  return request.tmdbId === null ? null : lookup('sonarr', 'tmdbId', request.tmdbId);
}

/**
 * D-14 / Q-01 attribution: case-insensitive email auto-link only (plexUsername stays a
 * payload suggestion, never auto-linked). Null when no app user matches.
 */
export async function resolveUserIdByEmail(
  db: DbClient,
  email: string | null | undefined,
): Promise<string | null> {
  if (!email) return null;
  const [row] = await db
    .select({ id: users.id })
    .from(users)
    .where(sql`lower(${users.email}) = lower(${email})`)
    .limit(1);
  return row?.id ?? null;
}
