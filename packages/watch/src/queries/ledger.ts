// DESIGN-049 D-09 step 4 / D-14 — what the *arr ledger knows about a title: its genres (the Taste Profile
// reads ledger genres first, D-16) and, for shows, whether Sonarr says it ended (D-07 `show_status`).
// SELECT only.
import { mediaItems, mediaMetadata, mediaPlexMatches, type DbClient, type WatchShowStatus } from '@hnet/db';
import { and, eq, inArray, isNull, or, sql, type SQL } from 'drizzle-orm';
import type { TitleIds, WatchKind } from '../types';

export interface LedgerFacts {
  mediaItemId: string;
  genres: string[];
  showStatus: WatchShowStatus | null;
}

/** Sonarr's `ended` / `status` → the D-07 `show_status` (`upcoming` counts as continuing). */
export function showStatusOf(attrs: Record<string, unknown> | null | undefined): WatchShowStatus | null {
  if (!attrs) return null;
  if (attrs.ended === true) return 'ended';
  const status = typeof attrs.status === 'string' ? attrs.status.toLowerCase() : '';
  if (status === 'ended') return 'ended';
  if (status === 'continuing' || status === 'upcoming') return 'continuing';
  return null;
}

export async function selectLedgerFacts(
  db: DbClient,
  mediaItemIds: readonly string[],
): Promise<LedgerFacts[]> {
  if (mediaItemIds.length === 0) return [];
  const rows = await db
    .select({
      mediaItemId: mediaItems.id,
      arrKind: mediaItems.arrKind,
      arrAttrs: mediaItems.arrAttrs,
      genres: mediaMetadata.genres,
    })
    .from(mediaItems)
    .leftJoin(mediaMetadata, eq(mediaMetadata.mediaItemId, mediaItems.id))
    .where(inArray(mediaItems.id, [...mediaItemIds]));
  return rows.map((r) => ({
    mediaItemId: r.mediaItemId,
    genres: r.genres ?? [],
    showStatus: r.arrKind === 'sonarr' ? showStatusOf(r.arrAttrs) : null,
  }));
}

/** A live Sonarr/Radarr ledger item as the `watch` sync links it (D-09 step 4). */
export interface LedgerIndexItem {
  mediaItemId: string;
  kind: 'show' | 'movie';
  title: string;
  year: number | null;
  tvdbId: number | null;
  tmdbId: number | null;
  imdbId: string | null;
  genres: string[];
  showStatus: WatchShowStatus | null;
}

/** Every live (not tombstoned) Sonarr show and Radarr movie with its genres and status. */
export async function selectLedgerIndex(db: DbClient): Promise<LedgerIndexItem[]> {
  const rows = await db
    .select({
      mediaItemId: mediaItems.id,
      arrKind: mediaItems.arrKind,
      title: mediaItems.title,
      year: mediaItems.year,
      tvdbId: mediaItems.tvdbId,
      tmdbId: mediaItems.tmdbId,
      imdbId: mediaItems.imdbId,
      arrAttrs: mediaItems.arrAttrs,
      genres: mediaMetadata.genres,
    })
    .from(mediaItems)
    .leftJoin(mediaMetadata, eq(mediaMetadata.mediaItemId, mediaItems.id))
    .where(and(inArray(mediaItems.arrKind, ['sonarr', 'radarr']), isNull(mediaItems.deletedFromArrAt)));
  return rows.map((r) => ({
    mediaItemId: r.mediaItemId,
    kind: r.arrKind === 'sonarr' ? 'show' : 'movie',
    title: r.title,
    year: r.year,
    tvdbId: r.arrKind === 'sonarr' ? r.tvdbId : null,
    tmdbId: r.tmdbId,
    imdbId: r.imdbId,
    genres: r.genres ?? [],
    showStatus: r.arrKind === 'sonarr' ? showStatusOf(r.arrAttrs) : null,
  }));
}

/** A ledger item's candidate fields (DESIGN-049 D-17): ids, genres, ratings and whether it is on Plex. */
export interface LedgerCandidate {
  id: string;
  arrKind: 'sonarr' | 'radarr' | 'lidarr';
  title: string;
  year: number | null;
  tvdbId: number | null;
  tmdbId: number | null;
  imdbId: string | null;
  genres: string[] | null;
  imdbRating: string | null;
  tmdbRating: string | null;
  rtTomatometer: number | null;
  /** A `media_plex_matches` row exists: the D-17 "on Plex". */
  onPlex: boolean;
  addedToPlex: Date | string | null;
}

export function ledgerSelect() {
  return {
    id: mediaItems.id,
    arrKind: mediaItems.arrKind,
    title: mediaItems.title,
    year: mediaItems.year,
    tvdbId: mediaItems.tvdbId,
    tmdbId: mediaItems.tmdbId,
    imdbId: mediaItems.imdbId,
    genres: mediaMetadata.genres,
    imdbRating: mediaMetadata.imdbRating,
    tmdbRating: mediaMetadata.tmdbRating,
    rtTomatometer: mediaMetadata.rtTomatometer,
    onPlex: sql<boolean>`EXISTS (SELECT 1 FROM ${mediaPlexMatches} WHERE ${mediaPlexMatches.mediaItemId} = ${mediaItems.id})`,
    addedToPlex: sql<Date | string | null>`(SELECT min(${mediaPlexMatches.firstSeenAt}) FROM ${mediaPlexMatches} WHERE ${mediaPlexMatches.mediaItemId} = ${mediaItems.id})`,
  };
}

export function kindOfArr(arrKind: string): WatchKind {
  return arrKind === 'sonarr' ? 'show' : 'movie';
}

type LedgerIds = Pick<TitleIds, 'kind' | 'tmdbId' | 'tvdbId' | 'imdbId'>;

/**
 * Live Sonarr / Radarr items that share a TMDB, TVDB or IMDb id with any of `titles` (the watchlist and seed
 * candidates of D-17, and the D-02 "on Plex" rule of DESIGN-051); `ledgerMatchesTitle` pairs them up.
 */
export async function selectLedgerByIds(db: DbClient, titles: readonly LedgerIds[]): Promise<LedgerCandidate[]> {
  const tmdb = [...new Set(titles.flatMap((s) => (s.tmdbId ? [s.tmdbId] : [])))];
  const tvdb = [...new Set(titles.flatMap((s) => (s.kind === 'show' && s.tvdbId ? [s.tvdbId] : [])))];
  const imdb = [...new Set(titles.flatMap((s) => (s.imdbId ? [s.imdbId] : [])))];
  const match: SQL[] = [];
  if (tmdb.length > 0) match.push(inArray(mediaItems.tmdbId, tmdb));
  if (tvdb.length > 0) match.push(inArray(mediaItems.tvdbId, tvdb));
  if (imdb.length > 0) match.push(inArray(mediaItems.imdbId, imdb));
  if (match.length === 0) return [];
  return db
    .select(ledgerSelect())
    .from(mediaItems)
    .leftJoin(mediaMetadata, eq(mediaMetadata.mediaItemId, mediaItems.id))
    .where(
      and(
        inArray(mediaItems.arrKind, ['sonarr', 'radarr']),
        isNull(mediaItems.deletedFromArrAt),
        or(...match),
      ),
    );
}

/** The ledger item IS the title: the same kind and a shared TMDB, TVDB (shows) or IMDb id. */
export function ledgerMatchesTitle(t: LedgerIds, m: Pick<LedgerCandidate, 'arrKind' | 'tmdbId' | 'tvdbId' | 'imdbId'>): boolean {
  if (kindOfArr(m.arrKind) !== t.kind) return false;
  return (
    (t.tmdbId != null && t.tmdbId === m.tmdbId) ||
    (t.kind === 'show' && t.tvdbId != null && t.tvdbId === m.tvdbId) ||
    (t.imdbId != null && t.imdbId === m.imdbId)
  );
}
