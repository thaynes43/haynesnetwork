import { pgTable, uuid, text, timestamp, boolean } from 'drizzle-orm/pg-core';

/**
 * DESIGN-001 D-07 — tags: admin-editable permission bundles (R-20). A tag's bundle is
 * its tag_app_grants rows, its is_family flag, and (Phase 3) its library grants.
 */
export const tags = pgTable('tags', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull().unique(),
  description: text('description'),
  isFamily: boolean('is_family').notNull().default(false),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export type TagRow = typeof tags.$inferSelect;
export type TagInsert = typeof tags.$inferInsert;
