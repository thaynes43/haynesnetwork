import {
  pgTable,
  bigserial,
  bigint,
  text,
  integer,
  smallint,
  boolean,
  uuid,
  jsonb,
  timestamp,
  check,
  unique,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { watchAccounts } from './watch-accounts';
import { mediaItems } from './media-items';
import {
  PLEX_SERVER_SLUGS,
  WATCH_SHOW_STATUSES,
  WATCH_TITLE_KINDS,
  type PlexServerSlug,
  type WatchShowStatus,
  type WatchTitleKind,
} from './enums';

const KINDS_SQL_LIST = WATCH_TITLE_KINDS.map((k) => `'${k}'`).join(',');
const SERVERS_SQL_LIST = PLEX_SERVER_SLUGS.map((s) => `'${s}'`).join(',');
const SHOW_STATUSES_SQL_LIST = WATCH_SHOW_STATUSES.map((s) => `'${s}'`).join(',');

/** One place a title exists on Plex right now (`on_plex`). `local` = an unmatched `local://` item. */
export interface WatchOnPlexEntry {
  server: PlexServerSlug;
  ratingKey: string;
  local: boolean;
}

/**
 * Per-server Plex counters kept for CHANGE DETECTION (`plex_counts`): the `watch` sync re-reads a show's
 * `allLeaves` only when these moved (DESIGN-049 D-09 step 3). `lastViewedAt` is unix seconds.
 */
export type WatchPlexCounts = Partial<
  Record<
    PlexServerSlug,
    { leafCount: number | null; viewedLeafCount: number | null; lastViewedAt: number | null }
  >
>;

/**
 * A show's per-episode map (`episode_map`), seasons ≥ 1 only (specials are excluded — D-10):
 * `{ "<season>": [[episode, watched 0|1, lastViewedAt unix seconds or 0, { server: ratingKey }]] }`.
 */
export type WatchEpisodeMap = Record<
  string,
  Array<[episode: number, watched: 0 | 1, lastViewedAt: number, ratingKeys: Partial<Record<PlexServerSlug, string>>]>
>;

/**
 * ADR-088 / DESIGN-049 D-07 (PLAN-068) — the Title State snapshot (T-244): one row per (account, title),
 * a title being a show or a movie. Identity is `title_key` (D-08: `plex:<guid>`, else `tvdb:`/`tmdb:movie:`,
 * else `imdb:`, else `name:<normalized>|<year>`); a writer that learns a stronger key re-keys the row IN
 * PLACE so marks keep pointing at it.
 *
 * For a show the row holds the owner's Plex progress united across the servers that hold it (specials
 * excluded): totals, the furthest and next episode, and the per-episode map. For a movie: watched and the
 * resume percentage. Event facts (plays, watched episodes, first/last watched, rewatch) come from
 * watch_events; `media_item_id` links the *arr ledger when an *arr manages the title. State (in progress,
 * stalled, caught up, …) is NOT stored — it depends on "now" and is computed at read time (D-10).
 *
 * Written ONLY by the @hnet/domain watch writers (the `watch` sync upsert, live revalidation, and the Watch
 * Mark write-through) — guard-listed. Upserted, never deleted: a title gone from Plex keeps its event facts
 * with `on_plex = []` (D-09 step 5). DELETE is guarded too so nothing outside the domain can drop history.
 */
export const watchTitles = pgTable(
  'watch_titles',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    plexAccountId: bigint('plex_account_id', { mode: 'number' })
      .notNull()
      .references(() => watchAccounts.plexAccountId, { onDelete: 'cascade' }),
    kind: text('kind').$type<WatchTitleKind>().notNull(),
    /** DESIGN-049 D-08 identity. */
    titleKey: text('title_key').notNull(),
    plexGuid: text('plex_guid'),
    tmdbId: integer('tmdb_id'),
    tvdbId: integer('tvdb_id'),
    imdbId: text('imdb_id'),
    /** The *arr ledger item, when Sonarr/Radarr manages the title. */
    mediaItemId: uuid('media_item_id').references(() => mediaItems.id, { onDelete: 'set null' }),
    title: text('title').notNull(),
    year: integer('year'),
    /** Genre names (ledger first, then Plex) — the media_metadata.genres shape. */
    genres: jsonb('genres').$type<string[]>().notNull().default([]),
    contentRating: text('content_rating'),
    /** Children's title (D-10: TV-Y/TV-Y7/TV-Y7-FV, a Kids/Children genre, or Animation+Family movies). */
    isKids: boolean('is_kids').notNull().default(false),
    /** Where the title exists on Plex right now. */
    onPlex: jsonb('on_plex').$type<WatchOnPlexEntry[]>().notNull().default([]),
    plexCounts: jsonb('plex_counts').$type<WatchPlexCounts>().notNull().default({}),
    /** Shows only. */
    episodeMap: jsonb('episode_map').$type<WatchEpisodeMap>(),
    /** Shows: aired-in-library episodes (seasons ≥ 1) and how many are watched. */
    episodesTotal: integer('episodes_total'),
    episodesWatched: integer('episodes_watched'),
    furthestSeason: integer('furthest_season'),
    furthestEpisode: integer('furthest_episode'),
    nextSeason: integer('next_season'),
    nextEpisode: integer('next_episode'),
    nextTitle: text('next_title'),
    /** The server to play the next episode on (HaynesOps when it holds it). */
    nextServer: text('next_server').$type<PlexServerSlug>(),
    nextRatingKey: text('next_rating_key'),
    /** The next episode has a resume point (a started-but-unwatched first episode, D-10). */
    nextResume: boolean('next_resume').notNull().default(false),
    /** Movies: the resume percentage on the server with the newest lastViewedAt. */
    resumePercent: smallint('resume_percent'),
    /** Movie watched / show fully watched in Plex NOW (current progress — Plex flags reset on rewatch). */
    plexWatched: boolean('plex_watched').notNull().default(false),
    plexLastViewedAt: timestamp('plex_last_viewed_at', { withTimezone: true }),
    eventPlays: integer('event_plays').notNull().default(0),
    eventWatchedEpisodes: integer('event_watched_episodes').notNull().default(0),
    /** Plex ∪ events. */
    firstWatchedAt: timestamp('first_watched_at', { withTimezone: true }),
    lastWatchedAt: timestamp('last_watched_at', { withTimezone: true }),
    /** The event log has more distinct watched episodes than Plex now shows (+2 slack) — D-10. */
    rewatch: boolean('rewatch').notNull().default(false),
    /** From the ledger (Sonarr `ended`), else NULL. */
    showStatus: text('show_status').$type<WatchShowStatus>(),
    refreshedAt: timestamp('refreshed_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('watch_titles_account_title_key_unique').on(t.plexAccountId, t.titleKey),
    check('watch_titles_kind_enum', sql`${t.kind} = ANY (ARRAY[${sql.raw(KINDS_SQL_LIST)}])`),
    check(
      'watch_titles_next_server_enum',
      sql`${t.nextServer} IS NULL OR ${t.nextServer} = ANY (ARRAY[${sql.raw(SERVERS_SQL_LIST)}])`,
    ),
    check(
      'watch_titles_show_status_enum',
      sql`${t.showStatus} IS NULL OR ${t.showStatus} = ANY (ARRAY[${sql.raw(SHOW_STATUSES_SQL_LIST)}])`,
    ),
  ],
);

export type WatchTitleRow = typeof watchTitles.$inferSelect;
export type WatchTitleInsert = typeof watchTitles.$inferInsert;
