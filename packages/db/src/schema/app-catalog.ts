import { pgTable, uuid, text, timestamp, integer, check } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

/**
 * DESIGN-001 D-05 — DB-backed, admin-editable app catalog (R-11).
 *
 * Stored URLs are always canonical `http(s)` URLs — the app normalizes every value
 * before it lands here (domain `normalizeCatalogUrl`). The URL CHECK is only a scheme
 * backstop; arbitrary hosts are allowed (ADR-013 — BRANCH-A, no host restrictions).
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
    // ADR-012: "default visible" is no longer a per-app flag — it is membership in the
    // seeded Default role's app set (role_app_grants). This column was dropped in 0007.
    sortOrder: integer('sort_order').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check('app_catalog_url_scheme', sql`${table.url} ~ '^https?://'`),
  ],
);

export type AppCatalogRow = typeof appCatalog.$inferSelect;
export type AppCatalogInsert = typeof appCatalog.$inferInsert;
