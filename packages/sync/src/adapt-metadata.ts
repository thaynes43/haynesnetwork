// ADR-018 / DESIGN-008 D-02/D-05 — pure adapters from the @hnet/arr metadata shapes (and the
// TMDB/TVDB fallback shapes) to the media_metadata field set the @hnet/domain single-writer
// (upsertMediaMetadataBatch) consumes. Framework-free for cheap fixture-driven unit tests
// (ADR-010), mirroring adapt.ts.
import type {
  ArrImage,
  LidarrArtist,
  LidarrLookup,
  RadarrLookup,
  RadarrMovie,
  SonarrLookup,
  SonarrSeries,
  TautulliMetadata,
  TmdbMovie,
  TmdbTv,
  TvdbSeries,
} from '@hnet/arr';
import type { PosterSource, Resolution } from '@hnet/db';
import type { MediaMetadataFields } from '@hnet/domain';

/** The metadata slice a tier contributes (mediaItemId is stitched on by the harvest). */
export type MetadataPatch = Omit<MediaMetadataFields, 'mediaItemId'>;

const round = (v: number | null | undefined): number | null =>
  v === null || v === undefined ? null : Math.round(v);

/**
 * DESIGN-008 D-02 — derive the resolution tier from the *arr's target QUALITY PROFILE name
 * (approximate: it reflects the profile, not the exact on-disk file — a per-item file fetch
 * across ~17.7k items is too costly for a 6-hourly refresh). A profile that pins exactly ONE
 * resolution tier maps to it; range/any profiles ("Any", "HD - 720p/1080p", "FHD-UHD") are
 * ambiguous → 'unknown'.
 */
export function resolutionFromProfile(name: string | null | undefined): Resolution {
  if (!name) return 'unknown';
  const n = name.toLowerCase();
  const hits: Resolution[] = [];
  if (/2160|ultra|\buhd\b|\b4k\b/.test(n)) hits.push('2160p');
  if (/1080|\bfhd\b/.test(n)) hits.push('1080p');
  if (/720/.test(n)) hits.push('720p');
  if (/576/.test(n)) hits.push('576p');
  if (/480/.test(n)) hits.push('480p');
  if (hits.length === 1) return hits[0]!;
  if (hits.length === 0 && /\bsd\b/.test(n)) return 'sd';
  return 'unknown';
}

/** Pick the poster image and record the *arr proxy reference (posterSource='arr', posterRef =
 *  the relative MediaCover url which carries ?lastWrite → the ETag input). Null ⇒ no poster. */
export function posterFromArrImages(
  images: ArrImage[] | undefined,
): { posterSource: PosterSource; posterRef: string } | null {
  const poster = images?.find((i) => i.coverType === 'poster');
  const ref = poster?.url;
  return ref ? { posterSource: 'arr', posterRef: ref } : null;
}

/** Extract a TMDB poster_path from an *arr remote poster URL (`…/t/p/original/PATH.jpg`). */
export function tmdbPathFromRemote(remote: string | null | undefined): string | null {
  if (!remote) return null;
  const m = /\/t\/p\/[^/]+(\/[^?]+)/.exec(remote);
  if (m) return m[1]!;
  return remote.startsWith('/') ? remote : null;
}

function arrAddedAt(added: string | null | undefined): Date | null {
  if (!added) return null;
  const d = new Date(added);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** Radarr movie (live list, arr tier) → metadata patch. */
export function metadataFromRadarrMovie(movie: RadarrMovie): MetadataPatch {
  const r = movie.ratings;
  const poster = posterFromArrImages(movie.images);
  return {
    imdbRating: r?.imdb?.value ?? null,
    imdbVotes: r?.imdb?.votes ?? null,
    tmdbRating: r?.tmdb?.value ?? null,
    tmdbVotes: r?.tmdb?.votes ?? null,
    rtTomatometer: round(r?.rottenTomatoes?.value),
    runtimeMinutes: movie.runtime ?? null,
    genres: movie.genres ?? [],
    arrAddedAt: arrAddedAt(movie.added),
    ...(poster ?? {}),
  };
}

/** Sonarr series → metadata patch (single community rating → tmdb slot, D-02). */
export function metadataFromSonarrSeries(series: SonarrSeries): MetadataPatch {
  const poster = posterFromArrImages(series.images);
  return {
    tmdbRating: series.ratings?.value ?? null,
    tmdbVotes: series.ratings?.votes ?? null,
    runtimeMinutes: series.runtime ?? null,
    genres: series.genres ?? [],
    arrAddedAt: arrAddedAt(series.added),
    ...(poster ?? {}),
  };
}

/** Lidarr artist → metadata patch (no runtime for artists). */
export function metadataFromLidarrArtist(artist: LidarrArtist): MetadataPatch {
  const poster = posterFromArrImages(artist.images);
  return {
    tmdbRating: artist.ratings?.value ?? null,
    tmdbVotes: artist.ratings?.votes ?? null,
    genres: artist.genres ?? [],
    arrAddedAt: arrAddedAt(artist.added),
    ...(poster ?? {}),
  };
}

/** Radarr /lookup (tombstoned tier) → metadata patch; poster is the TMDB CDN path (D-05). */
export function metadataFromRadarrLookup(m: RadarrLookup): MetadataPatch {
  const r = m.ratings;
  const path =
    tmdbPathFromRemote(m.remotePoster) ??
    tmdbPathFromRemote(m.images?.find((i) => i.coverType === 'poster')?.remoteUrl);
  return {
    imdbRating: r?.imdb?.value ?? null,
    imdbVotes: r?.imdb?.votes ?? null,
    tmdbRating: r?.tmdb?.value ?? null,
    tmdbVotes: r?.tmdb?.votes ?? null,
    rtTomatometer: round(r?.rottenTomatoes?.value),
    runtimeMinutes: m.runtime ?? null,
    genres: m.genres ?? [],
    ...(path ? { posterSource: 'tmdb' as const, posterRef: path } : {}),
  };
}

/** Sonarr /lookup → metadata patch. */
export function metadataFromSonarrLookup(m: SonarrLookup): MetadataPatch {
  const path =
    tmdbPathFromRemote(m.remotePoster) ??
    tmdbPathFromRemote(m.images?.find((i) => i.coverType === 'poster')?.remoteUrl);
  return {
    tmdbRating: m.ratings?.value ?? null,
    tmdbVotes: m.ratings?.votes ?? null,
    runtimeMinutes: m.runtime ?? null,
    genres: m.genres ?? [],
    ...(path ? { posterSource: 'tmdb' as const, posterRef: path } : {}),
  };
}

/** Lidarr /lookup → metadata patch. */
export function metadataFromLidarrLookup(m: LidarrLookup): MetadataPatch {
  const path = tmdbPathFromRemote(
    m.remotePoster ?? m.images?.find((i) => i.coverType === 'poster')?.remoteUrl,
  );
  return {
    tmdbRating: m.ratings?.value ?? null,
    tmdbVotes: m.ratings?.votes ?? null,
    genres: m.genres ?? [],
    ...(path ? { posterSource: 'tmdb' as const, posterRef: path } : {}),
  };
}

/** TMDB movie (direct fallback) → metadata patch. */
export function metadataFromTmdbMovie(m: TmdbMovie): MetadataPatch {
  return {
    tmdbRating: m.vote_average ?? null,
    tmdbVotes: m.vote_count ?? null,
    runtimeMinutes: m.runtime ?? null,
    genres: (m.genres ?? []).map((g) => g.name),
    ...(m.poster_path ? { posterSource: 'tmdb' as const, posterRef: m.poster_path } : {}),
  };
}

/** TMDB tv (direct fallback) → metadata patch. */
export function metadataFromTmdbTv(m: TmdbTv): MetadataPatch {
  return {
    tmdbRating: m.vote_average ?? null,
    tmdbVotes: m.vote_count ?? null,
    runtimeMinutes: m.episode_run_time?.[0] ?? null,
    genres: (m.genres ?? []).map((g) => g.name),
    ...(m.poster_path ? { posterSource: 'tmdb' as const, posterRef: m.poster_path } : {}),
  };
}

/** TVDB series (last-resort fallback) → metadata patch (genres/runtime/poster; no 0-10 rating). */
export function metadataFromTvdbSeries(s: TvdbSeries): MetadataPatch {
  return {
    runtimeMinutes: s.data.averageRuntime ?? null,
    genres: (s.data.genres ?? []).map((g) => g.name),
  };
}

// ── Tautulli watch-stats aggregation (D-04, cross-server addendum) ────────────────────────

/** The external ids parsed out of a Tautulli `guids` list (`imdb://tt…`, `tmdb://…`, `tvdb://…`). */
export interface ParsedGuids {
  imdbId?: string;
  tmdbId?: number;
  tvdbId?: number;
}

export function parseTautulliGuids(guids: readonly string[] | null | undefined): ParsedGuids {
  const out: ParsedGuids = {};
  for (const g of guids ?? []) {
    const [scheme, id] = g.split('://');
    if (!id) continue;
    if (scheme === 'imdb') out.imdbId = id;
    else if (scheme === 'tmdb') out.tmdbId = Number(id) || undefined;
    else if (scheme === 'tvdb') out.tvdbId = Number(id) || undefined;
  }
  return out;
}

/** Convert a Tautulli unix-seconds timestamp to a Date (null on absence). */
export function tautulliDate(value: number | string | null | undefined): Date | null {
  if (value === null || value === undefined || value === '') return null;
  const secs = typeof value === 'string' ? Number(value) : value;
  if (!Number.isFinite(secs) || secs <= 0) return null;
  return new Date(secs * 1000);
}

/** The unified watch signal for one title, plus the per-instance breakdown (→ extra.tautulli). */
export interface WatchStat {
  playCount: number;
  lastViewedAt: Date | null;
  perInstance: Record<string, { playCount: number; lastViewedAt: string | null }>;
}

/** A single instance's contribution for one title, keyed during aggregation. */
export interface WatchContribution {
  instanceSlug: string;
  playCount: number;
  lastViewedAt: Date | null;
}

/**
 * DESIGN-008 D-04 (cross-server addendum) — merge one title's per-instance contributions into
 * the UNIFIED signal: play_count = SUM across servers, last_viewed_at = MAX across servers,
 * with the per-instance breakdown preserved for extra.tautulli. Pure + heavily unit-tested.
 */
export function mergeWatchContributions(contributions: readonly WatchContribution[]): WatchStat {
  let playCount = 0;
  let lastViewedAt: Date | null = null;
  const perInstance: WatchStat['perInstance'] = {};
  for (const c of contributions) {
    playCount += c.playCount;
    if (c.lastViewedAt && (!lastViewedAt || c.lastViewedAt > lastViewedAt)) {
      lastViewedAt = c.lastViewedAt;
    }
    const prev = perInstance[c.instanceSlug];
    perInstance[c.instanceSlug] = {
      playCount: (prev?.playCount ?? 0) + c.playCount,
      lastViewedAt:
        c.lastViewedAt && (!prev?.lastViewedAt || c.lastViewedAt.toISOString() > prev.lastViewedAt)
          ? c.lastViewedAt.toISOString()
          : (prev?.lastViewedAt ?? null),
    };
  }
  return { playCount, lastViewedAt, perInstance };
}

/** Map a resolved Tautulli metadata record to its join ids (movies map by tmdb/imdb; episodes
 *  by their SERIES guids — the harvest resolves the grandparent for episodes). */
export function guidsFromMetadata(meta: TautulliMetadata): ParsedGuids {
  return parseTautulliGuids(meta.guids);
}
