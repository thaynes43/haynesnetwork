// Progress math (DESIGN-049 D-10): a show's united per-episode state across the Plex servers that hold
// it, its next episode and rewatch flag; a movie's watched flag and resume point; the children's-title
// rule; the read-time states; and the Watch Mark write-through (D-14 step 6). Pure: no I/O, no clock.

import { PLEX_SERVER_SLUGS, type WatchEpisodeMap } from '@hnet/db/schema';
import { z } from 'zod';
import { canonicalGenres } from './genres';
import {
  DAY_SECONDS,
  PLEX_SERVERS,
  type PlexItemKey,
  type PlexServer,
  type WatchKind,
} from './types';
import { compareText, serverRank, validTime } from './util';

// ---------------------------------------------------------------------------------------------------
// Inputs

/** One episode as a Plex server reports it (`allLeaves`). */
export interface EpisodeObs {
  season: number;
  episode: number;
  ratingKey: string;
  /** `viewCount > 0` on this server. */
  watched: boolean;
  /** Unix seconds; null or 0 when never viewed. */
  lastViewedAt: number | null;
  /** Resume point in ms; > 0 on an unwatched episode means it was started. */
  viewOffsetMs: number | null;
  title?: string | null;
}

/** The episodes one server holds for a show — all the progress math needs. */
export interface ServerEpisodes {
  server: PlexServer;
  episodes: readonly EpisodeObs[];
}

/** A show on one server: its episodes plus the show item's own key, guid and match state. */
export interface ServerShowObs extends ServerEpisodes {
  ratingKey: string;
  guid: string | null;
  /** An unmatched `local://` item (no view-state sync; ADR-088). */
  local: boolean;
}

/** A Watch Event (T-243) reduced to what progress needs. Times are unix seconds. */
export interface EventObs {
  season: number | null;
  episode: number | null;
  /** Tautulli's own watched verdict (`watched_status = 1`, 85%). */
  watched: boolean;
  startedAt: number;
  stoppedAt: number | null;
}

// ---------------------------------------------------------------------------------------------------
// The compact episode map (D-07 `watch_titles.episode_map`)

/**
 * `{"<season>": EpisodeMapEntry[]}`, seasons ≥ 1, episodes ascending — the column's own jsonb type
 * (`WatchEpisodeMap` in @hnet/db), so a computed map is written and read back with no cast (PLAN-068 S5).
 */
export type EpisodeMap = WatchEpisodeMap;

/** `[episode, watched 0/1, lastViewedAt s or 0, {server: ratingKey}]`. */
export type EpisodeMapEntry = WatchEpisodeMap[string][number];

/** Validates a stored `episode_map` (jsonb reads back as `unknown`). */
export const episodeMapSchema = z.record(
  z.string().regex(/^[1-9]\d*$/),
  z.array(
    z.tuple([
      z.number().int().nonnegative(),
      z.union([z.literal(0), z.literal(1)]),
      z.number().nonnegative(),
      z.partialRecord(z.enum(PLEX_SERVER_SLUGS), z.string()),
    ]),
  ),
);

/** Parse a stored episode map; throws a ZodError on a malformed value. */
export function parseEpisodeMap(value: unknown): EpisodeMap {
  return episodeMapSchema.parse(value) as EpisodeMap;
}

// ---------------------------------------------------------------------------------------------------
// Shows

export interface EpisodeRef {
  season: number;
  episode: number;
}

export interface NextEpisode extends EpisodeRef {
  title: string | null;
  /** HaynesOps when it holds the episode, else HaynesTower, else HaynesKube. */
  server: PlexServer;
  ratingKey: string;
  /** The episode has a resume point (it was started; D-07 `next_resume`). */
  resume: boolean;
}

export interface ShowProgress {
  /** Distinct (season ≥ 1, episode) pairs across the holding servers (D-07 `episodes_total`). */
  episodesTotal: number;
  /** Pairs watched on ANY server (D-07 `episodes_watched`). */
  episodesWatched: number;
  furthest: EpisodeRef | null;
  next: NextEpisode | null;
  /** Every pair is watched: the show is fully watched in Plex now (D-07 `plex_watched`). */
  plexWatched: boolean;
  /** Newest Plex `lastViewedAt` over the pairs (D-07 `plex_last_viewed_at`). */
  plexLastViewedAt: number | null;
  /** Oldest of Plex `lastViewedAt` and event `startedAt` (D-07 `first_watched_at`). */
  firstWatchedAt: number | null;
  /** Newest of Plex `lastViewedAt` and event `stoppedAt` (D-07 `last_watched_at`). */
  lastWatchedAt: number | null;
  /** The event log has watched more distinct episodes than Plex shows, by more than two. */
  rewatch: boolean;
  /** Distinct (season ≥ 1, episode) pairs with a watched event (D-07 `event_watched_episodes`). */
  eventWatchedEpisodes: number;
  /** Events counted for the title, specials excluded (D-07 `event_plays`). */
  eventPlays: number;
  episodeMap: EpisodeMap;
}

interface PairState {
  season: number;
  episode: number;
  watched: boolean;
  lastViewedAt: number;
  resume: boolean;
  keys: Partial<Record<PlexServer, string>>;
  titles: Partial<Record<PlexServer, string>>;
}

function isEpisodeIndex(season: number | null, episode: number | null): boolean {
  return (
    typeof season === 'number' &&
    typeof episode === 'number' &&
    Number.isInteger(season) &&
    Number.isInteger(episode) &&
    season >= 1 &&
    episode >= 0
  );
}

function compareEpisodes(a: EpisodeRef, b: EpisodeRef): number {
  return a.season - b.season || a.episode - b.episode;
}

function orderedKeys(
  keys: Partial<Record<PlexServer, string>>,
): Partial<Record<PlexServer, string>> {
  const out: Partial<Record<PlexServer, string>> = {};
  for (const server of PLEX_SERVERS) {
    const key = keys[server];
    if (key !== undefined) out[server] = key;
  }
  return out;
}

function nextEpisode(pair: PairState): NextEpisode | null {
  for (const server of PLEX_SERVERS) {
    const ratingKey = pair.keys[server];
    if (ratingKey === undefined) continue;
    const title =
      pair.titles[server] ?? PLEX_SERVERS.map((s) => pair.titles[s]).find((t) => t !== undefined);
    return {
      season: pair.season,
      episode: pair.episode,
      title: title ?? null,
      server,
      ratingKey,
      resume: pair.resume,
    };
  }
  return null;
}

function maxTime(a: number | null, b: number | null): number | null {
  if (a === null) return b;
  if (b === null) return a;
  return Math.max(a, b);
}

function minTime(a: number | null, b: number | null): number | null {
  if (a === null) return b;
  if (b === null) return a;
  return Math.min(a, b);
}

/**
 * D-10 for one show. The universe is the union over servers of (season, episode) with season ≥ 1
 * (specials never count); a pair is watched when any server says so. Furthest is the greatest watched
 * pair; next is the pair right after it, or — when nothing is watched — the started (resume point)
 * episode viewed most recently. Rewatch when the events hold more than `episodesWatched + 2` distinct
 * watched episodes. Season-0 events are ignored like specials; an event without `stoppedAt` counts
 * at its `startedAt`.
 */
export function computeShowProgress(
  servers: readonly ServerEpisodes[],
  events: readonly EventObs[],
): ShowProgress {
  const pairs = new Map<string, PairState>();
  for (const obs of servers) {
    for (const ep of obs.episodes) {
      if (!isEpisodeIndex(ep.season, ep.episode)) continue;
      const id = `${ep.season}:${ep.episode}`;
      let pair = pairs.get(id);
      if (!pair) {
        pair = {
          season: ep.season,
          episode: ep.episode,
          watched: false,
          lastViewedAt: 0,
          resume: false,
          keys: {},
          titles: {},
        };
        pairs.set(id, pair);
      }
      if (ep.watched) pair.watched = true;
      const viewed = validTime(ep.lastViewedAt);
      if (viewed !== null && viewed > pair.lastViewedAt) pair.lastViewedAt = viewed;
      if (!ep.watched && (ep.viewOffsetMs ?? 0) > 0) pair.resume = true;
      if (pair.keys[obs.server] === undefined) pair.keys[obs.server] = ep.ratingKey;
      const title = ep.title?.trim();
      if (title && pair.titles[obs.server] === undefined) pair.titles[obs.server] = title;
    }
  }

  const sorted = [...pairs.values()].sort(compareEpisodes);
  let furthestIndex = -1;
  sorted.forEach((p, i) => {
    if (p.watched) furthestIndex = i;
  });
  const furthestPair = sorted[furthestIndex];
  const nextPair: PairState | undefined = furthestPair
    ? sorted[furthestIndex + 1]
    : sorted
        .filter((p) => p.resume)
        .sort((a, b) => b.lastViewedAt - a.lastViewedAt || compareEpisodes(a, b))[0];
  const next = nextPair ? nextEpisode(nextPair) : null;

  let plexLastViewedAt: number | null = null;
  let firstWatchedAt: number | null = null;
  for (const p of sorted) {
    const viewed = validTime(p.lastViewedAt);
    plexLastViewedAt = maxTime(plexLastViewedAt, viewed);
    firstWatchedAt = minTime(firstWatchedAt, viewed);
  }

  let lastWatchedAt = plexLastViewedAt;
  let eventPlays = 0;
  const eventPairs = new Set<string>();
  for (const e of events) {
    if (e.season === 0) continue;
    eventPlays += 1;
    const started = validTime(e.startedAt);
    lastWatchedAt = maxTime(lastWatchedAt, validTime(e.stoppedAt) ?? started);
    firstWatchedAt = minTime(firstWatchedAt, started);
    if (e.watched && isEpisodeIndex(e.season, e.episode)) {
      eventPairs.add(`${e.season}:${e.episode}`);
    }
  }

  const episodesWatched = sorted.filter((p) => p.watched).length;
  const episodeMap: EpisodeMap = {};
  for (const p of sorted) {
    const season = String(p.season);
    const entry: EpisodeMapEntry = [
      p.episode,
      p.watched ? 1 : 0,
      p.lastViewedAt,
      orderedKeys(p.keys),
    ];
    (episodeMap[season] ??= []).push(entry);
  }

  return {
    episodesTotal: sorted.length,
    episodesWatched,
    furthest: furthestPair ? { season: furthestPair.season, episode: furthestPair.episode } : null,
    next,
    plexWatched: sorted.length > 0 && episodesWatched === sorted.length,
    plexLastViewedAt,
    firstWatchedAt,
    lastWatchedAt,
    rewatch: eventPairs.size > episodesWatched + 2,
    eventWatchedEpisodes: eventPairs.size,
    eventPlays,
    episodeMap,
  };
}

/**
 * Write-through after a Watch Mark (D-14 step 6) or its undo (D-15), without a second Plex read:
 * rebuild the progress inputs from the stored episode map with `flips` (the `watch_marks.flipped`
 * keys) set to `watched`. Feed the result to {@link computeShowProgress} with the title's events.
 *
 * A flip matches a pair through any server's rating key and sets the whole pair (view-state sync
 * carries it to the other servers). A mark stamps `lastViewedAt = at` (keeps the stored value when
 * `at` is absent); an undo clears it. Resume points are gone either way — Plex's scrobble and
 * unscrobble both clear them — and episode titles are not stored in the map, so `next.title` comes
 * back null (carry the old one over when the next pair is unchanged). Keys the map does not hold are
 * ignored.
 */
export function applyFlips(
  episodeMap: EpisodeMap,
  flips: readonly PlexItemKey[],
  watched: boolean,
  opts: { at?: number | null } = {},
): ServerEpisodes[] {
  const flipped = new Set(flips.map((f) => `${f.server}\u0000${f.ratingKey}`));
  const byServer = new Map<PlexServer, EpisodeObs[]>();
  const seasons = Object.keys(episodeMap)
    .map(Number)
    .filter((s) => Number.isInteger(s) && s >= 1)
    .sort((a, b) => a - b);
  for (const season of seasons) {
    for (const [episode, wasWatched, lastViewedAt, keys] of episodeMap[String(season)] ?? []) {
      const hit = PLEX_SERVERS.some((s) => {
        const key = keys[s];
        return key !== undefined && flipped.has(`${s}\u0000${key}`);
      });
      const isWatched = hit ? watched : wasWatched === 1;
      let viewed = validTime(lastViewedAt);
      if (hit) viewed = watched ? (validTime(opts.at) ?? viewed) : null;
      for (const server of PLEX_SERVERS) {
        const ratingKey = keys[server];
        if (ratingKey === undefined) continue;
        const list = byServer.get(server) ?? [];
        list.push({
          season,
          episode,
          ratingKey,
          watched: isWatched,
          lastViewedAt: viewed,
          viewOffsetMs: null,
        });
        byServer.set(server, list);
      }
    }
  }
  return PLEX_SERVERS.flatMap((server) => {
    const episodes = byServer.get(server);
    return episodes ? [{ server, episodes }] : [];
  });
}

// ---------------------------------------------------------------------------------------------------
// Movies

/** A movie on one server. */
export interface ServerMovieObs {
  server: PlexServer;
  ratingKey: string;
  guid: string | null;
  local: boolean;
  viewCount: number;
  viewOffsetMs: number | null;
  durationMs: number | null;
  lastViewedAt: number | null;
}

export interface MovieProgress {
  /** Any server `viewCount > 0` (D-07 `plex_watched`). */
  plexWatched: boolean;
  /** 0–100 from the server viewed most recently (resume points are not synced); null when none. */
  resumePercent: number | null;
  /** The server the resume point came from. */
  resumeServer: PlexServer | null;
  plexLastViewedAt: number | null;
  firstWatchedAt: number | null;
  lastWatchedAt: number | null;
  eventPlays: number;
  /** Any watched Watch Event. */
  eventWatched: boolean;
}

function hasResumePoint(s: ServerMovieObs): boolean {
  return (s.viewOffsetMs ?? 0) > 0 && (s.durationMs ?? 0) > 0;
}

/**
 * D-10 for one movie: watched on any server; the resume percent from the server with the newest
 * `lastViewedAt` (ties: the one with a resume point, then HaynesOps, HaynesTower, HaynesKube), so a
 * stale resume point on another server never outlives a newer full watch.
 */
export function computeMovieProgress(
  servers: readonly ServerMovieObs[],
  events: readonly EventObs[],
): MovieProgress {
  const ranked = [...servers].sort(
    (a, b) =>
      (validTime(b.lastViewedAt) ?? 0) - (validTime(a.lastViewedAt) ?? 0) ||
      Number(hasResumePoint(b)) - Number(hasResumePoint(a)) ||
      serverRank(a.server) - serverRank(b.server),
  );
  const top = ranked[0];
  let resumePercent: number | null = null;
  let resumeServer: PlexServer | null = null;
  if (top && hasResumePoint(top)) {
    const pct = (100 * (top.viewOffsetMs ?? 0)) / (top.durationMs ?? 1);
    resumePercent = Math.min(100, Math.max(0, Math.round(pct)));
    resumeServer = top.server;
  }

  let plexLastViewedAt: number | null = null;
  let firstWatchedAt: number | null = null;
  for (const s of servers) {
    const viewed = validTime(s.lastViewedAt);
    plexLastViewedAt = maxTime(plexLastViewedAt, viewed);
    firstWatchedAt = minTime(firstWatchedAt, viewed);
  }
  let lastWatchedAt = plexLastViewedAt;
  for (const e of events) {
    const started = validTime(e.startedAt);
    lastWatchedAt = maxTime(lastWatchedAt, validTime(e.stoppedAt) ?? started);
    firstWatchedAt = minTime(firstWatchedAt, started);
  }

  return {
    plexWatched: servers.some((s) => s.viewCount > 0),
    resumePercent,
    resumeServer,
    plexLastViewedAt,
    firstWatchedAt,
    lastWatchedAt,
    eventPlays: events.length,
    eventWatched: events.some((e) => e.watched),
  };
}

// ---------------------------------------------------------------------------------------------------
// Children's titles

const KIDS_RATINGS = new Set(['TV-Y', 'TV-Y7', 'TV-Y7-FV']);

/**
 * D-10 `is_kids`: content rating TV-Y, TV-Y7 or TV-Y7-FV, or a Kids/Children genre; a movie also when
 * it is both Animation and Family.
 */
export function isKidsTitle(t: {
  kind: WatchKind;
  contentRating?: string | null;
  genres?: readonly string[] | null;
}): boolean {
  const rating = t.contentRating
    ?.trim()
    .toUpperCase()
    .replace(/^[A-Z]{2}\//, '')
    .replace(/\s+/g, '-');
  if (rating && KIDS_RATINGS.has(rating)) return true;
  const genres = canonicalGenres(t.genres);
  if (genres.includes('kids')) return true;
  return t.kind === 'movie' && genres.includes('animation') && genres.includes('family');
}

// ---------------------------------------------------------------------------------------------------
// States (computed at read time: they depend on now)

export type ShowState =
  'in_progress' | 'stalled' | 'caught_up' | 'finished' | 'taster' | 'unstarted';
export type MovieState = 'in_progress' | 'stalled' | 'finished' | 'unstarted';
export type ShowStatus = 'continuing' | 'ended';

/** A show is in progress while touched within 90 days; older is stalled. */
export const ACTIVE_WINDOW_SECONDS = 90 * DAY_SECONDS;
/** A Taster (T-246) is untouched for more than 30 days. */
export const TASTER_AGE_SECONDS = 30 * DAY_SECONDS;

export interface ShowStateInput {
  episodesWatched: number;
  episodesTotal: number;
  next: EpisodeRef | null;
  lastWatchedAt: number | null;
}

/**
 * The D-10 state table. `in_progress`/`stalled` need a next episode (≤ 90 days since last watched is
 * in progress, exactly 90 days included); `taster` overrides both when at most 2 episodes and under
 * 10% are watched and it is untouched for MORE than 30 days. Without a next episode: `finished` when
 * the ledger says the show ended, else `caught_up`; nothing watched and no resume point is
 * `unstarted`. An unknown last-watched time counts as old.
 */
export function showState(
  p: ShowStateInput,
  ctx: { showStatus?: ShowStatus | null; now: number },
): ShowState {
  const last = validTime(p.lastWatchedAt);
  const age = last === null ? Number.POSITIVE_INFINITY : ctx.now - last;
  if (p.next) {
    const taster =
      p.episodesWatched <= 2 &&
      p.episodesTotal > 0 &&
      p.episodesWatched / p.episodesTotal < 0.1 &&
      age > TASTER_AGE_SECONDS;
    if (taster) return 'taster';
    return age <= ACTIVE_WINDOW_SECONDS ? 'in_progress' : 'stalled';
  }
  if (p.episodesWatched > 0) return ctx.showStatus === 'ended' ? 'finished' : 'caught_up';
  return 'unstarted';
}

export interface MovieStateInput {
  plexWatched: boolean;
  resumePercent: number | null;
  lastWatchedAt: number | null;
}

/**
 * Movies: `in_progress` when 5 ≤ resume ≤ 90 and touched within 90 days, `stalled` when older;
 * otherwise `finished` when watched in Plex, else `unstarted`.
 */
export function movieState(p: MovieStateInput, ctx: { now: number }): MovieState {
  const r = p.resumePercent;
  if (r !== null && r >= 5 && r <= 90) {
    const last = validTime(p.lastWatchedAt);
    const age = last === null ? Number.POSITIVE_INFINITY : ctx.now - last;
    return age <= ACTIVE_WINDOW_SECONDS ? 'in_progress' : 'stalled';
  }
  return p.plexWatched ? 'finished' : 'unstarted';
}

/** Unfinished (T-245) order: `in_progress` first, then newest `lastWatchedAt`, then title. */
export function compareUnfinished(
  a: { state: 'in_progress' | 'stalled'; lastWatchedAt: number | null; title: string },
  b: { state: 'in_progress' | 'stalled'; lastWatchedAt: number | null; title: string },
): number {
  const rank = (s: string) => (s === 'in_progress' ? 0 : 1);
  return (
    rank(a.state) - rank(b.state) ||
    (validTime(b.lastWatchedAt) ?? 0) - (validTime(a.lastWatchedAt) ?? 0) ||
    compareText(a.title, b.title)
  );
}
