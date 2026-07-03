import { pgTable, uuid, text, timestamp, unique, index } from 'drizzle-orm/pg-core';
import { users } from './users';

/**
 * DESIGN-001 D-03 — Better Auth account table (provider linkage; provider_id is always
 * 'authentik' in Phase 1, account_id carries the OIDC `sub`). `password` is always NULL
 * but kept because Better Auth's base account model includes it.
 */
export const account = pgTable(
  'account',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    providerId: text('provider_id').notNull(),
    accountId: text('account_id').notNull(),
    accessToken: text('access_token'),
    refreshToken: text('refresh_token'),
    idToken: text('id_token'),
    accessTokenExpiresAt: timestamp('access_token_expires_at', { withTimezone: true }),
    refreshTokenExpiresAt: timestamp('refresh_token_expires_at', { withTimezone: true }),
    scope: text('scope'),
    password: text('password'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique('account_provider_account_unique').on(table.providerId, table.accountId),
    index('account_user_id_idx').on(table.userId),
  ],
);

export type AccountRow = typeof account.$inferSelect;
export type AccountInsert = typeof account.$inferInsert;
