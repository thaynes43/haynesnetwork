import { pgTable, uuid, text, integer, timestamp, jsonb, boolean, check, index, uniqueIndex } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { mediaItems } from './media-items';

const sqlList = (values: readonly string[]) => values.map((v) => `'${v}'`).join(',');

/** ADR-114 — what moved the content: a Season Re-map, a show's Plex ordering switch, or the Second-Copy Fix. */
export const WATCH_CARRY_KINDS = ['season_remap', 'show_ordering', 'second_copy'] as const;
export type WatchCarryKind = (typeof WATCH_CARRY_KINDS)[number];

/**
 * ADR-114 C-02..C-07 — a carry's progress: `snapshot` (stored; nothing written yet), `cleared` (the items that would be
 * orphaned are cleared; the move may run), `refused` (the move did not run; the clears were put back), `waiting` (the
 * move ran; Plex has not shown every file on its new item yet, finish later), `verified` (carried, every account read
 * back clean), `mismatch` (carried, the read-back found an item that differs), `reverted` (`carry-revert` restored
 * every written item).
 */
export const WATCH_CARRY_STATUSES = ['snapshot', 'cleared', 'refused', 'waiting', 'verified', 'mismatch', 'reverted'] as const;
export type WatchCarryStatus = (typeof WATCH_CARRY_STATUSES)[number];

/** ADR-114 C-07 — when a mark was written: before the move, after it, or by `carry-revert`. */
export const WATCH_CARRY_PHASES = ['pre_clear', 'carry', 'revert'] as const;
export type WatchCarryPhase = (typeof WATCH_CARRY_PHASES)[number];

/**
 * ADR-114 C-04, C-05 — why: `pre_clear` (the item may lose its file, cleared before the move), `carried` (the
 * account's plays, and any resume point, put on the item that now plays the file), `partial` (only a resume point:
 * the account had not watched the whole file), `stale` (the account never played the file the item now holds, so its
 * mark there is cleared), `restore` (`carry-revert`).
 */
export const WATCH_CARRY_REASONS = ['pre_clear', 'carried', 'partial', 'stale', 'restore'] as const;
export type WatchCarryReason = (typeof WATCH_CARRY_REASONS)[number];

/** One account's state on one item: plays, resume point (ms), last watch (epoch seconds). */
export interface WatchCarryStateValue {
  viewCount: number;
  viewOffset: number;
  lastViewedAt: number | null;
}

/** One file an item plays (name for display; byte size is the content key). */
export interface WatchCarryPart {
  name: string;
  size: number;
}

/** One Plex item of the carry's scope, as read before anything moved. */
export interface WatchCarryItem {
  ratingKey: string;
  guid: string | null;
  title: string;
  season: number | null;
  episode: number | null;
  parts: WatchCarryPart[];
}

/**
 * ADR-114 / DESIGN-055 P4 decisions 26-34 (migration 0104) — a WATCH CARRY (T-326): one staff move's carry of every
 * account's Plex watch state onto the content it watched. BC-03. Written only by packages/domain/src/watch-carry.ts (the
 * no-direct-state-writes guard). `items` is the Carry Snapshot's item map (per server: the show's ratingKey and every
 * item of the scope with its files); `scope` names the content the move touches (byte sizes), a second copy's
 * equivalence and deleted files; `summary` holds per-account counts (by account index, never a name) and the
 * verification. No friend token is ever stored here (ADR-114 C-02).
 */
export const watchCarries = pgTable(
  'watch_carries',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    kind: text('kind').$type<WatchCarryKind>().notNull(),
    mediaItemId: uuid('media_item_id').references(() => mediaItems.id, { onDelete: 'set null' }),
    /** The Sonarr series id. */
    seriesId: integer('series_id').notNull(),
    /** The seasons in scope; empty = the whole show (an ordering switch). */
    seasonNumbers: integer('season_numbers').array().notNull().default(sql`'{}'::integer[]`),
    status: text('status').$type<WatchCarryStatus>().notNull(),
    /** When the snapshot was read: a view after it is a real new view and is never overwritten. */
    takenAt: timestamp('taken_at', { withTimezone: true }).notNull(),
    scope: jsonb('scope').$type<Record<string, unknown>>().notNull().default({}),
    items: jsonb('items').$type<Record<string, { showRatingKey: string; items: WatchCarryItem[] }>>().notNull().default({}),
    detail: jsonb('detail').$type<Record<string, unknown>>().notNull().default({}),
    summary: jsonb('summary').$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check('watch_carries_kind_enum', sql`${t.kind} = ANY (ARRAY[${sql.raw(sqlList(WATCH_CARRY_KINDS))}])`),
    check('watch_carries_status_enum', sql`${t.status} = ANY (ARRAY[${sql.raw(sqlList(WATCH_CARRY_STATUSES))}])`),
    index('watch_carries_item_idx').on(t.mediaItemId, t.createdAt.desc()),
  ],
);

/**
 * ADR-114 C-02 — the CARRY SNAPSHOT's states (T-327): one account's plays, resume point and last watch on one item of
 * the scope, read before anything moved, with the files that item played. Only items where the account has state get a
 * row. Immutable once written (inserted with the carry, never updated). `plex_account_id` is the plex.tv account id.
 */
export const watchCarryStates = pgTable(
  'watch_carry_states',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    carryId: uuid('carry_id')
      .notNull()
      .references(() => watchCarries.id, { onDelete: 'cascade' }),
    server: text('server').notNull(),
    plexAccountId: text('plex_account_id').notNull(),
    ratingKey: text('rating_key').notNull(),
    seasonNumber: integer('season_number'),
    episodeNumber: integer('episode_number'),
    parts: jsonb('parts').$type<WatchCarryPart[]>().notNull().default([]),
    viewCount: integer('view_count').notNull(),
    viewOffsetMs: integer('view_offset_ms').notNull(),
    lastViewedAt: timestamp('last_viewed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('watch_carry_states_uq').on(t.carryId, t.server, t.plexAccountId, t.ratingKey),
    check('watch_carry_states_has_state', sql`${t.viewCount} > 0 OR ${t.viewOffsetMs} > 0`),
  ],
);

/**
 * ADR-114 C-07 — the carry's audit: one APPEND-ONLY row per mark written for one account on one item (the state found
 * before, the state written, the Plex calls in order, the result), inserted in the same transaction as the carry's
 * counters. `carry-revert` restores `before_state` from these rows, newest first.
 */
export const watchCarryMarks = pgTable(
  'watch_carry_marks',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    carryId: uuid('carry_id')
      .notNull()
      .references(() => watchCarries.id, { onDelete: 'cascade' }),
    server: text('server').notNull(),
    plexAccountId: text('plex_account_id').notNull(),
    ratingKey: text('rating_key').notNull(),
    seasonNumber: integer('season_number'),
    episodeNumber: integer('episode_number'),
    phase: text('phase').$type<WatchCarryPhase>().notNull(),
    reason: text('reason').$type<WatchCarryReason>().notNull(),
    /** The files the item plays now (what the account is credited with, or not). */
    parts: jsonb('parts').$type<WatchCarryPart[]>().notNull().default([]),
    beforeState: jsonb('before_state').$type<WatchCarryStateValue>().notNull(),
    targetState: jsonb('target_state').$type<WatchCarryStateValue>().notNull(),
    /** The Plex calls sent, in order (`unscrobble`, `scrobble`, `progress`). */
    calls: text('calls').array().notNull().default(sql`'{}'::text[]`),
    ok: boolean('ok').notNull(),
    error: text('error'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check('watch_carry_marks_phase_enum', sql`${t.phase} = ANY (ARRAY[${sql.raw(sqlList(WATCH_CARRY_PHASES))}])`),
    check('watch_carry_marks_reason_enum', sql`${t.reason} = ANY (ARRAY[${sql.raw(sqlList(WATCH_CARRY_REASONS))}])`),
    index('watch_carry_marks_carry_idx').on(t.carryId, t.createdAt),
  ],
);

export type WatchCarryRow = typeof watchCarries.$inferSelect;
export type WatchCarryStateRow = typeof watchCarryStates.$inferSelect;
export type WatchCarryMarkRow = typeof watchCarryMarks.$inferSelect;
