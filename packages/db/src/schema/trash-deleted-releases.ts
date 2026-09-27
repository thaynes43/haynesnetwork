import {
  pgTable,
  uuid,
  text,
  integer,
  bigint,
  boolean,
  timestamp,
  check,
  index,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { mediaItems } from './media-items';
import { trashBatchItems } from './trash-batch-items';
import {
  DELETED_RELEASE_ARR_KINDS,
  DELETED_RELEASE_IDENTITY_SOURCES,
  DELETED_RELEASE_ORIGINS,
  DELETED_RELEASE_STATES,
  DELETED_RELEASE_TERM_CONFIDENCES,
  type DeletedReleaseArrKind,
  type DeletedReleaseIdentitySource,
  type DeletedReleaseOrigin,
  type DeletedReleaseState,
  type DeletedReleaseTermConfidence,
} from './enums';

const sqlList = (values: readonly string[]) => values.map((v) => `'${v}'`).join(',');

/**
 * ADR-093 C-07 / DESIGN-052 D-05 / D-11 (PLAN-072, migration 0081) — the DELETED-RELEASE RECORD (T-264): the identity
 * of a release the Trash sweep or Expedite is about to delete (release name, group, quality, size, file name), and
 * the "must not contain" term the Release Block (T-265) derives from it. Recorded `in_flight` before the delete,
 * `active` only once the *arr no longer has the item (D-14), `abandoned` when the delete did not happen, `expired`
 * after 365 days, `pruned` past the 3,000-term cap.
 *
 * NO URL IS EVER STORED: NZB and download URLs carry indexer API keys. Written ONLY by the @hnet/domain release-block
 * single-writers (the no-direct-state-writes guard covers it).
 */
export const trashDeletedReleases = pgTable(
  'trash_deleted_releases',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    arrKind: text('arr_kind').$type<DeletedReleaseArrKind>().notNull(),
    arrItemId: integer('arr_item_id'),
    mediaItemId: uuid('media_item_id').references(() => mediaItems.id, { onDelete: 'set null' }),
    batchItemId: uuid('batch_item_id').references(() => trashBatchItems.id, {
      onDelete: 'set null',
    }),
    tmdbId: integer('tmdb_id'),
    tvdbId: integer('tvdb_id'),
    imdbId: text('imdb_id'),
    title: text('title').notNull(),
    year: integer('year'),
    season: integer('season'),
    identitySource: text('identity_source').$type<DeletedReleaseIdentitySource>().notNull(),
    releaseTitle: text('release_title'),
    releaseGroup: text('release_group'),
    /** The *arr quality name, e.g. `Remux-2160p`. */
    quality: text('quality'),
    resolution: integer('resolution'),
    sizeBytes: bigint('size_bytes', { mode: 'number' }),
    fileName: text('file_name'),
    indexer: text('indexer'),
    /** The term's year alternation (D-12). */
    years: integer('years')
      .array()
      .notNull()
      .default(sql`'{}'::integer[]`),
    term: text('term'),
    termConfidence: text('term_confidence').$type<DeletedReleaseTermConfidence>(),
    state: text('state').$type<DeletedReleaseState>().notNull().default('in_flight'),
    origin: text('origin').$type<DeletedReleaseOrigin>().notNull(),
    recordedAt: timestamp('recorded_at', { withTimezone: true }).notNull().defaultNow(),
    activatedAt: timestamp('activated_at', { withTimezone: true }),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    endedAt: timestamp('ended_at', { withTimezone: true }),
    /** D-23 — a re-add of this title was seen, and whether any of its grabs matched the term. */
    readdSeenAt: timestamp('readd_seen_at', { withTimezone: true }),
    readdSameRelease: boolean('readd_same_release'),
  },
  (t) => [
    index('trash_deleted_releases_arr_state_idx').on(t.arrKind, t.state),
    index('trash_deleted_releases_media_item_idx').on(t.mediaItemId),
    index('trash_deleted_releases_tmdb_idx').on(t.tmdbId),
    index('trash_deleted_releases_tvdb_idx').on(t.tvdbId),
    check(
      'trash_deleted_releases_arr_kind_enum',
      sql`${t.arrKind} = ANY (ARRAY[${sql.raw(sqlList(DELETED_RELEASE_ARR_KINDS))}])`,
    ),
    check(
      'trash_deleted_releases_identity_source_enum',
      sql`${t.identitySource} = ANY (ARRAY[${sql.raw(sqlList(DELETED_RELEASE_IDENTITY_SOURCES))}])`,
    ),
    check(
      'trash_deleted_releases_term_confidence_enum',
      sql`${t.termConfidence} IS NULL OR ${t.termConfidence} = ANY (ARRAY[${sql.raw(sqlList(DELETED_RELEASE_TERM_CONFIDENCES))}])`,
    ),
    check(
      'trash_deleted_releases_state_enum',
      sql`${t.state} = ANY (ARRAY[${sql.raw(sqlList(DELETED_RELEASE_STATES))}])`,
    ),
    check(
      'trash_deleted_releases_origin_enum',
      sql`${t.origin} = ANY (ARRAY[${sql.raw(sqlList(DELETED_RELEASE_ORIGINS))}])`,
    ),
  ],
);

export type TrashDeletedReleaseRow = typeof trashDeletedReleases.$inferSelect;
export type TrashDeletedReleaseInsert = typeof trashDeletedReleases.$inferInsert;
