import { pgTable, uuid, text, integer, real, timestamp, check, index, uniqueIndex } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { mediaItems } from './media-items';
import {
  TITLE_CHECK_ORIGINS,
  TITLE_CHECK_VERDICTS,
  type TitleCheckOrigin,
  type TitleCheckVerdict,
} from './enums';

const sqlList = (values: readonly string[]) => values.map((v) => `'${v}'`).join(',');

/**
 * ADR-110 C-03 / DESIGN-055 D-05 (PLAN-077 P4, migration 0101) — the Title Check (T-305): one row per imported Sonarr
 * episode file, the Title Evidence (T-304) of the name it was imported under against the episodes Sonarr filed it on.
 * A census: nothing here ever moves a file. A `disagrees` row whose file is still on its episodes is a flag on the title
 * page that opens the Episode Re-map (D-04) pre-filled; `cleared_at` is set once the file has left those episodes (a
 * re-map, an upgrade, a delete), which closes the flag.
 *
 * `episode_ids` are every episode the file holds (a multi-episode file); `episode_id` the first of them (and
 * `episode_number` its number, `best_episode_number` the best episode's, so a report reads without Sonarr). `score` is the
 * mapped episodes' score, `best_score` the best episode's. `source_title` is the name judged (the history record's
 * `sourceTitle`, else the file's scene name). One row per (instance, episode_file_id): a re-run updates it in place.
 * Only the packages/domain/src/title-check.ts single writer changes a row (the no-direct-state-writes guard).
 */
export const titleChecks = pgTable(
  'title_checks',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    instance: text('instance').notNull().default('sonarr'),
    seriesId: integer('series_id').notNull(),
    mediaItemId: uuid('media_item_id').references(() => mediaItems.id, { onDelete: 'set null' }),
    seasonNumber: integer('season_number').notNull(),
    episodeId: integer('episode_id').notNull(),
    episodeNumber: integer('episode_number').notNull(),
    episodeIds: integer('episode_ids').array().notNull(),
    episodeFileId: integer('episode_file_id').notNull(),
    sourceTitle: text('source_title').notNull(),
    verdict: text('verdict').$type<TitleCheckVerdict>().notNull(),
    bestEpisodeId: integer('best_episode_id'),
    bestEpisodeNumber: integer('best_episode_number'),
    score: real('score'),
    bestScore: real('best_score'),
    evidenceVersion: integer('evidence_version').notNull(),
    origin: text('origin').$type<TitleCheckOrigin>().notNull(),
    importedAt: timestamp('imported_at', { withTimezone: true }).notNull(),
    clearedAt: timestamp('cleared_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check('title_checks_instance_enum', sql`${t.instance} = 'sonarr'`),
    check('title_checks_verdict_enum', sql`${t.verdict} = ANY (ARRAY[${sql.raw(sqlList(TITLE_CHECK_VERDICTS))}])`),
    check('title_checks_origin_enum', sql`${t.origin} = ANY (ARRAY[${sql.raw(sqlList(TITLE_CHECK_ORIGINS))}])`),
    check('title_checks_episode_ids_nonempty', sql`cardinality(${t.episodeIds}) > 0`),
    uniqueIndex('title_checks_file_uq').on(t.instance, t.episodeFileId),
    index('title_checks_series_idx').on(t.seriesId, t.seasonNumber),
    index('title_checks_item_idx').on(t.mediaItemId),
    index('title_checks_imported_idx').on(t.importedAt.desc()),
    // The open flags: what the title page and the hourly re-validation read.
    index('title_checks_open_flag_idx')
      .on(t.seriesId)
      .where(sql`${t.verdict} = 'disagrees' AND ${t.clearedAt} IS NULL`),
  ],
);

export type TitleCheckRow = typeof titleChecks.$inferSelect;
export type TitleCheckInsert = typeof titleChecks.$inferInsert;
