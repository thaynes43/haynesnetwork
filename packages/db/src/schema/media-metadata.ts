import {
  pgTable,
  uuid,
  text,
  integer,
  numeric,
  timestamp,
  jsonb,
  check,
  unique,
  index,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import {
  RESOLUTIONS,
  POSTER_SOURCES,
  type Resolution,
  type PosterSource,
} from './enums';
import { mediaItems } from './media-items';

const RESOLUTIONS_SQL_LIST = RESOLUTIONS.map((r) => `'${r}'`).join(',');
const POSTER_SOURCES_SQL_LIST = POSTER_SOURCES.map((s) => `'${s}'`).join(',');

/**
 * ADR-018 / DESIGN-008 D-01 — the harvested descriptive/quality metadata for a Media Item,
 * held in a SEPARATE 1:1 sibling table (not columns on media_items). Rationale (ADR-018):
 * media_items is the Sync/Restore aggregate whose columns are the *arr-settings snapshot
 * Restore replays and every sync upsert rewrites; metadata is a DIFFERENT write cadence
 * (a 6-hourly multi-source refresh, volatile ratings/votes/watch-stats) that would bloat
 * every sync upsert and Restore preview if mixed in. A sibling keyed by media_item_id
 * (unique FK, cascade) isolates the volatile columns, carries its own multi-tier `sources`
 * + `fetched_at`, and — because tombstone-never-delete is the ledger invariant (DDD-001
 * T-41) — keeps its metadata after the parent row tombstones (the cascade only fires on a
 * hard delete, which never happens).
 *
 * Multi-source (DESIGN-008 D-03), harvested with PER-SOURCE DEGRADATION: the *arr tier
 * supplies ratings/images/genres/runtime/added; Tautulli supplies play_count/last_viewed
 * (unified across the three estate instances — SUM/MAX, per-instance breakdown in
 * `extra.tautulli`); Maintainerr supplies computed props (`extra.maintainerr`); direct
 * TMDB/TVDB fill holes for tombstoned / never-listed rows. Each tier fails independently
 * and records itself in `sources`.
 *
 * NO media_type column (DESIGN-008 D-08): the media noun (Movie/Show/Artist) is
 * media_items.arr_kind joined at read time + a display map in apps/web/lib/media.ts — no
 * new enum duplicating ARR_KINDS.
 */
export const mediaMetadata = pgTable(
  'media_metadata',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    // 1:1 with media_items (ADR-018): unique FK, cascade on the hard delete that never
    // happens (tombstone-not-delete keeps metadata alive past a parent tombstone).
    mediaItemId: uuid('media_item_id')
      .notNull()
      .references(() => mediaItems.id, { onDelete: 'cascade' }),
    // Ratings + vote counts. numeric renders as a string in JS (drizzle default) — the API
    // coerces to number. Radarr supplies imdb + tmdb (+ RT tomatometer); Sonarr/Lidarr
    // supply a single community rating mapped to the tmdb slot (DESIGN-008 D-02).
    imdbRating: numeric('imdb_rating', { precision: 3, scale: 1 }), // 0.0..10.0
    imdbVotes: integer('imdb_votes'),
    tmdbRating: numeric('tmdb_rating', { precision: 4, scale: 1 }),
    tmdbVotes: integer('tmdb_votes'),
    rtTomatometer: integer('rt_tomatometer'), // 0..100 critics (Radarr rottenTomatoes.value)
    rtPopcorn: integer('rt_popcorn'), // 0..100 audience — no *arr source; TMDB/TVDB can't supply
    runtimeMinutes: integer('runtime_minutes'),
    resolution: text('resolution').$type<Resolution>(), // CHECK: RESOLUTIONS (D-02, approximate)
    genres: jsonb('genres').$type<string[]>().notNull().default([]),
    arrAddedAt: timestamp('arr_added_at', { withTimezone: true }), // *arr `added`
    // ADR-051 C-05 / DESIGN-026 D-05 (PLAN-029) — the canonical Date RELEASED for a ledger item, the
    // second must-have date dimension the walls surface alongside Date Added (arr_added_at). Populated by
    // the metadata harvest from the *arr list: Radarr `digitalRelease ?? inCinemas ?? physicalRelease`,
    // Sonarr `firstAired`; Lidarr artists have no release date → null (they mis-sort NULLS-LAST like every
    // other nullable sort — the D-09 keyset already handles it). Kavita books have no list date; ABS
    // release date rides books_items.released_at (its own engine). Nullable — an unharvested/date-less row
    // is honest null, never a fabricated Jan-1 value derived from `year`.
    releasedAt: timestamp('released_at', { withTimezone: true }),
    // Watch-stats, unified across the three Tautulli instances (addendum): SUM / MAX.
    playCount: integer('play_count'),
    lastViewedAt: timestamp('last_viewed_at', { withTimezone: true }),
    // DESIGN-010 D-12 — the cross-server watch-VISIBILITY pair the trash walls + item detail card
    // surface ("Last watched on <server> · <Mon YYYY>"). last_watched_at is the SAME max-across-all-
    // three-Tautulli-histories instant as last_viewed_at above (full history, TV rolled up to the
    // show), stored alongside last_watched_server (the winning estate slug) so the timestamp and its
    // origin server are always written together. INFO ONLY: recentlyWatched (≤30d) + the guardian
    // keep still derive from last_viewed_at — these columns change no protection semantics.
    lastWatchedAt: timestamp('last_watched_at', { withTimezone: true }),
    lastWatchedServer: text('last_watched_server'), // haynesops | hayneskube | haynestower
    // Parsed *arr-tag semantics (DESIGN-008 D-07): requester tags (`\d+-<user>`) → a KEEP
    // signal; all other tags → the auto-collection provenance. Raw media_items.arr_tags is
    // untouched; these are the structured, filterable projections.
    requesters: jsonb('requesters').$type<string[]>().notNull().default([]),
    sourceCollections: jsonb('source_collections').$type<string[]>().notNull().default([]),
    // Poster PROXY reference (ADR-019 — never stored): posterSource picks the upstream
    // (owning *arr MediaCover variant vs TMDB CDN); posterRef is the *arr relative variant
    // path (carries ?lastWrite for the ETag) OR the tmdb poster_path. Both null ⇒ KindIcon.
    posterSource: text('poster_source').$type<PosterSource>(), // CHECK: POSTER_SOURCES
    posterRef: text('poster_ref'),
    // Which tiers contributed, e.g. {"arr":true,"tautulli":true,"maintainerr":false}. Lets
    // a partially-degraded harvest be observable without re-deriving.
    sources: jsonb('sources').$type<Record<string, boolean>>().notNull().default({}),
    // Per-instance Tautulli breakdown + Maintainerr props + any harvested-but-unmodeled fields.
    extra: jsonb('extra').$type<Record<string, unknown>>().notNull().default({}),
    // Refresh staleness key (D-03): rows with fetched_at older than the threshold re-harvest.
    fetchedAt: timestamp('fetched_at', { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('media_metadata_media_item_unique').on(t.mediaItemId),
    check(
      'media_metadata_resolution_enum',
      sql`${t.resolution} IS NULL OR ${t.resolution} = ANY (ARRAY[${sql.raw(RESOLUTIONS_SQL_LIST)}])`,
    ),
    check(
      'media_metadata_poster_source_enum',
      sql`${t.posterSource} IS NULL OR ${t.posterSource} = ANY (ARRAY[${sql.raw(POSTER_SOURCES_SQL_LIST)}])`,
    ),
    // The refresh scan (D-03) selects stale/missing rows by fetched_at.
    index('media_metadata_fetched_at_idx').on(t.fetchedAt),
  ],
);

export type MediaMetadataRow = typeof mediaMetadata.$inferSelect;
export type MediaMetadataInsert = typeof mediaMetadata.$inferInsert;
