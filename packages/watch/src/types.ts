// Shared vocabulary for the Watch Companion math (DESIGN-049 D-07/D-08).
//
// Every time value in this package is a unix timestamp in SECONDS (Plex `lastViewedAt`, Tautulli
// `started`/`stopped`, and `now`), never milliseconds and never a Date. Callers convert at the edge.

import {
  PLEX_SERVER_SLUGS,
  WATCH_TITLE_KINDS,
  type PlexServerSlug,
  type WatchMarkFlip,
} from '@hnet/db/schema';

export const WATCH_KINDS = WATCH_TITLE_KINDS;
/** A Title State is a show or a movie (D-07 `watch_titles.kind`). */
export type WatchKind = (typeof WATCH_KINDS)[number];

/**
 * A Plex server slug. ONE source of truth (PLAN-068 S5 driver ruling): the schema's
 * `PLEX_SERVER_SLUGS`, the same list the `watch_events.instance` and `watch_titles.next_server` CHECKs
 * are built from — this package only adds the preference order.
 */
export type PlexServer = PlexServerSlug;

/**
 * Preference rank per slug. A `Record` over every slug, so a new server added to `PLEX_SERVER_SLUGS`
 * fails typecheck here until it is given a place in the order.
 */
const SERVER_PREFERENCE: Readonly<Record<PlexServerSlug, number>> = {
  haynesops: 0,
  haynestower: 1,
  hayneskube: 2,
};

/**
 * The three Plex servers, in PREFERENCE order: the next episode is served from HaynesOps when it
 * holds it (D-10), and a Watch Mark writes HaynesOps first, else HaynesTower (D-14). HaynesKube holds
 * music today and sorts last. Derived from `PLEX_SERVER_SLUGS` (whose own order is the registry's).
 */
export const PLEX_SERVERS: readonly PlexServer[] = [...PLEX_SERVER_SLUGS].sort(
  (a, b) => SERVER_PREFERENCE[a] - SERVER_PREFERENCE[b],
);

/** The external ids a source may know for a title (any subset; D-08). */
export interface ExternalIds {
  /** A `plex://show/…` or `plex://movie/…` guid. `local://` and legacy agent guids are ignored. */
  plexGuid?: string | null;
  /** TVDB series id. Shows only: TVDB movie ids live in a different id space and are ignored. */
  tvdbId?: number | null;
  /** TMDB id, namespaced by kind in keys (`tmdb:movie:603`, `tmdb:show:1399`). */
  tmdbId?: number | null;
  /** IMDb id, `tt…`. */
  imdbId?: string | null;
}

/** Everything identity needs: kind, title, year and whichever ids the source knows. */
export interface TitleIds extends ExternalIds {
  kind: WatchKind;
  title: string;
  year?: number | null;
}

/**
 * A Plex item on one server: the unit a Watch Mark flips and `watch_marks.flipped` stores (D-07) —
 * the schema's `WatchMarkFlip`, one type for both.
 */
export type PlexItemKey = WatchMarkFlip;

export const DAY_SECONDS = 86_400;
/** A mean Gregorian year, for the Taste Profile half-life (D-16). */
export const YEAR_SECONDS = 365.25 * DAY_SECONDS;
