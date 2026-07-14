import { pgTable, uuid, text, jsonb, timestamp, check, unique, index } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { users } from './users';
import { INTEGRATION_PROVIDERS, INTEGRATION_STATUSES } from './enums';
import type { IntegrationProvider, IntegrationStatus } from './enums';

const PROVIDERS_SQL_LIST = INTEGRATION_PROVIDERS.map((p) => `'${p}'`).join(',');
const STATUSES_SQL_LIST = INTEGRATION_STATUSES.map((s) => `'${s}'`).join(',');

/**
 * ADR-055 / DESIGN-028 (PLAN-044 — Goodreads requests MVP) — one row per (app user, external provider).
 * The user LINKS an external account (v1: a PUBLIC Goodreads profile — no OAuth, no secret) and this row
 * stores the provider's stable user id + the profile ref + the link lifecycle + the last-sync marker.
 *
 * Single-writer (@hnet/domain user-integrations.ts, guard-listed): the USER-initiated link/unlink writes
 * a `permission_audit` row in the SAME transaction (CLAUDE.md hard rule 6 — link_integration /
 * unlink_integration actions). The sync-driven `last_synced_at` / `last_sync_error` bookkeeping is NOT
 * audited (the synced-content exemption, like books_items). Linking is PER-USER (R1).
 */
export const userIntegrations = pgTable(
  'user_integrations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** The app user who linked this integration. */
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** The external provider: 'goodreads' in v1. */
    provider: text('provider').$type<IntegrationProvider>().notNull(),
    /** The provider's stable user id — the numeric Goodreads user id parsed from the profile URL. */
    externalUserId: text('external_user_id').notNull(),
    /** The profile URL / reference the user entered (display + audit copy). Nullable. */
    profileRef: text('profile_ref'),
    /** Link lifecycle: 'linked' | 'unlinked' | 'error'. */
    status: text('status').$type<IntegrationStatus>().notNull(),
    /** The shelves this integration syncs (Goodreads shelf slugs). v1 default: the want shelf ['to-read']. */
    shelves: jsonb('shelves').$type<string[]>().notNull().default(['to-read']),
    /** Marker of the last SUCCESSFUL shelf sync. Null until the first sync lands. */
    lastSyncedAt: timestamp('last_synced_at', { withTimezone: true }),
    /** The last sync's error message (human-readable) when status = 'error'; cleared on a clean sync. */
    lastSyncError: text('last_sync_error'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check('user_integrations_provider_enum', sql`${t.provider} = ANY (ARRAY[${sql.raw(PROVIDERS_SQL_LIST)}])`),
    check('user_integrations_status_enum', sql`${t.status} = ANY (ARRAY[${sql.raw(STATUSES_SQL_LIST)}])`),
    // One row per (user, provider) — re-linking updates in place (and flips 'unlinked' → 'linked').
    unique('user_integrations_user_provider_unique').on(t.userId, t.provider),
    // The goodreads-sync mode lists LINKED integrations to poll.
    index('user_integrations_provider_status_idx').on(t.provider, t.status),
  ],
);

export type UserIntegrationRow = typeof userIntegrations.$inferSelect;
export type UserIntegrationInsert = typeof userIntegrations.$inferInsert;
