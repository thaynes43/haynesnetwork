import {
  pgTable,
  uuid,
  text,
  integer,
  boolean,
  jsonb,
  timestamp,
  check,
  index,
  primaryKey,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import {
  WATCHLIST_ACCOUNT_CLASSES,
  WATCHLIST_ACCOUNT_STATUSES,
  WATCHLIST_ITEM_KINDS,
  WATCHLIST_REGISTRY_RUN_FAILURES,
  WATCHLIST_REGISTRY_RUN_STATUSES,
  WATCHLIST_REGISTRY_TRIGGERS,
  WATCHLIST_SOURCE_OUTCOMES,
  WATCHLIST_SOURCE_STATUSES,
  WATCHLIST_SOURCES,
  type WatchlistAccountClass,
  type WatchlistAccountStatus,
  type WatchlistItemKind,
  type WatchlistRegistryRunFailure,
  type WatchlistRegistryRunStatus,
  type WatchlistRegistryTrigger,
  type WatchlistSource,
  type WatchlistSourceOutcome,
  type WatchlistSourceStatus,
} from './enums';

const sqlList = (values: readonly string[]) => values.map((v) => `'${v}'`).join(',');

/**
 * ADR-093 / DESIGN-052 D-04 / D-05 (PLAN-072, migration 0081) — the WATCHLIST REGISTRY (T-261): every watchlist the
 * app can reach, read every 15 minutes (and inline before a sweep deletes), stored per account and per source so a
 * failed read of one source carries that source's last list forward instead of dropping it.
 *
 * Privacy (ADR-093 C-06): other people's lists are guard input only. No username, email, token or title is stored:
 * an account is its plex.tv account id and class, an item is a discover id with its external ids. Nothing here is
 * shown or logged per person.
 *
 * Written ONLY by the @hnet/domain watchlist-registry single-writer (`refreshWatchlistRegistry`); every table joins
 * the no-direct-state-writes guard. Derived, rebuildable state, so the writer appends no ledger/audit row (the
 * `trash_candidates` exemption); each refresh's trail is its `watchlist_registry_runs` row.
 */

/** One row per refresh (D-04). The Registry Gate (D-07) reads the newest `ok` row. Pruned after 7 days. */
export const watchlistRegistryRuns = pgTable(
  'watchlist_registry_runs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    trigger: text('trigger').$type<WatchlistRegistryTrigger>().notNull(),
    status: text('status').$type<WatchlistRegistryRunStatus>().notNull().default('running'),
    failure: text('failure').$type<WatchlistRegistryRunFailure>(),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
    /** Counts only (per class and status, per source and outcome, …) — never a name or a title. */
    counts: jsonb('counts').$type<Record<string, unknown>>().notNull().default({}),
  },
  (t) => [
    index('watchlist_registry_runs_status_finished_idx').on(t.status, t.finishedAt.desc()),
    check(
      'watchlist_registry_runs_trigger_enum',
      sql`${t.trigger} = ANY (ARRAY[${sql.raw(sqlList(WATCHLIST_REGISTRY_TRIGGERS))}])`,
    ),
    check(
      'watchlist_registry_runs_status_enum',
      sql`${t.status} = ANY (ARRAY[${sql.raw(sqlList(WATCHLIST_REGISTRY_RUN_STATUSES))}])`,
    ),
    check(
      'watchlist_registry_runs_failure_enum',
      sql`${t.failure} IS NULL OR ${t.failure} = ANY (ARRAY[${sql.raw(sqlList(WATCHLIST_REGISTRY_RUN_FAILURES))}])`,
    ),
  ],
);

/**
 * One row per account the registry knows (D-01): the owner, every plex.tv roster account, and any Seerr user whose
 * plex id is not in the roster (`seerr_only`). Keyed by the plex.tv account id. `status` is DERIVED from the
 * account's sources (D-04) and kept for the counts and the Watchlists card. An account missing from the roster is
 * stamped `left_at` and keeps protecting its titles for 24 hours before it is deleted (its sources and items
 * cascade).
 */
export const watchlistRegistryAccounts = pgTable(
  'watchlist_registry_accounts',
  {
    plexAccountId: text('plex_account_id').primaryKey(),
    class: text('class').$type<WatchlistAccountClass>().notNull(),
    /** From the roster `thumb` (`https://plex.tv/users/<uuid>/avatar`): the community read's key. */
    plexUuid: text('plex_uuid'),
    seerrUserId: integer('seerr_user_id'),
    status: text('status').$type<WatchlistAccountStatus>().notNull().default('never_read'),
    firstSeenAt: timestamp('first_seen_at', { withTimezone: true }).notNull().defaultNow(),
    leftAt: timestamp('left_at', { withTimezone: true }),
    /** Distinct discover ids across the account's sources. */
    itemCount: integer('item_count').notNull().default(0),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check(
      'watchlist_registry_accounts_class_enum',
      sql`${t.class} = ANY (ARRAY[${sql.raw(sqlList(WATCHLIST_ACCOUNT_CLASSES))}])`,
    ),
    check(
      'watchlist_registry_accounts_status_enum',
      sql`${t.status} = ANY (ARRAY[${sql.raw(sqlList(WATCHLIST_ACCOUNT_STATUSES))}])`,
    ),
  ],
);

/**
 * The per-(account, source) state (D-04): failures are per source, so one failing source never changes what another
 * contributes, blocks or freezes. `last_ok_count` is how many titles the last ok read returned ("had titles"),
 * `failing_since` starts the 24 h carry and the 72 h `unreadable` clocks, `hidden_logged_at` makes `account_hidden`
 * log once per transition. `last_error_class` is an error CLASS, never a response body.
 */
export const watchlistRegistrySources = pgTable(
  'watchlist_registry_sources',
  {
    plexAccountId: text('plex_account_id')
      .notNull()
      .references(() => watchlistRegistryAccounts.plexAccountId, { onDelete: 'cascade' }),
    source: text('source').$type<WatchlistSource>().notNull(),
    status: text('status').$type<WatchlistSourceStatus>().notNull().default('never_read'),
    lastOutcome: text('last_outcome').$type<WatchlistSourceOutcome>().notNull(),
    lastErrorClass: text('last_error_class'),
    lastAttemptAt: timestamp('last_attempt_at', { withTimezone: true }).notNull(),
    lastOkAt: timestamp('last_ok_at', { withTimezone: true }),
    failingSince: timestamp('failing_since', { withTimezone: true }),
    lastOkCount: integer('last_ok_count'),
    emptyUnverified: boolean('empty_unverified').notNull().default(false),
    hiddenLoggedAt: timestamp('hidden_logged_at', { withTimezone: true }),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.plexAccountId, t.source] }),
    check(
      'watchlist_registry_sources_source_enum',
      sql`${t.source} = ANY (ARRAY[${sql.raw(sqlList(WATCHLIST_SOURCES))}])`,
    ),
    check(
      'watchlist_registry_sources_status_enum',
      sql`${t.status} = ANY (ARRAY[${sql.raw(sqlList(WATCHLIST_SOURCE_STATUSES))}])`,
    ),
    check(
      'watchlist_registry_sources_outcome_enum',
      sql`${t.lastOutcome} = ANY (ARRAY[${sql.raw(sqlList(WATCHLIST_SOURCE_OUTCOMES))}])`,
    ),
  ],
);

/**
 * One row per title per account per source (D-05). Keyed by the plex.tv DISCOVER id (24 hex digits, D-03), which all
 * three sources give; the external ids are kept when the source carries them (the owner's rows: tmdb/tvdb/imdb;
 * Seerr's: tmdb) and otherwise mapped through `plex_discover_ids`. A failed read never removes a row (D-04).
 */
export const watchlistRegistryItems = pgTable(
  'watchlist_registry_items',
  {
    plexAccountId: text('plex_account_id')
      .notNull()
      .references(() => watchlistRegistryAccounts.plexAccountId, { onDelete: 'cascade' }),
    discoverId: text('discover_id').notNull(),
    kind: text('kind').$type<WatchlistItemKind>().notNull(),
    source: text('source').$type<WatchlistSource>().notNull(),
    tmdbId: integer('tmdb_id'),
    tvdbId: integer('tvdb_id'),
    imdbId: text('imdb_id'),
    firstSeenAt: timestamp('first_seen_at', { withTimezone: true }).notNull().defaultNow(),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.plexAccountId, t.discoverId, t.source] }),
    index('watchlist_registry_items_discover_idx').on(t.discoverId),
    index('watchlist_registry_items_kind_tmdb_idx').on(t.kind, t.tmdbId),
    index('watchlist_registry_items_kind_tvdb_idx').on(t.kind, t.tvdbId),
    check(
      'watchlist_registry_items_kind_enum',
      sql`${t.kind} = ANY (ARRAY[${sql.raw(sqlList(WATCHLIST_ITEM_KINDS))}])`,
    ),
    check(
      'watchlist_registry_items_source_enum',
      sql`${t.source} = ANY (ARRAY[${sql.raw(sqlList(WATCHLIST_SOURCES))}])`,
    ),
    check('watchlist_registry_items_discover_id_format', sql`${t.discoverId} ~ '^[0-9a-f]{24}$'`),
  ],
);

/**
 * D-03 — the persistent discover-id → external-id map, filled from
 * `discover.provider.plex.tv/library/metadata/{id}?includeGuids=1` (at most 200 new lookups per refresh). A mapping
 * never changes once found; an id plex.tv answers 404 for is stamped `not_found_at` and tried again after 7 days.
 * Written only by the watchlist-registry single-writer.
 */
export const plexDiscoverIds = pgTable(
  'plex_discover_ids',
  {
    discoverId: text('discover_id').primaryKey(),
    kind: text('kind').$type<WatchlistItemKind>(),
    tmdbId: integer('tmdb_id'),
    tvdbId: integer('tvdb_id'),
    imdbId: text('imdb_id'),
    resolvedAt: timestamp('resolved_at', { withTimezone: true }),
    notFoundAt: timestamp('not_found_at', { withTimezone: true }),
    attempts: integer('attempts').notNull().default(0),
  },
  (t) => [
    check('plex_discover_ids_discover_id_format', sql`${t.discoverId} ~ '^[0-9a-f]{24}$'`),
    check(
      'plex_discover_ids_kind_enum',
      sql`${t.kind} IS NULL OR ${t.kind} = ANY (ARRAY[${sql.raw(sqlList(WATCHLIST_ITEM_KINDS))}])`,
    ),
  ],
);

export type WatchlistRegistryRunRow = typeof watchlistRegistryRuns.$inferSelect;
export type WatchlistRegistryAccountRow = typeof watchlistRegistryAccounts.$inferSelect;
export type WatchlistRegistrySourceRow = typeof watchlistRegistrySources.$inferSelect;
export type WatchlistRegistryItemRow = typeof watchlistRegistryItems.$inferSelect;
export type PlexDiscoverIdRow = typeof plexDiscoverIds.$inferSelect;
