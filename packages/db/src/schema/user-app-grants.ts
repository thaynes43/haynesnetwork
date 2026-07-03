import { pgTable, uuid, timestamp, unique, index } from 'drizzle-orm/pg-core';
import { users } from './users';
import { appCatalog } from './app-catalog';

/**
 * DESIGN-001 D-06 — direct per-user app grants (R-15). Grant/revoke goes through the
 * packages/domain helpers that write the `grant_app`/`revoke_app` audit row in the same
 * transaction (D-12). Durable history lives in permission_audit.
 */
export const userAppGrants = pgTable(
  'user_app_grants',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    appId: uuid('app_id')
      .notNull()
      .references(() => appCatalog.id, { onDelete: 'cascade' }),
    grantedBy: uuid('granted_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique('user_app_grants_user_app_unique').on(table.userId, table.appId),
    index('user_app_grants_user_id_idx').on(table.userId),
  ],
);

export type UserAppGrantRow = typeof userAppGrants.$inferSelect;
export type UserAppGrantInsert = typeof userAppGrants.$inferInsert;
