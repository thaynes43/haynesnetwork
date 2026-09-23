// Shared vocabulary for the Watch Companion math (DESIGN-049 D-07/D-08).
//
// Every time value in this package is a unix timestamp in SECONDS (Plex `lastViewedAt`, Tautulli
// `started`/`stopped`, and `now`), never milliseconds and never a Date. Callers convert at the edge.

export const WATCH_KINDS = ['show', 'movie'] as const;
/** A Title State is a show or a movie (D-07 `watch_titles.kind`). */
export type WatchKind = (typeof WATCH_KINDS)[number];

/**
 * The three Plex servers, in PREFERENCE order: the next episode is served from HaynesOps when it
 * holds it (D-10), and a Watch Mark writes HaynesOps first, else HaynesTower (D-14). HaynesKube holds
 * music today and sorts last.
 */
export const PLEX_SERVERS = ['haynesops', 'haynestower', 'hayneskube'] as const;
export type PlexServer = (typeof PLEX_SERVERS)[number];

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

/** A Plex item on one server: the unit a Watch Mark flips and `watch_marks.flipped` stores (D-07). */
export interface PlexItemKey {
  server: PlexServer;
  ratingKey: string;
}

export const DAY_SECONDS = 86_400;
/** A mean Gregorian year, for the Taste Profile half-life (D-16). */
export const YEAR_SECONDS = 365.25 * DAY_SECONDS;
