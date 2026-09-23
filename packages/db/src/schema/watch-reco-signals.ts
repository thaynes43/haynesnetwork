import {
  pgTable,
  bigserial,
  bigint,
  text,
  integer,
  smallint,
  timestamp,
  check,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { watchAccounts } from './watch-accounts';
import {
  WATCH_RECO_SOURCES,
  WATCH_TITLE_KINDS,
  type WatchRecoSource,
  type WatchTitleKind,
} from './enums';

const SOURCES_SQL_LIST = WATCH_RECO_SOURCES.map((s) => `'${s}'`).join(',');
const KINDS_SQL_LIST = WATCH_TITLE_KINDS.map((k) => `'${k}'`).join(',');

/**
 * ADR-089 / DESIGN-049 D-07 + D-17 (PLAN-068) — the recommendation INPUT cache: external lists the
 * deterministic scorer reads at request time (recommendations themselves are never precomputed).
 *
 * - `watchlist` — the owner's plex.tv watchlist (discover provider, owner token), `rank` = its position
 *   in the provider's default order (newest-watchlisted first). The list endpoint carries no watchlist
 *   timestamp (verified live 2026-09-23), so `added_at` stays NULL unless a later reader fetches it.
 * - `tmdb_seed` — page one of TMDB `/{tv|movie}/{id}/recommendations` for up to 15 seed titles, refreshed
 *   when older than 20 hours; `seed_title_key` / `seed_title` name the seed ("because you watched …").
 *
 * Each run REPLACES one source's rows for the account in one transaction (delete + insert), so the DELETE
 * family is guarded too. Written ONLY by the @hnet/domain signal writer — guard-listed. A rebuildable
 * cache: no audit row (the media_plex_matches class).
 */
export const watchRecoSignals = pgTable(
  'watch_reco_signals',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    plexAccountId: bigint('plex_account_id', { mode: 'number' })
      .notNull()
      .references(() => watchAccounts.plexAccountId, { onDelete: 'cascade' }),
    source: text('source').$type<WatchRecoSource>().notNull(),
    kind: text('kind').$type<WatchTitleKind>().notNull(),
    title: text('title').notNull(),
    year: integer('year'),
    tmdbId: integer('tmdb_id'),
    tvdbId: integer('tvdb_id'),
    imdbId: text('imdb_id'),
    plexGuid: text('plex_guid'),
    /** `tmdb_seed` only: the owner's title that produced this recommendation. */
    seedTitleKey: text('seed_title_key'),
    seedTitle: text('seed_title'),
    /** Position in the source list (the provider's order). */
    rank: smallint('rank').notNull(),
    /** Watchlist add time, when known. */
    addedAt: timestamp('added_at', { withTimezone: true }),
    fetchedAt: timestamp('fetched_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check('watch_reco_signals_source_enum', sql`${t.source} = ANY (ARRAY[${sql.raw(SOURCES_SQL_LIST)}])`),
    check('watch_reco_signals_kind_enum', sql`${t.kind} = ANY (ARRAY[${sql.raw(KINDS_SQL_LIST)}])`),
  ],
);

export type WatchRecoSignalRow = typeof watchRecoSignals.$inferSelect;
export type WatchRecoSignalInsert = typeof watchRecoSignals.$inferInsert;
