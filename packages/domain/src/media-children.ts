// DESIGN-005 D-06 — fix targets resolve LIVE, never from a synced child table:
// sonarr episodes / lidarr albums are one GET away and always fresher than a mirror.
// Serves ledger.children (D-17) and the fix flow's target validation + label (D-15).
import { mediaItems } from '@hnet/db';
import type { DbClient } from '@hnet/db';
import { eq } from 'drizzle-orm';
import { ArrError } from '@hnet/arr';
import { ArrUpstreamError, NotFoundError } from './errors';
import { resolveDb } from './db-client';
import type { ArrClientBundle } from './arr-clients';

export interface MediaChildTarget {
  /** Episode id (sonarr) / album id (lidarr) — the fix_requests.target_arr_child_id. */
  arrChildId: number;
  /** Display-durable label, e.g. 'S06E02 · Rich' / album title (D-09). */
  label: string;
  hasFile: boolean;
  monitored: boolean;
  /**
   * Sonarr only: the episode's season number — groups the detail list into collapsible
   * season sections and scopes a season roll-up Force Search / Fix (hierarchy-actions).
   * null for lidarr albums / radarr.
   */
  seasonNumber: number | null;
  /**
   * PLAN-030 (ADR-048): Sonarr only — the episode's number WITHIN its season. Correlates an *arr
   * episode row with its Plex episode thumb by `(seasonNumber, episodeNumber)` (the still from the
   * *arr→Plex match, DESIGN-005 D-22). null for lidarr albums / radarr.
   */
  episodeNumber: number | null;
  /** Sonarr only: the episode's file id — the AC-08 fallback's delete target. */
  episodeFileId: number | null;
}

const pad2 = (n: number) => String(n).padStart(2, '0');

/** 'S06E02 · Rich' (D-09's label example). */
export function episodeLabel(seasonNumber: number, episodeNumber: number, title: string): string {
  const code = `S${pad2(seasonNumber)}E${pad2(episodeNumber)}`;
  return title ? `${code} · ${title}` : code;
}

/** Re-throw *arr client failures as the D-17 upstream error (BAD_GATEWAY appCode). */
export async function guardArrCall<T>(what: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof ArrError) {
      throw new ArrUpstreamError(`${what} failed: ${err.message}`, { cause: err });
    }
    throw err;
  }
}

/**
 * Live child list for a ledger item (D-06/D-17 `ledger.children`): sonarr episodes
 * (season/episode ordered), lidarr albums (release-date ordered, newest last), and
 * `[]` for radarr — the movie itself is the fix target (ADR-007).
 */
export async function listMediaChildren(input: {
  db?: DbClient;
  arr: Pick<ArrClientBundle, 'read'>;
  mediaItemId: string;
}): Promise<MediaChildTarget[]> {
  const db = resolveDb(input.db);
  const [item] = await db
    .select({
      id: mediaItems.id,
      arrKind: mediaItems.arrKind,
      arrItemId: mediaItems.arrItemId,
      deletedFromArrAt: mediaItems.deletedFromArrAt,
    })
    .from(mediaItems)
    .where(eq(mediaItems.id, input.mediaItemId));
  if (!item) throw new NotFoundError(`Media item ${input.mediaItemId} not found`);
  // A tombstoned item has no live children to fetch — nothing to pick, nothing to fix.
  if (item.deletedFromArrAt !== null) return [];

  if (item.arrKind === 'sonarr') {
    const episodes = await guardArrCall(`sonarr GET /episode?seriesId=${item.arrItemId}`, () =>
      input.arr.read.sonarr.listEpisodes(item.arrItemId),
    );
    return episodes
      .slice()
      .sort((a, b) => a.seasonNumber - b.seasonNumber || a.episodeNumber - b.episodeNumber)
      .map((ep) => ({
        arrChildId: ep.id,
        label: episodeLabel(ep.seasonNumber, ep.episodeNumber, ep.title),
        hasFile: ep.hasFile,
        monitored: ep.monitored,
        seasonNumber: ep.seasonNumber,
        episodeNumber: ep.episodeNumber,
        episodeFileId: ep.episodeFileId ?? null,
      }));
  }

  if (item.arrKind === 'lidarr') {
    const albums = await guardArrCall(`lidarr GET /album?artistId=${item.arrItemId}`, () =>
      input.arr.read.lidarr.listAlbums(item.arrItemId),
    );
    return albums
      .slice()
      .sort((a, b) => (a.releaseDate ?? '').localeCompare(b.releaseDate ?? ''))
      .map((album) => ({
        arrChildId: album.id,
        label: album.title,
        hasFile: (album.statistics?.trackFileCount ?? 0) > 0,
        monitored: album.monitored,
        seasonNumber: null,
        episodeNumber: null,
        episodeFileId: null,
      }));
  }

  return []; // radarr — the movie is the target (D-06)
}

// ---------------------------------------------------------------------------
// ADR-061 / DESIGN-032 D-02 (PLAN-038) — the music TRACK leaf (album → track drill).
// ---------------------------------------------------------------------------

export interface AlbumTrackTarget {
  /** Lidarr track id — the ticket locator's target_child_id for kind 'track'. */
  trackId: number;
  /** Display-durable label, e.g. '05 · Song Title' (the episodeLabel idiom). */
  label: string;
  trackNumber: number | null;
  hasFile: boolean;
}

/**
 * List a lidarr album's tracks LIVE (the compose drill's music leaf — owner ruling Q-02:
 * track-level ticketing). Validates the media item is a live lidarr artist; the caller gates
 * access (ADR-047, the ledger.children discipline). Tombstoned ⇒ [].
 */
export async function listAlbumTracks(input: {
  db?: DbClient;
  arr: Pick<ArrClientBundle, 'read'>;
  mediaItemId: string;
  albumId: number;
}): Promise<AlbumTrackTarget[]> {
  const db = resolveDb(input.db);
  const [item] = await db
    .select({
      id: mediaItems.id,
      arrKind: mediaItems.arrKind,
      deletedFromArrAt: mediaItems.deletedFromArrAt,
    })
    .from(mediaItems)
    .where(eq(mediaItems.id, input.mediaItemId));
  if (!item) throw new NotFoundError(`Media item ${input.mediaItemId} not found`);
  if (item.arrKind !== 'lidarr') throw new NotFoundError(`Media item ${input.mediaItemId} has no albums`);
  if (item.deletedFromArrAt !== null) return [];

  const tracks = await guardArrCall(`lidarr GET /track?albumId=${input.albumId}`, () =>
    input.arr.read.lidarr.listTracks(input.albumId),
  );
  return tracks
    .slice()
    .map((t) => {
      const n =
        typeof t.trackNumber === 'number'
          ? t.trackNumber
          : t.trackNumber != null && /^\d+$/.test(t.trackNumber)
            ? Number(t.trackNumber)
            : (t.absoluteTrackNumber ?? null);
      const title = t.title ?? '';
      return {
        trackId: t.id,
        label: n !== null ? `${pad2(n)} · ${title}`.trim() : title || `Track ${t.id}`,
        trackNumber: n,
        hasFile: t.hasFile ?? false,
      };
    })
    .sort((a, b) => (a.trackNumber ?? 9999) - (b.trackNumber ?? 9999));
}
