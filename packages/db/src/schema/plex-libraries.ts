import { pgTable, uuid, text, timestamp, boolean, check, uniqueIndex } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { plexServers } from './plex-servers';
import { PLEX_MEDIA_TYPES, type PlexMediaType } from './enums';

const MEDIA_TYPES_SQL_LIST = PLEX_MEDIA_TYPES.map((t) => `'${t}'`).join(',');

/**
 * ADR-017 / DESIGN-007 D-01 — the Plex library registry (BC-04). Identity is
 * `(server_id, section_key)`, NEVER the name (Q-03 resolved): HAYNESOPS mirrors
 * HAYNESTOWER's Movies/TV under different names (`HOps Movies` vs `HNet Movies`), and
 * `section_key` is a small integer scoped per server, so the composite unique is required.
 * There is deliberately NO `is_family_only` column — family gating is a Role grant
 * (ADR-017 D-08/D-10): the two HAYNESTOWER family libraries are ordinary rows granted only
 * to the Family role. Rows are upserted by the admin registry refresh and never hard-deleted;
 * a library that vanishes from `GET /library/sections` is marked `available = false`.
 */
export const plexLibraries = pgTable(
  'plex_libraries',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    serverId: uuid('server_id')
      .notNull()
      .references(() => plexServers.id, { onDelete: 'cascade' }),
    // The Plex section key (`GET /library/sections` → Directory.key), a per-server integer
    // stored as text. Identity, together with server_id.
    sectionKey: text('section_key').notNull(),
    name: text('name').notNull(),
    mediaType: text('media_type').$type<PlexMediaType>().notNull(),
    // Soft-state: a refresh that no longer sees this section flips this false rather than
    // deleting the row (keeps role_library_grants + audit history intact — ADR-017 D-04).
    available: boolean('available').notNull().default(true),
    syncedAt: timestamp('synced_at', { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check(
      'plex_libraries_media_type_enum',
      sql`${table.mediaType} = ANY (ARRAY[${sql.raw(MEDIA_TYPES_SQL_LIST)}])`,
    ),
    uniqueIndex('plex_libraries_server_section_idx').on(table.serverId, table.sectionKey),
  ],
);

export type PlexLibraryRow = typeof plexLibraries.$inferSelect;
export type PlexLibraryInsert = typeof plexLibraries.$inferInsert;
