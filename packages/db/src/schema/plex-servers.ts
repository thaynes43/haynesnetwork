import { pgTable, uuid, text, timestamp, check } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { PLEX_SERVER_SLUGS, type PlexServerSlug } from './enums';

const SLUGS_SQL_LIST = PLEX_SERVER_SLUGS.map((s) => `'${s}'`).join(',');

/**
 * Fixed ids for the three Plex servers of record (OPS-002 / ADR-017). Fixed (not random)
 * so seeds, the registry refresh, and role_library_grants are deterministic across a
 * fresh DB and the e2e/dev:local seed. The servers ARE infrastructure facts (their machine
 * identifiers are stable), so migration 0010 seeds these rows; libraries arrive by refresh.
 */
export const SEEDED_PLEX_SERVER_IDS = {
  haynestower: 'a5ec8cb2-0000-4000-8000-000000000001',
  haynesops: '80b33acb-0000-4000-8000-000000000002',
  hayneskube: 'c1b23d68-0000-4000-8000-000000000003',
} as const satisfies Record<PlexServerSlug, string>;

/**
 * ADR-017 / DESIGN-007 D-01 — the Plex server registry (BC-04). One row per server; the
 * three are seeded and CHECK-constrained to the canonical slugs. `machine_identifier` is the
 * Plex server GUID the plex.tv sharing API keys on; `token_ref` names the env var / 1Password
 * field carrying the owner token (CLAUDE.md rule 7 — the reference NAME, NEVER the token).
 * `base_url` is a server-side in-cluster URL and is EXEMPT from the R-14/ADR-013 arbitrary
 * http(s) catalog rule (it is backend config, never a user-facing catalog link).
 */
export const plexServers = pgTable(
  'plex_servers',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    slug: text('slug').$type<PlexServerSlug>().notNull().unique(),
    name: text('name').notNull(),
    // Server-side in-cluster base URL (EXEMPT from the catalog http(s) rule — backend only).
    baseUrl: text('base_url').notNull(),
    machineIdentifier: text('machine_identifier').notNull(),
    // 1Password/env REFERENCE NAME (e.g. 'PLEX_HAYNESTOWER_TOKEN'), never the token itself.
    tokenRef: text('token_ref').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check('plex_servers_slug_enum', sql`${table.slug} = ANY (ARRAY[${sql.raw(SLUGS_SQL_LIST)}])`),
  ],
);

export type PlexServerRow = typeof plexServers.$inferSelect;
export type PlexServerInsert = typeof plexServers.$inferInsert;
