// ADR-019 / DESIGN-008 — the poster PROXY resolution (server-side; no image storage). Given a
// Media Item id, resolve where its poster streams from — the owning *arr's pre-resized MediaCover
// variant (with the API key in a header, never exposed to the browser) or the TMDB CDN — plus a
// cheap ETag. The Next route handler (apps/web) does the session check + streaming; this keeps the
// DB + *arr-config coupling inside @hnet/api (which has both deps), so the app route stays thin.
import { createHash } from 'node:crypto';
import { eq } from 'drizzle-orm';
import {
  db as defaultDb,
  mediaItems,
  mediaMetadata,
  type Database,
  type PosterSource,
} from '@hnet/db';
import { assertArrEnv, resolveTmdbConfig, type ArrServiceName } from '@hnet/arr';
import { TmdbClient } from '@hnet/arr/read';

export interface PosterUpstream {
  /** Which tier this upstream streams from (the route only falls back when the primary was 'arr'). */
  source: PosterSource;
  url: string;
  headers: Record<string, string>;
  /** Revalidation key from the poster reference (the *arr url carries ?lastWrite; tmdb is stable). */
  etag: string;
}

/** Stable ETag for a poster reference — matches across the primary and the TMDB fallback so a
 *  browser cache stays valid once the metadata refresh heals a tombstoned row to a tmdb source. */
function posterEtag(source: PosterSource, ref: string): string {
  return `"${createHash('sha1').update(`${source}:${ref}`).digest('base64url')}"`;
}

/** The TMDB CDN upstream for a `poster_path` (`/abc.jpg` → the w342 variant). */
function tmdbUpstream(posterPath: string): PosterUpstream {
  return {
    source: 'tmdb',
    url: `https://image.tmdb.org/t/p/w342${posterPath}`,
    headers: { Accept: 'image/*' },
    etag: posterEtag('tmdb', posterPath),
  };
}

/** The MediaCover variant path per *arr (verified live 2026-07-06). */
function arrMediaCoverPath(kind: ArrServiceName, arrItemId: number): string {
  if (kind === 'lidarr') return `/api/v1/mediacover/artist/${arrItemId}/poster-250.jpg`;
  return `/api/v3/mediacover/${arrItemId}/poster-250.jpg`; // radarr + sonarr
}

/**
 * Resolve the upstream a Media Item's poster streams from, or null when there is none (→ the UI
 * shows the KindIcon fallback). Never throws for a misconfigured *arr env — returns null.
 */
export async function resolvePosterUpstream(
  mediaItemId: string,
  database: Database = defaultDb,
): Promise<PosterUpstream | null> {
  if (!/^[0-9a-f-]{36}$/i.test(mediaItemId)) return null;
  const [row] = await database
    .select({
      arrKind: mediaItems.arrKind,
      arrItemId: mediaItems.arrItemId,
      posterSource: mediaMetadata.posterSource,
      posterRef: mediaMetadata.posterRef,
    })
    .from(mediaItems)
    .leftJoin(mediaMetadata, eq(mediaMetadata.mediaItemId, mediaItems.id))
    .where(eq(mediaItems.id, mediaItemId));

  if (!row || row.posterSource === null) return null;

  const etag = posterEtag(row.posterSource, row.posterRef ?? '');

  if (row.posterSource === 'arr') {
    try {
      const kind = row.arrKind as ArrServiceName;
      const cfg = assertArrEnv()[kind];
      return {
        source: 'arr',
        url: `${cfg.baseUrl.replace(/\/+$/, '')}${arrMediaCoverPath(kind, row.arrItemId)}`,
        headers: { 'X-Api-Key': cfg.apiKey, Accept: 'image/*' },
        etag,
      };
    } catch {
      return null; // *arr env not configured
    }
  }
  // tmdb: poster_ref is a poster_path like /abc.jpg → the w342 CDN variant.
  const ref = row.posterRef ?? '';
  if (!ref.startsWith('/')) return null;
  return { source: 'tmdb', url: `https://image.tmdb.org/t/p/w342${ref}`, headers: { Accept: 'image/*' }, etag };
}

/** Injectable deps for the TMDB fallback resolver (tests stub env + fetch; prod uses defaults). */
export interface TmdbFallbackDeps {
  database?: Database;
  env?: Record<string, string | undefined>;
  fetchImpl?: typeof fetch;
}

/**
 * ADR-019 fallback — resolve the TMDB poster for a Media Item whose PRIMARY (owning *arr)
 * MediaCover upstream just 404'd. This happens when the item was removed from the *arr (e.g. a
 * Trash expedite / "Recently Deleted") so its MediaCover no longer exists, but the ledger's
 * poster_source is still 'arr' (the row may not even be tombstoned yet, and the 6-hourly
 * metadata refresh that heals it to a tmdb source hasn't run — DESIGN-008 D-05). Reuses plan-004's
 * TMDB client/key: fetch the poster_path by the item's tmdb id (radarr) / tvdb id (sonarr).
 *
 * Returns null (→ the caller keeps the KindIcon placeholder — current behavior) when there is no
 * TMDB poster to serve: a music (lidarr) row with no tmdb id, an item with no external id, TMDB
 * unconfigured, or TMDB has no poster / is unreachable.
 */
export async function resolveTmdbPosterFallback(
  mediaItemId: string,
  deps: TmdbFallbackDeps = {},
): Promise<PosterUpstream | null> {
  if (!/^[0-9a-f-]{36}$/i.test(mediaItemId)) return null;
  const database = deps.database ?? defaultDb;
  const [row] = await database
    .select({
      arrKind: mediaItems.arrKind,
      tmdbId: mediaItems.tmdbId,
      tvdbId: mediaItems.tvdbId,
    })
    .from(mediaItems)
    .where(eq(mediaItems.id, mediaItemId));
  if (!row) return null;

  const cfg = resolveTmdbConfig(deps.env);
  if (!cfg) return null; // TMDB not configured → keep the placeholder (music-only estates, dev)
  const tmdb = new TmdbClient({ ...cfg, ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}) });

  try {
    if (row.arrKind === 'radarr' && row.tmdbId !== null) {
      const path = (await tmdb.getMovie(row.tmdbId)).poster_path;
      return path ? tmdbUpstream(path) : null;
    }
    if (row.arrKind === 'sonarr') {
      let tmdbId = row.tmdbId;
      if (tmdbId === null && row.tvdbId !== null) {
        tmdbId = (await tmdb.findByTvdb(row.tvdbId)).tv_results?.[0]?.id ?? null;
      }
      if (tmdbId !== null) {
        const path = (await tmdb.getTv(tmdbId)).poster_path;
        return path ? tmdbUpstream(path) : null;
      }
    }
  } catch {
    return null; // TMDB 404 / unreachable — keep the placeholder
  }
  return null; // lidarr (music, no tmdb) or no external id → placeholder as today
}
