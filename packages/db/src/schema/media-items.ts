import {
  pgTable,
  uuid,
  text,
  integer,
  bigint,
  boolean,
  timestamp,
  jsonb,
  check,
  unique,
  index,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { ARR_KINDS, type ArrKind } from './enums';

const ARR_KINDS_SQL_LIST = ARR_KINDS.map((k) => `'${k}'`).join(',');

/**
 * DESIGN-005 D-05 — the ledger row per *arr top-level library entity (Sonarr series,
 * Radarr movie, Lidarr artist — D-04). One-way synced from the *arrs (CLAUDE.md hard
 * rule 4); written only by the packages/domain sync writers (D-12).
 *
 * - `arr_instance_id` is a config slug ('main' today), not a FK — instance config is
 *   env-owned (D-18); a second instance is a data change, not a migration.
 * - `arr_item_id` is bookkeeping; the EXTERNAL ids are identity. A rebuilt *arr assigns
 *   new internal ids; sync re-matches by (arr_kind, arr_instance_id, external id) and
 *   updates arr_item_id in place (D-14).
 * - Profile/tag snapshots are BY NAME/LABEL — numeric ids are meaningless on a fresh
 *   instance; Restore resolves names against the live target (D-16, ADR-008).
 * - Tombstone, never delete (DDD-001 T-41): sync sets deleted_from_arr_at and keeps the
 *   row — R-41 deletion history and the R-50 restore source both require it.
 */
export const mediaItems = pgTable(
  'media_items',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    arrKind: text('arr_kind').$type<ArrKind>().notNull(),
    arrInstanceId: text('arr_instance_id').notNull().default('main'),
    arrItemId: integer('arr_item_id').notNull(), // series.id / movie.id / artist.id — NOT stable across an *arr rebuild
    // External ids — the durable identity that survives an *arr rebuild (R-50 diffing key)
    tvdbId: integer('tvdb_id'), // sonarr (required for kind)
    tmdbId: integer('tmdb_id'), // radarr (required for kind); sonarr optional extra
    imdbId: text('imdb_id'),
    musicbrainzArtistId: text('musicbrainz_artist_id'), // lidarr foreignArtistId (required for kind)
    title: text('title').notNull(),
    sortTitle: text('sort_title').notNull(),
    year: integer('year'), // null for artists
    monitored: boolean('monitored').notNull(),
    qualityProfileId: integer('quality_profile_id').notNull(),
    qualityProfileName: text('quality_profile_name').notNull(), // snapshot — Restore maps BY NAME
    metadataProfileId: integer('metadata_profile_id'), // lidarr only
    metadataProfileName: text('metadata_profile_name'), // lidarr only
    rootFolder: text('root_folder').notNull(), // rootFolderPath
    arrTags: jsonb('arr_tags').$type<string[]>().notNull().default([]), // LABEL snapshots — tag ids don't survive rebuilds
    // On-disk stats, normalized across kinds (sonarr episode files / radarr hasFile / lidarr track files)
    onDiskFileCount: integer('on_disk_file_count').notNull().default(0),
    expectedFileCount: integer('expected_file_count').notNull().default(0),
    sizeOnDisk: bigint('size_on_disk', { mode: 'number' }).notNull().default(0),
    // Kind-specific restore-fidelity extras (documented keys only — D-02 "Restore-fidelity extras"):
    //   sonarr: { seriesType, seasonFolder, monitorNewItems, status, ended }
    //   radarr: { minimumAvailability, status }
    //   lidarr: { monitorNewItems, artistType, status }
    arrAttrs: jsonb('arr_attrs').$type<Record<string, unknown>>().notNull().default({}),
    // Sync bookkeeping
    firstSeenAt: timestamp('first_seen_at', { withTimezone: true }).notNull().defaultNow(),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull().defaultNow(),
    deletedFromArrAt: timestamp('deleted_from_arr_at', { withTimezone: true }), // TOMBSTONE (T-41); null = live in the *arr
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check(
      'media_items_arr_kind_enum',
      sql`${t.arrKind} = ANY (ARRAY[${sql.raw(ARR_KINDS_SQL_LIST)}])`,
    ),
    // Every row carries the external id its kind diffs/restores by (R-50/R-51):
    check(
      'media_items_external_id_for_kind',
      sql`
      (${t.arrKind} = 'sonarr' AND ${t.tvdbId} IS NOT NULL) OR
      (${t.arrKind} = 'radarr' AND ${t.tmdbId} IS NOT NULL) OR
      (${t.arrKind} = 'lidarr' AND ${t.musicbrainzArtistId} IS NOT NULL)`,
    ),
    unique('media_items_arr_identity_unique').on(t.arrKind, t.arrInstanceId, t.arrItemId),
    index('media_items_kind_tvdb_idx').on(t.arrKind, t.tvdbId),
    index('media_items_kind_tmdb_idx').on(t.arrKind, t.tmdbId),
    index('media_items_kind_mbid_idx').on(t.arrKind, t.musicbrainzArtistId),
    index('media_items_sort_title_idx').on(t.sortTitle),
  ],
);

export type MediaItemRow = typeof mediaItems.$inferSelect;
export type MediaItemInsert = typeof mediaItems.$inferInsert;
