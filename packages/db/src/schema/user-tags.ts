import { pgTable, uuid, timestamp, unique, index } from 'drizzle-orm/pg-core';
import { users } from './users';
import { tags } from './tags';

/**
 * DESIGN-001 D-09 — tag applications (R-21). Applying a tag never copies rows into
 * user_app_grants — tag permissions are derived at read time (D-11), so removing a tag
 * removes exactly the tag-derived permissions (AC-06).
 */
export const userTags = pgTable(
  'user_tags',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    tagId: uuid('tag_id')
      .notNull()
      .references(() => tags.id, { onDelete: 'cascade' }),
    appliedBy: uuid('applied_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique('user_tags_user_tag_unique').on(table.userId, table.tagId),
    index('user_tags_user_id_idx').on(table.userId),
  ],
);

export type UserTagRow = typeof userTags.$inferSelect;
export type UserTagInsert = typeof userTags.$inferInsert;
