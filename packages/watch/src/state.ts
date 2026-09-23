// Title State helpers (DESIGN-049 D-09 step 4, D-11, D-14 step 6, D-15): turn Plex reads into the D-10
// inputs, and D-10 outputs into `watch_titles` columns. Pure — shared by the `watch` sync, the live
// revalidation and the Watch Mark write-through, so all three write exactly the same shape.
//
// Plex items arrive as @hnet/plex `PlexSectionItem`s; this package does not import @hnet/plex (D-01), so it
// declares the structural subset it reads (`PlexItemLike`) and a PlexSectionItem is assignable to it.

import type { WatchOnPlexEntry, WatchPlexCounts } from '@hnet/db/schema';
import {
  applyFlips,
  type EpisodeMap,
  type EpisodeObs,
  type EventObs,
  type MovieProgress,
  type ServerEpisodes,
  type ServerMovieObs,
  type ShowProgress,
} from './progress';
import { PLEX_SERVERS, type PlexServer } from './types';
import { serverRank, validTime } from './util';

/** The fields of a Plex item (section listing, metadata read, allLeaves leaf) the watch math reads. */
export interface PlexItemLike {
  ratingKey: string;
  type?: string;
  title: string;
  year?: number;
  guid?: string;
  Guid?: ReadonlyArray<{ id: string }>;
  Genre?: ReadonlyArray<{ tag: string }>;
  contentRating?: string;
  /** Episode number (a leaf) or season number (a season). */
  index?: number;
  /** An episode's season number. */
  parentIndex?: number;
  parentRatingKey?: string;
  grandparentRatingKey?: string;
  grandparentGuid?: string;
  grandparentTitle?: string;
  leafCount?: number;
  viewedLeafCount?: number;
  viewCount?: number;
  /** Unix seconds. */
  lastViewedAt?: number;
  /** Resume point, ms. */
  viewOffset?: number;
  /** Runtime, ms. */
  duration?: number;
  /** Unix seconds. */
  addedAt?: number;
}

/** The external ids a Plex item carries (`guid` plus the `Guid[]` agent ids with `includeGuids=1`). */
export interface PlexItemIds {
  /** A `plex://show|movie|episode/…` guid, else null. */
  plexGuid: string | null;
  tmdbId: number | null;
  tvdbId: number | null;
  imdbId: string | null;
  /** An unmatched item (`local://…`): no plex.tv view-state sync (ADR-088). */
  local: boolean;
}

function positiveInt(raw: string | undefined): number | null {
  if (raw === undefined) return null;
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : null;
}

/** Parse a Plex item's identity: its `plex://` guid, `tmdb://` / `tvdb://` / `imdb://` agent ids. */
export function parsePlexItemIds(item: Pick<PlexItemLike, 'guid' | 'Guid'>): PlexItemIds {
  const guid = item.guid?.trim() ?? '';
  const out: PlexItemIds = {
    plexGuid: guid.startsWith('plex://') ? guid : null,
    tmdbId: null,
    tvdbId: null,
    imdbId: null,
    local: guid.startsWith('local://'),
  };
  for (const { id } of item.Guid ?? []) {
    const m = /^(tmdb|tvdb|imdb):\/\/(.+)$/i.exec(id.trim());
    if (!m) continue;
    const scheme = m[1]?.toLowerCase();
    const value = m[2] ?? '';
    if (scheme === 'tmdb') out.tmdbId ??= positiveInt(value);
    else if (scheme === 'tvdb') out.tvdbId ??= positiveInt(value);
    else if (/^tt\d+$/i.test(value)) out.imdbId ??= value.toLowerCase();
  }
  return out;
}

/** The item's genre names (Plex `Genre[].tag`), in Plex's order. */
export function plexGenres(item: Pick<PlexItemLike, 'Genre'>): string[] {
  return (item.Genre ?? []).map((g) => g.tag.trim()).filter((g) => g.length > 0);
}

/**
 * `allLeaves` → D-10 episode observations for one server. Leaves without a season/episode index are
 * dropped; season 0 (specials) is KEPT here — `computeShowProgress` excludes it from the math, while a
 * Watch Mark's before-state needs every leaf (a show scrobble flips specials too).
 */
export function episodeObsFromLeaves(leaves: readonly PlexItemLike[]): EpisodeObs[] {
  const out: EpisodeObs[] = [];
  for (const leaf of leaves) {
    const season = leaf.parentIndex;
    const episode = leaf.index;
    if (typeof season !== 'number' || typeof episode !== 'number') continue;
    if (!Number.isInteger(season) || !Number.isInteger(episode)) continue;
    out.push({
      season,
      episode,
      ratingKey: leaf.ratingKey,
      watched: (leaf.viewCount ?? 0) > 0,
      lastViewedAt: validTime(leaf.lastViewedAt),
      viewOffsetMs: (leaf.viewOffset ?? 0) > 0 ? (leaf.viewOffset ?? null) : null,
      title: leaf.title,
    });
  }
  return out;
}

/** One movie item on one server → the D-10 movie observation. */
export function movieObsFromItem(server: PlexServer, item: PlexItemLike): ServerMovieObs {
  const ids = parsePlexItemIds(item);
  return {
    server,
    ratingKey: item.ratingKey,
    guid: item.guid ?? null,
    local: ids.local,
    viewCount: Math.max(0, item.viewCount ?? 0),
    viewOffsetMs: (item.viewOffset ?? 0) > 0 ? (item.viewOffset ?? null) : null,
    durationMs: (item.duration ?? 0) > 0 ? (item.duration ?? null) : null,
    lastViewedAt: validTime(item.lastViewedAt),
  };
}

/** Per-server counters for change detection (D-07 `plex_counts[server]`). */
export type ServerCounts = NonNullable<WatchPlexCounts[PlexServer]>;

/** A show item's counters: `leafCount`, `viewedLeafCount`, `lastViewedAt` (specials included, as Plex counts). */
export function showCounts(item: Pick<PlexItemLike, 'leafCount' | 'viewedLeafCount' | 'lastViewedAt'>): ServerCounts {
  return {
    leafCount: item.leafCount ?? null,
    viewedLeafCount: item.viewedLeafCount ?? null,
    lastViewedAt: validTime(item.lastViewedAt),
  };
}

/**
 * A movie's counters (PLAN-068 S6 as-built): `leafCount` 1, `viewedLeafCount` 1 when watched on that
 * server, `lastViewedAt`. The resume point is not a counter (it is not synced between servers, D-10):
 * the row's `next_server` names where it lives.
 */
export function movieCounts(obs: Pick<ServerMovieObs, 'viewCount' | 'lastViewedAt'>): ServerCounts {
  return { leafCount: 1, viewedLeafCount: obs.viewCount > 0 ? 1 : 0, lastViewedAt: validTime(obs.lastViewedAt) };
}

/** Two counters are the same Plex state (a missing side never equals a present one). */
export function countsEqual(a: ServerCounts | undefined | null, b: ServerCounts | undefined | null): boolean {
  if (!a || !b) return false;
  return (
    (a.leafCount ?? null) === (b.leafCount ?? null) &&
    (a.viewedLeafCount ?? null) === (b.viewedLeafCount ?? null) &&
    (validTime(a.lastViewedAt) ?? null) === (validTime(b.lastViewedAt) ?? null)
  );
}

/** `on_plex` entries in server preference order, one per server (the first seen wins). */
export function orderOnPlex(entries: readonly WatchOnPlexEntry[]): WatchOnPlexEntry[] {
  const seen = new Set<PlexServer>();
  return [...entries]
    .sort((a, b) => serverRank(a.server) - serverRank(b.server))
    .filter((e) => {
      if (seen.has(e.server)) return false;
      seen.add(e.server);
      return true;
    });
}

/** The preferred holder: HaynesOps when it holds the title, else HaynesTower, else HaynesKube. */
export function preferredHolder(onPlex: readonly WatchOnPlexEntry[]): WatchOnPlexEntry | null {
  return orderOnPlex(onPlex)[0] ?? null;
}

/**
 * The per-server episode lists a stored `episode_map` describes (pair-level watched state and
 * `lastViewedAt`; no resume points, no titles) — the inputs for recomputing a title whose servers were
 * not re-read.
 */
export function serverEpisodesFromMap(map: EpisodeMap | null | undefined): ServerEpisodes[] {
  return map ? applyFlips(map, [], true) : [];
}

/** Replace (or add) whole servers of a server-episode list with fresh reads; order by preference. */
export function withServerEpisodes(
  base: readonly ServerEpisodes[],
  fresh: readonly ServerEpisodes[],
): ServerEpisodes[] {
  const byServer = new Map<PlexServer, ServerEpisodes>();
  for (const s of base) byServer.set(s.server, s);
  for (const s of fresh) byServer.set(s.server, s);
  return PLEX_SERVERS.flatMap((server) => {
    const s = byServer.get(server);
    return s ? [s] : [];
  });
}

/** Drop whole servers (a server the title is gone from). */
export function withoutServers(
  base: readonly ServerEpisodes[],
  gone: ReadonlySet<PlexServer>,
): ServerEpisodes[] {
  return base.filter((s) => !gone.has(s.server));
}

/** A stored Watch Event (a `watch_events` row) → the D-10 event observation. */
export function eventObs(e: {
  season: number | null;
  episode: number | null;
  watched: boolean;
  startedAt: Date;
  stoppedAt: Date | null;
}): EventObs {
  return {
    season: e.season,
    episode: e.episode,
    watched: e.watched,
    startedAt: Math.floor(e.startedAt.getTime() / 1000),
    stoppedAt: e.stoppedAt ? Math.floor(e.stoppedAt.getTime() / 1000) : null,
  };
}

/** Unix seconds → a Date, or null. */
export function secondsToDate(t: number | null | undefined): Date | null {
  const v = validTime(t);
  return v === null ? null : new Date(v * 1000);
}

/** A Date → unix seconds, or null. */
export function dateToSeconds(d: Date | null | undefined): number | null {
  return d ? Math.floor(d.getTime() / 1000) : null;
}

/** The progress columns of a `watch_titles` row (everything D-10 derives). */
export interface TitleProgressFields {
  episodeMap: EpisodeMap | null;
  episodesTotal: number | null;
  episodesWatched: number | null;
  furthestSeason: number | null;
  furthestEpisode: number | null;
  nextSeason: number | null;
  nextEpisode: number | null;
  nextTitle: string | null;
  nextServer: PlexServer | null;
  nextRatingKey: string | null;
  nextResume: boolean;
  resumePercent: number | null;
  plexWatched: boolean;
  plexLastViewedAt: Date | null;
  eventPlays: number;
  eventWatchedEpisodes: number;
  firstWatchedAt: Date | null;
  lastWatchedAt: Date | null;
  rewatch: boolean;
}

/**
 * A show's progress columns. The stored map carries no episode titles, so a recompute from it yields a
 * null next title: `carry` (the row's previous next episode) keeps the title when the next pair is
 * unchanged (D-14 step 6).
 */
export function showProgressFields(
  p: ShowProgress,
  carry?: { season: number | null; episode: number | null; title: string | null } | null,
): TitleProgressFields {
  const next = p.next;
  let nextTitle = next?.title ?? null;
  if (next && nextTitle === null && carry && carry.season === next.season && carry.episode === next.episode) {
    nextTitle = carry.title;
  }
  return {
    episodeMap: p.episodeMap,
    episodesTotal: p.episodesTotal,
    episodesWatched: p.episodesWatched,
    furthestSeason: p.furthest?.season ?? null,
    furthestEpisode: p.furthest?.episode ?? null,
    nextSeason: next?.season ?? null,
    nextEpisode: next?.episode ?? null,
    nextTitle,
    nextServer: next?.server ?? null,
    nextRatingKey: next?.ratingKey ?? null,
    nextResume: next?.resume ?? false,
    resumePercent: null,
    plexWatched: p.plexWatched,
    plexLastViewedAt: secondsToDate(p.plexLastViewedAt),
    eventPlays: p.eventPlays,
    eventWatchedEpisodes: p.eventWatchedEpisodes,
    firstWatchedAt: secondsToDate(p.firstWatchedAt),
    lastWatchedAt: secondsToDate(p.lastWatchedAt),
    rewatch: p.rewatch,
  };
}

/**
 * A movie's progress columns (PLAN-068 S5 as-built): no episodes; `next_server` / `next_rating_key` name
 * where the resume point lives (resume points are not synced between servers), null without one;
 * `event_watched_episodes` is 1 when a Watch Event says it was watched (the T-247 "watched event").
 */
export function movieProgressFields(
  p: MovieProgress,
  servers: readonly Pick<ServerMovieObs, 'server' | 'ratingKey'>[],
): TitleProgressFields {
  const resumeKey =
    p.resumeServer === null ? null : (servers.find((s) => s.server === p.resumeServer)?.ratingKey ?? null);
  return {
    episodeMap: null,
    episodesTotal: null,
    episodesWatched: null,
    furthestSeason: null,
    furthestEpisode: null,
    nextSeason: null,
    nextEpisode: null,
    nextTitle: null,
    nextServer: resumeKey === null ? null : p.resumeServer,
    nextRatingKey: resumeKey,
    nextResume: false,
    resumePercent: p.resumePercent,
    plexWatched: p.plexWatched,
    plexLastViewedAt: secondsToDate(p.plexLastViewedAt),
    eventPlays: p.eventPlays,
    eventWatchedEpisodes: p.eventWatched ? 1 : 0,
    firstWatchedAt: secondsToDate(p.firstWatchedAt),
    lastWatchedAt: secondsToDate(p.lastWatchedAt),
    rewatch: false,
  };
}

/**
 * Rebuild a movie's per-server observations from a stored row, for servers that were not read this time
 * (a degraded sync, or a revalidation of one server): watched and `lastViewedAt` from `plex_counts`, and
 * the stored resume percent on the `next_server` it came from (as `viewOffset` of a 100 ms runtime, so
 * `computeMovieProgress` returns the same percent).
 */
export function storedMovieObs(row: {
  onPlex: readonly WatchOnPlexEntry[];
  plexCounts: WatchPlexCounts;
  nextServer: PlexServer | null;
  resumePercent: number | null;
}): ServerMovieObs[] {
  return orderOnPlex(row.onPlex).map((e) => {
    const counts = row.plexCounts[e.server];
    const resume = row.nextServer === e.server && row.resumePercent !== null ? row.resumePercent : null;
    return {
      server: e.server,
      ratingKey: e.ratingKey,
      guid: null,
      local: e.local,
      viewCount: (counts?.viewedLeafCount ?? 0) > 0 ? 1 : 0,
      viewOffsetMs: resume !== null && resume > 0 ? resume : null,
      durationMs: resume !== null && resume > 0 ? 100 : null,
      lastViewedAt: validTime(counts?.lastViewedAt),
    };
  });
}

/**
 * Apply Watch Mark flips (D-14 step 6) or their undo (D-15) to per-server episode lists without a second
 * read. As with {@link applyFlips}, a flip sets the whole (season, episode) PAIR on every server (plex.tv
 * view-state sync carries it): a mark stamps `lastViewedAt = at`, an undo clears it; resume points are
 * gone either way (Plex's scrobble and unscrobble both clear them). Keys no list holds are ignored.
 */
export function applyEpisodeFlips(
  servers: readonly ServerEpisodes[],
  flips: readonly { server: PlexServer; ratingKey: string }[],
  watched: boolean,
  at: number | null,
): ServerEpisodes[] {
  const flipped = new Set(flips.map((f) => `${f.server}\u0000${f.ratingKey}`));
  const pairs = new Set<string>();
  for (const s of servers) {
    for (const e of s.episodes) {
      if (flipped.has(`${s.server}\u0000${e.ratingKey}`)) pairs.add(`${e.season}:${e.episode}`);
    }
  }
  return servers.map((s) => ({
    server: s.server,
    episodes: s.episodes.map((e) =>
      pairs.has(`${e.season}:${e.episode}`)
        ? {
            ...e,
            watched,
            lastViewedAt: watched ? (validTime(at) ?? e.lastViewedAt) : null,
            viewOffsetMs: null,
          }
        : e,
    ),
  }));
}

/** The movie counterpart: a flipped copy becomes watched at `at` (a mark) or unwatched (an undo). */
export function applyMovieFlips(
  servers: readonly ServerMovieObs[],
  flips: readonly { server: PlexServer; ratingKey: string }[],
  watched: boolean,
  at: number | null,
): ServerMovieObs[] {
  const flipped = new Set(flips.map((f) => `${f.server}\u0000${f.ratingKey}`));
  return servers.map((s) =>
    flipped.has(`${s.server}\u0000${s.ratingKey}`)
      ? {
          ...s,
          viewCount: watched ? Math.max(1, s.viewCount) : 0,
          viewOffsetMs: null,
          lastViewedAt: watched ? (validTime(at) ?? s.lastViewedAt) : null,
        }
      : s,
  );
}
