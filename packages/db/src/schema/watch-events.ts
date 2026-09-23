import {
  pgTable,
  bigserial,
  bigint,
  text,
  integer,
  smallint,
  boolean,
  timestamp,
  check,
  unique,
  index,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { watchAccounts } from './watch-accounts';
import {
  PLEX_SERVER_SLUGS,
  WATCH_EVENT_KINDS,
  type PlexServerSlug,
  type WatchEventKind,
} from './enums';

const INSTANCES_SQL_LIST = PLEX_SERVER_SLUGS.map((s) => `'${s}'`).join(',');
const KINDS_SQL_LIST = WATCH_EVENT_KINDS.map((k) => `'${k}'`).join(',');

/**
 * ADR-088 / DESIGN-049 D-07 (PLAN-068) — the APPEND-ONLY Watch Event log (T-243): one row per Tautulli
 * history row of a tracked account, on all three instances (HaynesOps, HaynesKube, HaynesTower).
 *
 * Identity is (`instance`, `tautulli_row_id`) and the `watch` sync inserts-or-ignores on it, so the log is
 * never capped and never re-read (ADR-088 C-02 — the household harvest's 10k window does not apply here).
 * `tautulli_row_id` is the history row's `row_id`, verified live 2026-09-23 as the stable per-row id under
 * `grouping=0` (`id` mirrors it; `reference_id` is the GROUP's first row and repeats across rows).
 *
 * `item_guid` / `show_guid` are Plex guids (`plex://episode/…`, `plex://show/…`) — identical on every
 * server, unlike `rating_key` / `grandparent_rating_key`, which are server-local and perishable
 * (Maintainerr deletes watched media) and are kept for diagnostics only, never as identity. `show_guid` is
 * resolved once per (instance, grandparent key) and is NULL when Tautulli's get_metadata says the show is
 * gone (HTTP 400); the event then falls back to `show_title`.
 *
 * `watched` is Tautulli's own verdict (`watched_status = 1`, 85% on all three instances).
 *
 * Written ONLY by the @hnet/domain watch event writer (guard-listed, INSERT only — append-only like
 * poster_guard_applications). Rows are never updated or deleted.
 */
export const watchEvents = pgTable(
  'watch_events',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    plexAccountId: bigint('plex_account_id', { mode: 'number' })
      .notNull()
      .references(() => watchAccounts.plexAccountId, { onDelete: 'cascade' }),
    /** The Tautulli instance (= the Plex server of the same slug) the row came from. */
    instance: text('instance').$type<PlexServerSlug>().notNull(),
    /** Tautulli history `row_id` — unique within its instance. */
    tautulliRowId: bigint('tautulli_row_id', { mode: 'number' }).notNull(),
    kind: text('kind').$type<WatchEventKind>().notNull(),
    itemGuid: text('item_guid'),
    showGuid: text('show_guid'),
    /** The episode or movie title. */
    title: text('title').notNull(),
    /** The show title (episodes only). */
    showTitle: text('show_title'),
    season: integer('season'),
    episode: integer('episode'),
    year: integer('year'),
    ratingKey: text('rating_key'),
    grandparentRatingKey: text('grandparent_rating_key'),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull(),
    stoppedAt: timestamp('stopped_at', { withTimezone: true }),
    percentComplete: smallint('percent_complete'),
    watched: boolean('watched').notNull(),
    ingestedAt: timestamp('ingested_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('watch_events_instance_row_unique').on(t.instance, t.tautulliRowId),
    /** Recent history + the D-09 window start (newest started_at per instance). */
    index('watch_events_account_started_idx').on(t.plexAccountId, t.startedAt.desc()),
    /** Per-show event facts (plays, watched episodes, rewatch detection) and the show-guid cache. */
    index('watch_events_account_show_idx').on(t.plexAccountId, t.showGuid),
    check(
      'watch_events_instance_enum',
      sql`${t.instance} = ANY (ARRAY[${sql.raw(INSTANCES_SQL_LIST)}])`,
    ),
    check('watch_events_kind_enum', sql`${t.kind} = ANY (ARRAY[${sql.raw(KINDS_SQL_LIST)}])`),
  ],
);

export type WatchEventRow = typeof watchEvents.$inferSelect;
export type WatchEventInsert = typeof watchEvents.$inferInsert;
