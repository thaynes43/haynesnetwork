import { pgTable, uuid, text, integer, bigint, timestamp, check, index, uniqueIndex } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import {
  DELETED_RELEASE_ARR_KINDS,
  LEGACY_RELEASE_RECORD_KINDS,
  type DeletedReleaseArrKind,
  type LegacyReleaseRecordKind,
} from './enums';

const sqlList = (values: readonly string[]) => values.map((v) => `'${v}'`).join(',');

/**
 * ADR-117 / DESIGN-052 D-29 (migration 0110) — LEGACY RELEASE NAMES: the release names the Radarr and Sonarr
 * databases from before the 2026-07-03 move recorded, keyed by the title's own id (`external_id`: the TMDB id on
 * Radarr, the TVDB id on Sonarr). `record_kind` says what the old database held: a `grabbed`, `imported` or `failed`
 * history event, or a `file` record carrying the file's original release name and its exact byte size. The Release
 * Block reads it before a delete: every name of the title gets a term, and a file on disk counts as named when a
 * `file` row of its id has the identical byte size.
 *
 * NO URL IS EVER STORED (the CHECK refuses a name containing "://"), and no indexer, download id, setting or path.
 * `release_name` is the name as the old database stored it, never trimmed. `dedupe_key` (a hash of the row's own
 * fields) makes a second load add nothing. Written ONLY by the @hnet/domain legacy-release-names loader (the
 * no-direct-state-writes guard covers it); rows are never updated.
 */
export const legacyReleaseNames = pgTable(
  'legacy_release_names',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    arrKind: text('arr_kind').$type<DeletedReleaseArrKind>().notNull(),
    /** The TMDB id (Radarr) or TVDB id (Sonarr): identity that survived the rebuild. */
    externalId: integer('external_id').notNull(),
    recordKind: text('record_kind').$type<LegacyReleaseRecordKind>().notNull(),
    /** The posted release name as the old database stored it. Never a URL. */
    releaseName: text('release_name').notNull(),
    /** `file`: the file's byte size (required). `grabbed`: the size the indexer announced, when recorded. */
    sizeBytes: bigint('size_bytes', { mode: 'number' }),
    /** The event's date (a history row), or the file's date added. */
    occurredAt: timestamp('occurred_at', { withTimezone: true }),
    releaseGroup: text('release_group'),
    /** Sonarr only: the file's season, or the lowest season a history row covers. */
    season: integer('season'),
    /** `file` rows: the quality name the old database held. */
    quality: text('quality'),
    /** The title as the old *arr had it (for a person reading the table; never matched on). */
    title: text('title'),
    dedupeKey: text('dedupe_key').notNull(),
    loadedAt: timestamp('loaded_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check(
      'legacy_release_names_arr_kind_enum',
      sql`${t.arrKind} = ANY (ARRAY[${sql.raw(sqlList(DELETED_RELEASE_ARR_KINDS))}])`,
    ),
    check(
      'legacy_release_names_record_kind_enum',
      sql`${t.recordKind} = ANY (ARRAY[${sql.raw(sqlList(LEGACY_RELEASE_RECORD_KINDS))}])`,
    ),
    check('legacy_release_names_external_id_positive', sql`${t.externalId} > 0`),
    check(
      'legacy_release_names_name_not_url',
      sql`length(btrim(${t.releaseName})) > 0 AND position('://' in ${t.releaseName}) = 0`,
    ),
    check(
      'legacy_release_names_file_has_size',
      sql`${t.recordKind} <> 'file' OR (${t.sizeBytes} IS NOT NULL AND ${t.sizeBytes} > 0)`,
    ),
    uniqueIndex('legacy_release_names_dedupe_uq').on(t.dedupeKey),
    index('legacy_release_names_title_idx').on(t.arrKind, t.externalId),
  ],
);

/**
 * ADR-117 / DESIGN-052 D-29 (migration 0110) — LEGACY DOWNLOAD JOBS: the two old SABnzbd histories (name, bytes,
 * completion time, category, status). They carry no title id, so they are a secondary source: a job the D-15 size
 * rule matches to a movie adds a term and never makes that movie's file count as named. NO URL IS EVER STORED.
 * Written ONLY by the @hnet/domain legacy-release-names loader; rows are never updated.
 */
export const legacyDownloadJobs = pgTable(
  'legacy_download_jobs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** Which old history the job came from (the export's own label). */
    source: text('source').notNull(),
    name: text('name').notNull(),
    bytes: bigint('bytes', { mode: 'number' }).notNull(),
    completedAt: timestamp('completed_at', { withTimezone: true }).notNull(),
    category: text('category'),
    status: text('status'),
    dedupeKey: text('dedupe_key').notNull(),
    loadedAt: timestamp('loaded_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check(
      'legacy_download_jobs_name_not_url',
      sql`length(btrim(${t.name})) > 0 AND position('://' in ${t.name}) = 0`,
    ),
    check('legacy_download_jobs_bytes_positive', sql`${t.bytes} > 0`),
    uniqueIndex('legacy_download_jobs_dedupe_uq').on(t.dedupeKey),
    index('legacy_download_jobs_bytes_idx').on(t.bytes),
  ],
);

export type LegacyReleaseNameRow = typeof legacyReleaseNames.$inferSelect;
export type NewLegacyReleaseNameRow = typeof legacyReleaseNames.$inferInsert;
export type LegacyDownloadJobRow = typeof legacyDownloadJobs.$inferSelect;
export type NewLegacyDownloadJobRow = typeof legacyDownloadJobs.$inferInsert;
