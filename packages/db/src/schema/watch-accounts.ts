import {
  pgTable,
  bigint,
  text,
  uuid,
  boolean,
  timestamp,
  check,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { users } from './users';
import { WATCH_ACCOUNT_ROLES, type WatchAccountRole } from './enums';

const ROLES_SQL_LIST = WATCH_ACCOUNT_ROLES.map((r) => `'${r}'`).join(',');

/**
 * ADR-088 / DESIGN-049 D-07 (PLAN-068) — the tracked Plex accounts of the Watch Companion (BC-06).
 *
 * Keyed by the plex.tv NUMERIC account id, which is also Tautulli's history `user_id` (the owner is
 * 12874060) — so events from all three Tautulli instances join to one account without a mapping table.
 * `getOwnerAccount()` returns the id as a string; it is stored as bigint (D-03).
 *
 * v1 tracks exactly ONE row, role `owner`: the ADR-029 Server Owner, upserted by the `watch` sync. The
 * partial unique index `watch_accounts_one_owner` makes "one owner" a SCHEMA invariant, because the MCP
 * surface resolves its principal as THE owner row and no tool accepts an account id (D-03) — a second
 * owner row must be impossible, not merely unwritten. `app_user_id` links the app user whose email is the
 * owner's, for attribution only.
 *
 * Written ONLY by the @hnet/domain watch single-writers (guard-listed). **Writers NEVER delete a row:** an
 * owner change is an UPDATE (the old owner's `role` moves off `owner`, `username` follows plex.tv), and
 * `tracked = false` stops a household account's ingest without dropping its history (PRD Q-12 later). The
 * schema backs this up: watch_marks (the owner's corrections and the undo record — not rebuildable,
 * OPS-015 §7) reference this row ON DELETE RESTRICT, so a delete of an account with marks fails; the
 * rebuildable watch_events / watch_titles / watch_reco_signals cascade.
 */
export const watchAccounts = pgTable(
  'watch_accounts',
  {
    /** plex.tv numeric account id = Tautulli `user_id`. */
    plexAccountId: bigint('plex_account_id', { mode: 'number' }).primaryKey(),
    username: text('username').notNull(),
    role: text('role').$type<WatchAccountRole>().notNull(),
    /** The app user with the owner's email (attribution); null when no such user has logged in yet. */
    appUserId: uuid('app_user_id').references(() => users.id, { onDelete: 'set null' }),
    tracked: boolean('tracked').notNull().default(true),
    /** When the account was last confirmed against plex.tv (the owner) or Tautulli (a household row). */
    resolvedAt: timestamp('resolved_at', { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check('watch_accounts_role_enum', sql`${t.role} = ANY (ARRAY[${sql.raw(ROLES_SQL_LIST)}])`),
    /** DESIGN-049 D-03: at most one `owner` — the principal every MCP tool answers for. */
    uniqueIndex('watch_accounts_one_owner')
      .on(t.role)
      .where(sql`role = 'owner'`),
  ],
);

export type WatchAccountRow = typeof watchAccounts.$inferSelect;
export type WatchAccountInsert = typeof watchAccounts.$inferInsert;
