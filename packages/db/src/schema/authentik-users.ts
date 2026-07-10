import { pgTable, integer, text, boolean, jsonb, timestamp, index, check } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { AUTHENTIK_USER_TYPES, type AuthentikUserType } from './enums';

const USER_TYPES_SQL_LIST = AUTHENTIK_USER_TYPES.map((t) => `'${t}'`).join(',');

/**
 * ADR-045 / DESIGN-023 (PLAN-026 — Authentik role portal) — the synced MIRROR of the Authentik user
 * directory: one row per Authentik identity (INCLUDING external / Plex-source accounts and people who
 * have never logged into haynesnetwork). This is the substrate `/admin/users` renders so the portal can
 * manage EVERY Authentik user, not just the app-known ones. Keyed by the Authentik user `pk` (stable
 * integer), NOT by email.
 *
 * Derived, rebuildable READ-MODEL (the ADR-035 `trash_candidates` / ADR-040 `smart_drive_state` /
 * ADR-044 `ai_usage_chats` class): the directory of record lives in Authentik; this table is a
 * re-syncable copy. Populated ONLY by the @hnet/domain `upsertAuthentikUsers` single-writer
 * (guard-listed) — from the `authentik-users` sync mode (cadence) AND from an on-demand admin refresh AND
 * from a targeted re-read after a portal membership write. No per-row audit event — synced directory
 * data, not a role/permission mutation (the documented no-ledger-row exemption).
 */
export const authentikUsers = pgTable(
  'authentik_users',
  {
    /** The Authentik user `pk` (integer) — the natural upsert key; stable across re-syncs. */
    pk: integer('pk').primaryKey(),
    username: text('username').notNull(),
    /** Authentik `name` (display name); may be empty. */
    name: text('name').notNull().default(''),
    /** May be null/empty for some external identities. Stored verbatim (not lowercased). */
    email: text('email'),
    /** external | internal | internal_service_account (CHECK-constrained to AUTHENTIK_USER_TYPES). */
    userType: text('user_type').$type<AuthentikUserType>().notNull(),
    /** Source names from `attributes.goauthentik.io/user/sources` (e.g. ["HaynesTower"] for Plex). */
    sources: jsonb('sources').$type<string[]>().notNull().default([]),
    /** The Authentik group NAMES this identity currently belongs to (from `groups_obj`). */
    groups: jsonb('groups').$type<string[]>().notNull().default([]),
    isActive: boolean('is_active').notNull().default(true),
    /** The goauthentik.io uid hash (reference only — the OIDC `sub` is a per-provider hash, not this). */
    uid: text('uid'),
    /** When this row was last refreshed from Authentik (freshness footnote on the roster). */
    syncedAt: timestamp('synced_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check(
      'authentik_users_type_enum',
      sql`${t.userType} = ANY (ARRAY[${sql.raw(USER_TYPES_SQL_LIST)}])`,
    ),
    // /admin/users joins the mirror to app users by email (case-insensitive) — index the lowered email.
    index('authentik_users_email_idx').on(sql`lower(${t.email})`),
  ],
);

export type AuthentikUserRow = typeof authentikUsers.$inferSelect;
export type AuthentikUserInsert = typeof authentikUsers.$inferInsert;
