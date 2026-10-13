import { pgTable, integer, smallint, text, timestamp, uuid, check, index } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { users } from './users';
import { mediaItems } from './media-items';
import {
  SEERR_ISSUE_MEDIA_TYPES,
  SEERR_ISSUE_STATUSES,
  SEERR_ISSUE_TYPES,
  type SeerrIssueMediaType,
  type SeerrIssueStatus,
} from './enums';

const sqlList = (values: readonly string[]) => values.map((v) => `'${v}'`).join(',');

/**
 * ADR-111 C-01 / DESIGN-055 D-10 (PLAN-077 P3, migration 0100) — the Seerr Issue mirror (T-311): one row per Seerr
 * issue, keyed by Seerr's own id. Seerr stays the source of truth: the `seerr-issues` sync (every 10 minutes) and an
 * issue webhook (which only triggers a fresh read) write the Seerr columns; a webhook body is never state. The staff
 * columns (ADR-112 C-02, D-12) are the app's own: "fixed by hand" and the note naming what was missing. Only the
 * packages/domain/src/seerr-issues.ts single writer changes a row (the no-direct-state-writes guard).
 *
 * `problem_season` / `problem_episode` keep Seerr's numbers: 0 means the whole title or the whole season.
 * `media_item_id` is the ledger item (movie by tmdb, TV by tvdb, the DESIGN-005 D-14 rule) and `target_child_id` the
 * Sonarr episode, both null until known. The reporter's email is read only to match `reporter_user_id`; it is never
 * stored. `reporter_name` (the Plex name Seerr shows) is shown to admins only (ADR-111 C-02). `removed_at` is set when
 * a complete read no longer lists the issue (deleted in Seerr), and cleared if it comes back.
 */
export const seerrIssues = pgTable(
  'seerr_issues',
  {
    seerrIssueId: integer('seerr_issue_id').primaryKey(),
    issueType: smallint('issue_type').notNull(),
    status: text('status').$type<SeerrIssueStatus>().notNull(),
    problemSeason: integer('problem_season').notNull().default(0),
    problemEpisode: integer('problem_episode').notNull().default(0),
    mediaType: text('media_type').$type<SeerrIssueMediaType>(),
    tmdbId: integer('tmdb_id'),
    tvdbId: integer('tvdb_id'),
    mediaItemId: uuid('media_item_id').references(() => mediaItems.id, { onDelete: 'set null' }),
    targetChildId: integer('target_child_id'),
    reporterSeerrUserId: integer('reporter_seerr_user_id'),
    reporterName: text('reporter_name'),
    reporterUserId: uuid('reporter_user_id').references(() => users.id, { onDelete: 'set null' }),
    message: text('message'),
    commentCount: integer('comment_count').notNull().default(0),
    seerrCreatedAt: timestamp('seerr_created_at', { withTimezone: true }).notNull(),
    seerrUpdatedAt: timestamp('seerr_updated_at', { withTimezone: true }).notNull(),
    readAt: timestamp('read_at', { withTimezone: true }).notNull(),
    removedAt: timestamp('removed_at', { withTimezone: true }),
    staffHandledAt: timestamp('staff_handled_at', { withTimezone: true }),
    staffHandledBy: uuid('staff_handled_by').references(() => users.id, { onDelete: 'set null' }),
    staffNote: text('staff_note'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check('seerr_issues_status_enum', sql`${t.status} = ANY (ARRAY[${sql.raw(sqlList(SEERR_ISSUE_STATUSES))}])`),
    check('seerr_issues_type_enum', sql`${t.issueType} = ANY (ARRAY[${sql.raw(SEERR_ISSUE_TYPES.join(','))}])`),
    check(
      'seerr_issues_media_type_enum',
      sql`${t.mediaType} IS NULL OR ${t.mediaType} = ANY (ARRAY[${sql.raw(sqlList(SEERR_ISSUE_MEDIA_TYPES))}])`,
    ),
    check('seerr_issues_problem_nonnegative', sql`${t.problemSeason} >= 0 AND ${t.problemEpisode} >= 0`),
    // "Fixed by hand" always carries its note (D-12: the note names the missing capability).
    check(
      'seerr_issues_handled_has_note',
      sql`${t.staffHandledAt} IS NULL OR (${t.staffNote} IS NOT NULL AND length(btrim(${t.staffNote})) > 0)`,
    ),
    index('seerr_issues_item_idx').on(t.mediaItemId),
    index('seerr_issues_status_idx').on(t.status),
    index('seerr_issues_created_idx').on(t.seerrCreatedAt.desc()),
  ],
);

export type SeerrIssueRow = typeof seerrIssues.$inferSelect;
export type SeerrIssueInsert = typeof seerrIssues.$inferInsert;
