import { pgTable, uuid, text, timestamp, jsonb, index, check } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { users } from './users';
import { plexLibraries } from './plex-libraries';
import { PLEX_SHARE_EVENTS, type PlexShareEvent } from './enums';

const EVENTS_SQL_LIST = PLEX_SHARE_EVENTS.map((e) => `'${e}'`).join(',');

/**
 * ADR-017 / DESIGN-007 D-01 — Plex share ledger (BC-04 owns its own audit, like the BC-03
 * media aggregates — this is NOT permission_audit; DESIGN-005 D-12 note). Append-only; one
 * row per applied share/unshare, written by the plex-shares single-writers in the SAME
 * transaction as the role-gate re-derivation (the Plex write runs after the audit row is on
 * the wire — ADR-017 read-merge-write invariant). Referential columns SET NULL on delete so
 * the ledger outlives the subject; `detail` jsonb carries a denormalized snapshot (server
 * slug, library name, sections preserved, whether the actor was the user or an admin).
 */
export const plexShareAudit = pgTable(
  'plex_share_audit',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id').references(() => users.id, { onDelete: 'set null' }),
    plexLibraryId: uuid('plex_library_id').references(() => plexLibraries.id, {
      onDelete: 'set null',
    }),
    event: text('event').$type<PlexShareEvent>().notNull(),
    // Who initiated: the user themselves (self-service) or an admin acting for them. NULL
    // for a system/automated actor. SET NULL keeps the row when the actor is deleted.
    actorId: uuid('actor_id').references(() => users.id, { onDelete: 'set null' }),
    detail: jsonb('detail'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check(
      'plex_share_audit_event_enum',
      sql`${table.event} = ANY (ARRAY[${sql.raw(EVENTS_SQL_LIST)}])`,
    ),
    index('plex_share_audit_created_idx').on(table.createdAt.desc()),
    index('plex_share_audit_user_created_idx').on(table.userId, table.createdAt.desc()),
  ],
);

export type PlexShareAuditRow = typeof plexShareAudit.$inferSelect;
export type PlexShareAuditInsert = typeof plexShareAudit.$inferInsert;
