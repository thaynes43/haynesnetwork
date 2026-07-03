import { pgTable, uuid, timestamp, unique } from 'drizzle-orm/pg-core';
import { tags } from './tags';
import { appCatalog } from './app-catalog';

/**
 * DESIGN-001 D-08 — apps bundled into a tag (R-20). Editing a tag's bundle audits as
 * `update_tag` with the delta in permission_audit.detail.
 */
export const tagAppGrants = pgTable(
  'tag_app_grants',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tagId: uuid('tag_id')
      .notNull()
      .references(() => tags.id, { onDelete: 'cascade' }),
    appId: uuid('app_id')
      .notNull()
      .references(() => appCatalog.id, { onDelete: 'cascade' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [unique('tag_app_grants_tag_app_unique').on(table.tagId, table.appId)],
);

export type TagAppGrantRow = typeof tagAppGrants.$inferSelect;
export type TagAppGrantInsert = typeof tagAppGrants.$inferInsert;
