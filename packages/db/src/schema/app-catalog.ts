import { pgTable, uuid, text, timestamp, boolean, integer, check } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

/**
 * DESIGN-001 D-05 — DB-backed, admin-editable app catalog (R-11, R-14).
 *
 * The URL CHECK is the DB-level enforcement of R-14 (never link users to
 * `*.haynesops.com` — CLAUDE.md rule 3). The regex is end-anchored with `(/.*)?$` so
 * `https://evil.haynesnetwork.com.attacker.io` is rejected: the hostname must END in
 * `.haynesnetwork.com`, optionally followed by a path.
 */
export const appCatalog = pgTable(
  'app_catalog',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    slug: text('slug').notNull().unique(),
    name: text('name').notNull(),
    description: text('description'),
    url: text('url').notNull(),
    icon: text('icon'),
    defaultVisible: boolean('default_visible').notNull().default(false),
    sortOrder: integer('sort_order').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check(
      'app_catalog_url_haynesnetwork_only',
      sql`${table.url} ~ '^https://[a-z0-9.-]+\\.haynesnetwork\\.com(/.*)?$'`,
    ),
  ],
);

export type AppCatalogRow = typeof appCatalog.$inferSelect;
export type AppCatalogInsert = typeof appCatalog.$inferInsert;
