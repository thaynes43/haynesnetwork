// DESIGN-049 D-09 step 4 / D-14 — what the *arr ledger knows about a title: its genres (the Taste Profile
// reads ledger genres first, D-16) and, for shows, whether Sonarr says it ended (D-07 `show_status`).
// SELECT only.
import { mediaItems, mediaMetadata, type DbClient, type WatchShowStatus } from '@hnet/db';
import { and, eq, inArray, isNull } from 'drizzle-orm';

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
